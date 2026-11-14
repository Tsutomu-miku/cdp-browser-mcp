import { randomUUID } from "node:crypto";
import type { BrowserBackend } from "./backend.js";
import {
  normalizeHeaders,
  fingerprint,
  idSchema,
  type Config,
} from "./config.js";
import { NativeBridge } from "./native-bridge.js";
import type { Log } from "./runtime.js";

interface ExtensionTab {
  tabId: string;
  chromeTabId: number;
  agentId: string;
  lane: string;
  headers: Record<string, string>;
  expiresAt: number;
  busy: boolean;
  attached: boolean;
  url: string;
}

/** Leases refer to Chrome tab IDs; never owns or launches the browser/profile. */
export class ExtensionBackend implements BrowserBackend {
  readonly bridge: NativeBridge;
  private tabs = new Map<string, ExtensionTab>();
  private timer?: NodeJS.Timeout;
  private sweeping = false;
  private stopped = false;
  constructor(
    readonly config: Config,
    readonly log: Log,
  ) {
    this.bridge = new NativeBridge(config, log, () => this.restore());
  }
  async start() {
    await this.bridge.start();
    this.timer = setInterval(() => {
      if (!this.sweeping && this.bridge.ready) {
        this.sweeping = true;
        void this.sweep()
          .catch((error) =>
            this.log("extension.health-error", { error: String(error) }),
          )
          .finally(() => {
            this.sweeping = false;
          });
      }
    }, 2000);
  }
  private async restore() {
    const live = (await this.bridge.call("tabs", {}, true)) as {
      id: number;
      url?: string;
    }[];
    const ids = new Set(live.map((t) => t.id));
    for (const tab of this.tabs.values()) {
      if (
        !tab.busy &&
        (!ids.has(tab.chromeTabId) || tab.expiresAt < Date.now())
      )
        this.tabs.delete(tab.tabId);
    }
    await this.bridge.call(
      "sync",
      {
        tabs: [...this.tabs.values()]
          .filter((t) => t.chromeTabId >= 0)
          .map((t) => ({ tabId: t.chromeTabId, headers: t.headers })),
      },
      true,
    );
    await this.bridge.call("health", {}, true);
    this.log("extension.restored", { tabs: this.tabs.size });
  }
  health() {
    return {
      backend: "extension",
      ready: this.bridge.ready && !this.stopped,
      connected: this.bridge.ready,
      mode: "existing-profile",
      tabs: this.tabs.size,
      hostPid: this.bridge.hostPid,
      generation: this.bridge.generation,
      workerPolicy: "tab-scoped-only-background-unmodified",
      isolation: "single-lane-use-cdp-for-parallel-lanes",
    };
  }
  private describe(t: ExtensionTab) {
    return {
      tabId: t.tabId,
      chromeTabId: t.chromeTabId,
      agentId: t.agentId,
      lane: t.lane,
      headerHash: fingerprint(t.headers),
      expiresAt: t.expiresAt,
      busy: t.busy,
      attached: t.attached,
      url: t.url,
    };
  }
  list(agentId?: string) {
    return [...this.tabs.values()]
      .filter((t) => !agentId || t.agentId === agentId)
      .map((t) => this.describe(t));
  }
  async available() {
    return this.bridge.call("tabs");
  }
  private owned(agentId: string, tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.agentId !== agentId)
      throw Error("Tab is absent or belongs to another agent");
    return tab;
  }
  private headers(lane: string, extra: Record<string, string>) {
    if (!Object.hasOwn(this.config.lanes, lane))
      throw Error(`Unknown lane: ${lane}`);
    return normalizeHeaders({ ...this.config.lanes[lane], ...extra });
  }
  private async acquire(
    agentId: string,
    lane: string,
    extra: Record<string, string>,
    chromeTabId?: number,
  ) {
    await this.bridge.waitReady();
    idSchema.parse(agentId);
    const headers = this.headers(lane, extra);
    if (this.tabs.size >= this.config.maxTabs)
      throw Error("Tab capacity reached");
    if (
      chromeTabId !== undefined &&
      [...this.tabs.values()].some((t) => t.chromeTabId === chromeTabId)
    )
      throw Error("Chrome tab already has a lease");
    // Reserve before asynchronous I/O so concurrent attachments cannot race.
    const t: ExtensionTab = {
      tabId: randomUUID(),
      chromeTabId: chromeTabId ?? -1,
      agentId,
      lane,
      headers,
      expiresAt: Date.now() + this.config.leaseMs,
      busy: true,
      attached: chromeTabId !== undefined,
      url: "about:blank",
    };
    this.tabs.set(t.tabId, t);
    try {
      const live = await this.bridge.call(
        chromeTabId === undefined ? "create" : "get",
        chromeTabId === undefined ? {} : { tabId: chromeTabId },
      );
      t.chromeTabId = live.id;
      t.url = live.url || "";
      await this.bridge.call("headers", { tabId: t.chromeTabId, headers });
      t.busy = false;
      return this.describe(t);
    } catch (error) {
      this.tabs.delete(t.tabId);
      // Only remove a confirmed tool-created tab; never close an attached user tab.
      if (t.chromeTabId !== -1 && this.bridge.ready && !t.attached)
        await this.bridge.call("remove", { tabId: t.chromeTabId });
      throw error;
    }
  }
  open(agentId: string, lane: string, headers: Record<string, string> = {}) {
    return this.acquire(agentId, lane, headers);
  }
  attach(
    agentId: string,
    chromeTabId: number,
    lane: string,
    headers: Record<string, string>,
  ) {
    return this.acquire(agentId, lane, headers, chromeTabId);
  }
  renew(agentId: string, tabId: string) {
    const t = this.owned(agentId, tabId);
    t.expiresAt = Date.now() + this.config.leaseMs;
    return this.describe(t);
  }
  async setHeaders(
    agentId: string,
    tabId: string,
    headers: Record<string, string>,
  ) {
    const t = this.owned(agentId, tabId);
    if (t.busy) throw Error("This tab already has an operation in progress");
    const normalized = normalizeHeaders(headers);
    t.busy = true;
    try {
      await this.bridge.call("headers", {
        tabId: t.chromeTabId,
        headers: normalized,
      });
      t.headers = normalized;
    } finally {
      t.busy = false;
      t.expiresAt = Date.now() + this.config.leaseMs;
    }
    return this.describe(t);
  }

  async closeTab(agentId: string, tabId: string) {
    const t = this.owned(agentId, tabId);
    if (t.busy) throw Error("This tab already has an operation in progress");
    t.busy = true;
    try {
      await this.bridge.call("remove", { tabId: t.chromeTabId });
      this.tabs.delete(tabId);
      return { closed: tabId };
    } finally {
      t.busy = false;
    }
  }
  private async release(t: ExtensionTab) {
    await this.bridge.call(t.attached ? "headers" : "remove", {
      tabId: t.chromeTabId,
      headers: {},
    });
    this.tabs.delete(t.tabId);
  }
  async closeAgent(agentId: string) {
    for (const t of [...this.tabs.values()])
      if (t.agentId === agentId) await this.release(t);
  }
  async action(
    agentId: string,
    tabId: string,
    action: string,
    args: Record<string, unknown>,
  ) {
    const t = this.owned(agentId, tabId);
    if (t.busy) throw Error("This tab already has an operation in progress");
    t.busy = true;
    t.expiresAt = Date.now() + this.config.leaseMs;
    try {
      const result = await this.bridge.call("action", {
        tabId: t.chromeTabId,
        action,
        args,
      });
      if (typeof result.url === "string") t.url = result.url;
      return result;
    } finally {
      t.busy = false;
      t.expiresAt = Date.now() + this.config.leaseMs;
    }
  }
  private async sweep() {
    const live = (await this.bridge.call("tabs")) as {
      id: number;
      url?: string;
    }[];
    for (const t of [...this.tabs.values()]) {
      const tab = live.find((v) => v.id === t.chromeTabId);
      // The live snapshot may predate an in-flight create/get. Its reservation
      // remains owned until acquire resolves; never delete a busy reservation.
      if (!tab && !t.busy) this.tabs.delete(t.tabId);
      else if (tab) {
        t.url = tab.url || "";
        if (!t.busy && t.expiresAt < Date.now()) await this.release(t);
      }
    }
    await this.bridge.call("health");
  }
  async recover() {
    await this.bridge.waitReady();
    await this.restore();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    try {
      if (this.bridge.ready)
        for (const t of [...this.tabs.values()]) await this.release(t);
    } finally {
      await this.bridge.stop();
    }
  }
}

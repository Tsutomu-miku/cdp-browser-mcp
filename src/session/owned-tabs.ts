import { randomUUID, createHash } from "node:crypto";
import { idSchema, normalizeHeaders, type Config } from "../config.js";
import type { Log } from "../runtime.js";
import type { CdpConnection, CdpSession } from "../cdp.js";
import type { Downloads } from "../downloads.js";
import type { TabPolicy } from "../headers.js";
import type { Devtools } from "../devtools.js";
export interface Tab {
  tabId: string;
  agentId: string;
  lane: string;
  headers: Record<string, string>;
  targetId: string;
  pageId: number;
  session: CdpSession;
  url: string;
  expiresAt: number;
  busy: boolean;
}
export const fingerprint = (h: Record<string, string>) =>
  createHash("sha256").update(JSON.stringify(h)).digest("hex").slice(0, 16);
interface TabServices {
  readonly config: Config;
  readonly log: Log;
  readonly browser?: Pick<CdpConnection, "send" | "attach">;
  readonly downloads?: Pick<Downloads, "forget">;
  readonly policy?: Pick<TabPolicy, "watch">;
  readonly devtools?: Pick<Devtools, "pageId" | "call" | "action">;
}
export class OwnedTabs {
  readonly tabs = new Map<string, Tab>();
  openings = 0;
  private traceOwner?: string;
  private traceBusy = false;
  constructor(
    private readonly host: TabServices,
    private readonly requireReady: () => void,
    private readonly guardDisk: () => Promise<unknown>,
    private readonly afterAction: () => Promise<void>,
    private readonly diagnosticNames: readonly string[],
  ) {}
  reset() {
    this.tabs.clear();
    this.traceOwner = undefined;
    this.traceBusy = false;
  }
  async open(
    agentId: string,
    lane: string,
    extra: Record<string, string> = {},
  ) {
    this.requireReady();
    idSchema.parse(agentId);
    if (!Object.hasOwn(this.host.config.lanes, lane))
      throw Error(`Unknown lane: ${lane}`);
    if (this.tabs.size + this.openings >= this.host.config.maxTabs)
      throw Error("Tab capacity reached");
    const headers = normalizeHeaders({
      ...this.host.config.lanes[lane],
      ...extra,
    });
    if (Object.keys(headers).length && !this.host.config.headerDomains.length)
      throw Error(
        "Lane headers require an explicit headerDomains allowlist (or --header-domains)",
      );
    this.openings++;
    try {
      await this.guardDisk();
      const tabId = randomUUID(),
        url = `about:blank#${tabId}`;
      const { targetId } = await this.host.browser!.send(
        "Target.createTarget",
        {
          url,
        },
      );
      try {
        const session = await this.host.browser!.attach(targetId);
        const tab: Tab = {
          tabId,
          agentId,
          lane,
          headers,
          targetId,
          session,
          url,
          pageId: 0,
          expiresAt: Date.now() + this.host.config.leaseMs,
          busy: false,
        };
        await this.host.policy!.watch(session, "page", tab, url);
        tab.pageId = await this.host.devtools!.pageId(url);
        this.tabs.set(tabId, tab);
        this.host.log("tab.opened", {
          agentId,
          tabId,
          pageId: tab.pageId,
          lane,
          headerHash: fingerprint(headers),
        });
        return this.describe(tab);
      } catch (e) {
        await this.host.browser!.send("Target.closeTarget", { targetId });
        throw e;
      }
    } finally {
      this.openings--;
    }
  }
  private describe(t: Tab) {
    return {
      tabId: t.tabId,
      pageId: t.pageId,
      agentId: t.agentId,
      lane: t.lane,
      headerHash: fingerprint(t.headers),
      expiresAt: t.expiresAt,
      url: t.url,
      busy: t.busy,
    };
  }
  list(agentId?: string) {
    return [...this.tabs.values()]
      .filter((t) => !agentId || t.agentId === agentId)
      .map((t) => this.describe(t));
  }
  private owned(agentId: string, tabId: string) {
    const t = this.tabs.get(tabId);
    if (!t || t.agentId !== agentId)
      throw Error("Tab is absent or belongs to another agent");
    return t;
  }
  async release(tabId: string, close = true) {
    const t = this.tabs.get(tabId);
    if (!t) return;
    this.tabs.delete(tabId);
    await this.host.downloads!.forget(tabId);
    if (close)
      await this.host.browser!.send("Target.closeTarget", {
        targetId: t.targetId,
      });
    this.host.log("tab.released", { agentId: t.agentId, tabId, lane: t.lane });
  }
  async closeTab(agentId: string, tabId: string) {
    this.owned(agentId, tabId);
    await this.release(tabId);
    return { closed: tabId };
  }
  renew(agentId: string, tabId: string) {
    const t = this.owned(agentId, tabId);
    t.expiresAt = Date.now() + this.host.config.leaseMs;
    return this.describe(t);
  }
  async closeAgent(agentId: string) {
    for (const t of [...this.tabs.values()])
      if (t.agentId === agentId) await this.release(t.tabId);
  }
  async action(
    agentId: string,
    tabId: string,
    method: string,
    args: Record<string, unknown> = {},
  ) {
    this.requireReady();
    const t = this.owned(agentId, tabId);
    if (t.busy) throw Error("This tab already has an operation in progress");
    t.busy = true;
    t.expiresAt = Date.now() + this.host.config.leaseMs;
    try {
      if (method === "devtools") {
        const name = String(args.name);
        if (!this.diagnosticNames.includes(name))
          throw Error("Only owned-page diagnostics are exposed");
        const params = args.arguments as Record<string, unknown>;
        if (Object.hasOwn(params, "pageId"))
          throw Error("pageId is assigned by tab ownership");
        if (
          name === "performance_analyze_insight" &&
          (this.traceOwner !== t.tabId || this.traceBusy)
        )
          throw Error(
            "The latest completed trace belongs to another tab or is still recording",
          );
        const records = [
          "performance_start_trace",
          "lighthouse_audit",
        ].includes(name);
        if (name === "performance_start_trace" && params.autoStop === false)
          throw Error("Shared-browser traces require autoStop=true");
        if (records && this.traceBusy)
          throw Error("A browser-wide diagnostic is already recording");
        if (records) {
          this.traceBusy = true;
          this.traceOwner = undefined;
        }
        try {
          const result = await this.host.devtools!.call(
            name,
            { ...params, pageId: t.pageId },
            80000,
          );
          if (name === "performance_start_trace") this.traceOwner = t.tabId;
          return result;
        } finally {
          if (records) this.traceBusy = false;
        }
      }
      return await this.host.devtools!.action(t.pageId, method, args);
    } finally {
      t.busy = false;
      t.expiresAt = Date.now() + this.host.config.leaseMs;
      await this.afterAction();
    }
  }
  async expire() {
    for (const t of [...this.tabs.values()])
      if (!t.busy && t.expiresAt < Date.now()) await this.release(t.tabId);
  }
}

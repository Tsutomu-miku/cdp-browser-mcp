import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import {
  configSchema,
  idSchema,
  normalizeHeaders,
  type Config,
} from "./config.js";
import { ChromeProcess, guardDisk, type Log } from "./runtime.js";
import { CdpConnection, CdpClosedError, type CdpSession } from "./cdp.js";
import { Downloads } from "./downloads.js";
import { TabPolicy } from "./headers.js";
import { Devtools, diagnosticNames } from "./devtools.js";
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
export class Steward {
  readonly tabs = new Map<string, Tab>();
  readonly chrome: ChromeProcess;
  browser?: CdpConnection;
  downloads?: Downloads;
  policy?: TabPolicy;
  devtools?: Devtools;
  private cookies: Record<string, unknown>[] = [];
  private anchor?: string;
  private timer?: NodeJS.Timeout;
  private recovering?: Promise<void>;
  private stopping = false;
  private ready = false;
  private diskError?: string;
  private sweeping = false;
  private openings = 0;
  private traceOwner?: string;
  private traceBusy = false;
  constructor(
    readonly config: Config,
    readonly log: Log,
  ) {
    configSchema.parse(config);
    this.chrome = new ChromeProcess(config, log);
  }
  private fatal = (e: unknown) => {
    this.log("connection.failed", { error: String(e) });
    this.ready = false;
    if (!this.stopping)
      void this.recover().catch((error) =>
        this.log("reconnect.failed", { error: String(error) }),
      );
  };
  async start() {
    try {
      await this.connect();
    } catch (e) {
      await this.stop();
      throw e;
    }
    this.timer = setInterval(() => {
      if (!this.sweeping) {
        this.sweeping = true;
        void this.sweep()
          .catch((e) => this.log("health.error", { error: String(e) }))
          .finally(() => {
            this.sweeping = false;
          });
      }
    }, 1000);
  }
  private async connect() {
    const endpoint = await this.chrome.start();
    const browser = (this.browser = await CdpConnection.connect(endpoint));
    browser.once("disconnected", () => {
      if (!this.stopping) this.fatal(Error("Orchestrator CDP disconnected"));
    });
    const command = await browser.send("Browser.getBrowserCommandLine");
    if (
      !command.arguments.includes(
        `--user-data-dir=${join(this.config.stateDir, "profile")}`,
      ) ||
      !command.arguments.includes("--disable-shared-workers")
    )
      throw Error("CDP target is not the dedicated steward Chrome");
    await browser.send("Target.setDiscoverTargets", { discover: true });
    const { targetInfos } = await browser.send("Target.getTargets");
    if (
      targetInfos.some(
        (t: any) =>
          t.type === "service_worker" && !t.url.startsWith("chrome-extension:"),
      )
    )
      throw Error(
        "Existing web service workers are forbidden; use a clean steward profile",
      );
    const pages = targetInfos.filter((t: any) => t.type === "page");
    this.anchor = pages.find((t: any) => t.url === "about:blank")?.targetId;
    if (!this.anchor)
      this.anchor = (
        await browser.send("Target.createTarget", { url: "about:blank" })
      ).targetId;
    for (const page of pages)
      if (page.targetId !== this.anchor)
        await browser.send("Target.closeTarget", { targetId: page.targetId });
    browser.on("Target.targetInfoChanged", ({ targetInfo }) => {
      const tab = [...this.tabs.values()].find(
        (t) => t.targetId === targetInfo.targetId,
      );
      if (tab) tab.url = targetInfo.url;
    });
    browser.on("Target.targetDestroyed", ({ targetId }) => {
      if (targetId === this.anchor && this.ready && !this.stopping)
        this.fatal(Error("Anchor closed"));
      const tab = [...this.tabs.values()].find((t) => t.targetId === targetId);
      if (tab) void this.release(tab.tabId, false).catch(this.fatal);
    });
    if (this.cookies.length)
      await browser.send("Storage.setCookies", { cookies: this.cookies });
    await this.rememberCookies();
    this.downloads = new Downloads(
      browser,
      join(this.config.stateDir, "downloads"),
      this.log,
      this.fatal,
    );
    await this.downloads.start();
    this.policy = new TabPolicy(
      browser,
      this.config,
      this.downloads,
      this.log,
      this.fatal,
      () => !!this.diskError || !this.ready,
    );
    browser.on("Target.targetCreated", ({ targetInfo }) => {
      if (["service_worker", "shared_worker"].includes(targetInfo.type))
        this.fatal(
          Error("Origin-wide worker violates the dedicated-profile policy"),
        );
    });
    this.devtools = new Devtools(
      this.log,
      () => this.fatal(Error("Official MCP server disconnected")),
      this.config.actionTimeoutMs,
    );
    await this.devtools.start(endpoint, this.config.stateDir);
    this.ready = true;
    this.log("steward.ready", {
      version: (await browser.send("Browser.getVersion")).product,
      workerPolicy: "block-shared-and-service",
    });
  }
  private requireReady() {
    if (!this.ready || this.browser?.closed)
      throw Error(
        "Browser recovering; old tab leases are invalid. Open a new tab after health is ready.",
      );
    if (this.diskError) throw Error(this.diskError);
  }
  async open(
    agentId: string,
    lane: string,
    extra: Record<string, string> = {},
  ) {
    this.requireReady();
    idSchema.parse(agentId);
    if (!Object.hasOwn(this.config.lanes, lane))
      throw Error(`Unknown lane: ${lane}`);
    if (this.tabs.size + this.openings >= this.config.maxTabs)
      throw Error("Tab capacity reached");
    const headers = normalizeHeaders({ ...this.config.lanes[lane], ...extra });
    if (Object.keys(headers).length && !this.config.headerDomains.length)
      throw Error(
        "Lane headers require an explicit headerDomains allowlist (or --header-domains)",
      );
    this.openings++;
    try {
      await guardDisk(this.config);
      const tabId = randomUUID(),
        url = `about:blank#${tabId}`;
      const { targetId } = await this.browser!.send("Target.createTarget", {
        url,
      });
      try {
        const session = await this.browser!.attach(targetId);
        const tab: Tab = {
          tabId,
          agentId,
          lane,
          headers,
          targetId,
          session,
          url,
          pageId: 0,
          expiresAt: Date.now() + this.config.leaseMs,
          busy: false,
        };
        await this.policy!.watch(session, "page", tab, url);
        tab.pageId = await this.devtools!.pageId(url);
        this.tabs.set(tabId, tab);
        this.log("tab.opened", {
          agentId,
          tabId,
          pageId: tab.pageId,
          lane,
          headerHash: fingerprint(headers),
        });
        return this.describe(tab);
      } catch (e) {
        await this.browser!.send("Target.closeTarget", { targetId });
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
    await this.downloads!.forget(tabId);
    if (close)
      await this.browser!.send("Target.closeTarget", { targetId: t.targetId });
    this.log("tab.released", { agentId: t.agentId, tabId, lane: t.lane });
  }
  async closeTab(agentId: string, tabId: string) {
    this.owned(agentId, tabId);
    await this.release(tabId);
    return { closed: tabId };
  }
  renew(agentId: string, tabId: string) {
    const t = this.owned(agentId, tabId);
    t.expiresAt = Date.now() + this.config.leaseMs;
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
    t.expiresAt = Date.now() + this.config.leaseMs;
    try {
      if (method === "devtools") {
        const name = String(args.name);
        if (!diagnosticNames.includes(name))
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
          const result = await this.devtools!.call(
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
      return await this.devtools!.action(t.pageId, method, args);
    } finally {
      t.busy = false;
      t.expiresAt = Date.now() + this.config.leaseMs;
      if (this.ready) await this.rememberCookies();
    }
  }
  private async rememberCookies() {
    try {
      const { cookies } = await this.browser!.send("Storage.getCookies");
      // Storage.setCookies accepts CookieParam, not response-only Cookie metadata.
      this.cookies = cookies.map(
        ({
          name,
          value,
          domain,
          path,
          expires,
          httpOnly,
          secure,
          sameSite,
          priority,
          sameParty,
          sourceScheme,
          sourcePort,
          partitionKey,
        }: any) => ({
          name,
          value,
          domain,
          path,
          ...(expires > 0 ? { expires } : {}),
          httpOnly,
          secure,
          sameSite,
          priority,
          sameParty,
          sourceScheme,
          sourcePort,
          partitionKey,
        }),
      );
    } catch (e) {
      if (!(e instanceof CdpClosedError)) throw e;
      this.log("cookies.snapshot-unavailable");
    }
  }
  health() {
    return {
      ready: this.ready && !this.diskError,
      connected: !!this.browser && !this.browser.closed,
      mode: this.config.headless ? "headless=new" : "headed",
      tabs: this.tabs.size,
      diskError: this.diskError,
      workerPolicy: "block-shared-and-service",
      endpoint: this.chrome.endpoint,
      officialVersion: "1.13.0",
      officialPid: this.devtools?.transport?.pid,
    };
  }
  async recover() {
    if (this.stopping) return;
    if (this.recovering) return this.recovering;
    this.ready = false;
    this.recovering = (async () => {
      this.log("reconnect.started");
      const completed = this.downloads?.completed.slice() || [];
      await this.devtools?.stop();
      await this.chrome.stop();
      this.tabs.clear();
      this.traceOwner = undefined;
      this.traceBusy = false;
      await this.browser?.close();
      await this.policy?.close();
      await this.downloads?.abandon();
      await this.connect();
      this.downloads!.completed.push(...completed);
      this.log("reconnect.completed", { leasesInvalidated: true });
    })().finally(() => {
      this.recovering = undefined;
    });
    return this.recovering;
  }
  async sweep() {
    if (this.stopping || this.recovering) return;
    if (!this.ready) {
      await this.recover();
      return;
    }
    await this.browser!.send("Browser.getVersion");
    await this.rememberCookies();
    for (const t of [...this.tabs.values()])
      if (!t.busy && t.expiresAt < Date.now()) await this.release(t.tabId);
    const { targetInfos } = await this.browser!.send("Target.getTargets");
    for (const p of targetInfos)
      if (
        p.type === "page" &&
        p.targetId !== this.anchor &&
        ![...this.tabs.values()].some((t) => t.targetId === p.targetId) &&
        !this.openings
      )
        await this.browser!.send("Target.closeTarget", {
          targetId: p.targetId,
        });
    const previous = this.diskError;
    try {
      await guardDisk(this.config);
      this.diskError = undefined;
    } catch (e) {
      this.diskError = String(e);
    }
    if (previous !== this.diskError) {
      await this.downloads!.setBlocked(!!this.diskError);
      this.log(this.diskError ? "disk.blocked" : "disk.restored", {
        error: this.diskError,
      });
    }
  }
  async stop() {
    this.stopping = true;
    this.ready = false;
    if (this.timer) clearInterval(this.timer);
    if (this.recovering) await this.recovering;
    try {
      for (const t of [...this.tabs.values()]) await this.release(t.tabId);
      await this.downloads?.close();
    } finally {
      try {
        await this.devtools?.stop();
        await this.browser?.close();
        await this.policy?.close();
      } finally {
        await this.chrome.stop();
        this.log("steward.stopped");
      }
    }
  }
}

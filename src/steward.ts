import { join } from "node:path";
import { configSchema, type Config } from "./config.js";
import { ChromeProcess, guardDisk, type Log } from "./runtime.js";
import { CdpConnection } from "./cdp.js";
import { Downloads } from "./downloads.js";
import { TabPolicy } from "./headers.js";
import { Devtools, diagnosticNames } from "./devtools.js";
import { OwnedTabs, type Tab } from "./session/owned-tabs.js";
import { CookieSnapshot } from "./adapters/chrome/cookie-snapshot.js";
export { fingerprint, type Tab } from "./session/owned-tabs.js";
export class Steward {
  readonly tabs: Map<string, Tab>;
  private readonly leases: OwnedTabs;
  readonly chrome: ChromeProcess;
  browser?: CdpConnection;
  downloads?: Downloads;
  policy?: TabPolicy;
  devtools?: Devtools;
  private readonly cookies: CookieSnapshot;
  private anchor?: string;
  private timer?: NodeJS.Timeout;
  private recovering?: Promise<void>;
  private stopping = false;
  private ready = false;
  private diskError?: string;
  private sweeping = false;
  constructor(
    readonly config: Config,
    readonly log: Log,
  ) {
    configSchema.parse(config);
    this.chrome = new ChromeProcess(config, log);
    this.cookies = new CookieSnapshot(log);
    this.leases = new OwnedTabs(
      this,
      () => this.requireReady(),
      () => guardDisk(config),
      async () => {
        if (this.ready) await this.rememberCookies();
      },
      diagnosticNames,
    );
    this.tabs = this.leases.tabs;
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
    await this.cookies.restore(browser);
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
  open(agentId: string, lane: string, extra: Record<string, string> = {}) {
    return this.leases.open(agentId, lane, extra);
  }
  list(agentId?: string) {
    return this.leases.list(agentId);
  }
  release(tabId: string, close = true) {
    return this.leases.release(tabId, close);
  }
  closeTab(agentId: string, tabId: string) {
    return this.leases.closeTab(agentId, tabId);
  }
  renew(agentId: string, tabId: string) {
    return this.leases.renew(agentId, tabId);
  }
  closeAgent(agentId: string) {
    return this.leases.closeAgent(agentId);
  }
  action(
    agentId: string,
    tabId: string,
    method: string,
    args: Record<string, unknown> = {},
  ) {
    return this.leases.action(agentId, tabId, method, args);
  }
  private async rememberCookies() {
    await this.cookies.remember(this.browser!);
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
      this.leases.reset();
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
    await this.leases.expire();
    const { targetInfos } = await this.browser!.send("Target.getTargets");
    for (const p of targetInfos)
      if (
        p.type === "page" &&
        p.targetId !== this.anchor &&
        ![...this.tabs.values()].some((t) => t.targetId === p.targetId) &&
        !this.leases.openings
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

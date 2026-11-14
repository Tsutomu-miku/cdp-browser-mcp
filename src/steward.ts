import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
  type Locator,
  type Cookie,
} from "playwright";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  configSchema,
  idSchema,
  normalizeHeaders,
  fingerprint,
  type Config,
} from "./config.js";
import { ChromeProcess, guardDisk, type Log } from "./runtime.js";
import { Downloads } from "./downloads.js";
import type { BrowserBackend } from "./backend.js";
export interface Tab {
  tabId: string;
  agentId: string;
  lane: string;
  headers: Record<string, string>;
  page: Page;
  expiresAt: number;
  busy: boolean;
}
export class Steward implements BrowserBackend {
  readonly tabs = new Map<string, Tab>();
  readonly chrome: ChromeProcess;
  browser?: Browser;
  context?: BrowserContext;
  downloads?: Downloads;
  private cookies: Cookie[] = [];
  private anchor?: Page;
  private timer?: NodeJS.Timeout;
  private recovering?: Promise<void>;
  private stopping = false;
  private ready = false;
  private diskError?: string;
  private sweeping = false;
  private openings = 0;
  constructor(
    readonly config: Config,
    readonly log: Log,
  ) {
    configSchema.parse(config);
    this.chrome = new ChromeProcess(config, log);
  }
  async start() {
    await this.connect();
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
    this.browser = await chromium.connectOverCDP(endpoint, {
      noDefaults: true,
      timeout: 15000,
    });
    const cdp = await this.browser.newBrowserCDPSession();
    const command = await cdp.send("Browser.getBrowserCommandLine");
    if (
      !command.arguments.includes(
        `--user-data-dir=${join(this.config.stateDir, "profile")}`,
      ) ||
      !command.arguments.includes("--disable-shared-workers")
    )
      throw Error("CDP target is not the dedicated steward Chrome");
    this.context = this.browser.contexts()[0];
    if (!this.context) throw Error("CDP default context missing");
    this.context.setDefaultTimeout(this.config.actionTimeoutMs);
    this.context.setDefaultNavigationTimeout(this.config.actionTimeoutMs);
    if (
      this.context
        .serviceWorkers()
        .some((w) => new URL(w.url()).protocol !== "chrome-extension:")
    )
      throw Error(
        "Existing web service workers are forbidden; import cookies into a clean steward profile",
      );
    await this.context.route("**/*", (route) => this.route(route));
    if (this.cookies.length) await this.context.addCookies(this.cookies);
    await this.rememberCookies();
    const targets = await cdp.send("Target.getTargets");
    const contextId = targets.targetInfos.find(
      (t) => t.type === "page",
    )?.browserContextId;
    this.anchor =
      this.context.pages().find((p) => p.url() === "about:blank") ||
      (await this.context.newPage());
    for (const page of this.context.pages())
      if (page !== this.anchor) await page.close();
    this.anchor.once("close", () => {
      if (this.ready && !this.stopping)
        void this.recover().catch((e) =>
          this.log("reconnect.failed", { error: String(e) }),
        );
    });
    this.downloads = new Downloads(
      cdp,
      join(this.config.stateDir, "downloads"),
      this.log,
      (e) => {
        this.log("download.error", { error: String(e) });
        void this.recover().catch((e) =>
          this.log("reconnect.failed", { error: String(e) }),
        );
      },
      contextId,
    );
    await this.downloads.start();
    this.browser.on("disconnected", () => {
      this.ready = false;
      if (!this.stopping)
        void this.recover().catch((e) =>
          this.log("reconnect.failed", { error: String(e) }),
        );
    });
    this.ready = true;
    this.log("steward.ready", {
      version: this.browser.version(),
      workerPolicy: "block-shared-and-service",
    });
  }
  private async route(route: Route) {
    const q = route.request();
    try {
      const h = await q.allHeaders();
      if (
        q.serviceWorker() ||
        h["service-worker"] === "script" ||
        h["sec-fetch-dest"] === "serviceworker" ||
        h["sec-fetch-dest"] === "sharedworker"
      ) {
        this.log("request.blocked", {
          reason: "shared-or-service-worker",
          origin: new URL(q.url()).origin,
        });
        await route.abort("blockedbyclient");
        return;
      }
      let page: Page;
      try {
        page = q.frame().page();
      } catch {
        this.log("request.blocked", { reason: "unattributed-frame" });
        await route.abort("blockedbyclient");
        return;
      }
      const tab = [...this.tabs.values()].find((t) => t.page === page);
      if (!tab || this.diskError) {
        this.log("request.blocked", {
          reason: !tab ? "unowned-page" : "disk-guard",
        });
        await route.abort("blockedbyclient");
        return;
      }
      const headers = { ...h, ...tab.headers };
      const u = new URL(q.url());
      this.log("request.routed", {
        agentId: tab.agentId,
        tabId: tab.tabId,
        lane: tab.lane,
        headerHash: fingerprint(tab.headers),
        type: q.resourceType(),
        origin: u.origin,
        path: u.pathname,
        headerHit: Object.entries(tab.headers).every(
          ([k, v]) => headers[k] === v,
        ),
      });
      await route.continue({ headers });
    } catch (e) {
      if (this.browser?.isConnected()) {
        this.log("request.failed", { error: String(e) });
      }
      // The page/target can disappear while a request is paused. Do not continue it without its owner.
      try {
        await route.abort("blockedbyclient");
      } catch (abortError) {
        this.log("request.abort-failed", { error: String(abortError) });
      }
    }
  }
  private requireReady() {
    if (!this.ready || !this.browser?.isConnected())
      throw Error(
        "Browser recovering; old tab leases are invalid. Retry by opening a new tab after health is ready.",
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
    this.openings++;
    try {
      await guardDisk(this.config);
      const headers = normalizeHeaders({
        ...this.config.lanes[lane],
        ...extra,
      });
      const page = await this.context!.newPage();
      const tab: Tab = {
        tabId: randomUUID(),
        agentId,
        lane,
        headers,
        page,
        expiresAt: Date.now() + this.config.leaseMs,
        busy: false,
      };
      this.tabs.set(tab.tabId, tab);
      page.on("close", () => {
        void this.release(tab.tabId, false).catch((e) =>
          this.log("tab.cleanup-error", { error: String(e) }),
        );
      });
      page.on("popup", (popup) => {
        void popup
          .close()
          .catch((e) => this.log("popup.close-error", { error: String(e) }));
      });
      try {
        await page.setExtraHTTPHeaders(headers);
        await this.downloads!.watch(page, tab);
        this.log("tab.opened", {
          agentId,
          tabId: tab.tabId,
          lane,
          headerHash: fingerprint(headers),
        });
        return this.describe(tab);
      } catch (e) {
        await this.release(tab.tabId, true);
        throw e;
      }
    } finally {
      this.openings--;
    }
  }
  private describe(t: Tab) {
    return {
      tabId: t.tabId,
      agentId: t.agentId,
      lane: t.lane,
      headerHash: fingerprint(t.headers),
      expiresAt: t.expiresAt,
      url: t.page.url(),
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
    if (close && !t.page.isClosed()) await t.page.close();
    if (this.downloads) {
      try {
        await this.downloads.forget(tabId);
      } catch (e) {
        if (this.ready && this.browser?.isConnected() && !t.page.isClosed())
          throw e;
        this.log("tab.session-detached", { tabId });
      }
    }
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
  private locator(page: Page, args: Record<string, unknown>): Locator {
    if (typeof args.ref === "string") return page.getByRef(args.ref);
    if (typeof args.selector === "string") return page.locator(args.selector);
    throw Error("Provide ref from browser_snapshot or a CSS selector");
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
      switch (method) {
        case "navigate": {
          const u = new URL(String(args.url));
          if (!["http:", "https:", "about:"].includes(u.protocol))
            throw Error("Only http(s) and about URLs are supported");
          await t.page.goto(u.href);
          return {
            url: t.page.url(),
            snapshot: await t.page.ariaSnapshot({ mode: "ai" }),
          };
        }
        case "click":
          await this.locator(t.page, args).click();
          return { snapshot: await t.page.ariaSnapshot({ mode: "ai" }) };
        case "type": {
          const loc = this.locator(t.page, args);
          if (args.slowly) await loc.pressSequentially(String(args.text));
          else await loc.fill(String(args.text));
          if (args.submit) await loc.press("Enter");
          return { snapshot: await t.page.ariaSnapshot({ mode: "ai" }) };
        }
        case "snapshot":
          return {
            url: t.page.url(),
            snapshot: await t.page.ariaSnapshot({ mode: "ai" }),
          };
        case "extract":
          return {
            text: (
              await t.page
                .locator(
                  typeof args.selector === "string" ? args.selector : "body",
                )
                .innerText()
            ).slice(0, 100000),
          };
        case "screenshot":
          return {
            mimeType: "image/jpeg",
            data: (
              await t.page.screenshot({ type: "jpeg", quality: 60 })
            ).toString("base64"),
          };
        default:
          throw Error(`Unknown browser action: ${method}`);
      }
    } finally {
      t.busy = false;
      t.expiresAt = Date.now() + this.config.leaseMs;
      if (this.ready) await this.rememberCookies();
    }
  }
  private async rememberCookies() {
    try {
      this.cookies = await this.context!.cookies();
    } catch (e) {
      if (this.browser?.isConnected()) throw e;
      this.log("cookies.snapshot-unavailable");
    }
  }
  health() {
    return {
      backend: "cdp",
      ready: this.ready && !this.diskError,
      connected: !!this.browser?.isConnected(),
      mode: this.config.headless ? "headless=new" : "headed",
      tabs: this.tabs.size,
      diskError: this.diskError,
      workerPolicy: "block-shared-and-service",
      endpoint: this.chrome.endpoint,
    };
  }
  async recover() {
    if (this.stopping) return;
    if (this.recovering) return this.recovering;
    this.ready = false;
    this.recovering = (async () => {
      this.log("reconnect.started");
      const completed = this.downloads?.completed.slice() || [];
      // A lost interceptor cannot safely preserve live lane tabs. Restart the owned browser, invalidate leases, retain only its dedicated profile.
      await this.chrome.stop();
      this.tabs.clear();
      await this.browser?.close();
      await this.downloads?.abandon();
      this.downloads = undefined;
      this.context = undefined;
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
    await this.rememberCookies();
    for (const t of [...this.tabs.values()])
      if (!t.busy && t.expiresAt < Date.now()) await this.release(t.tabId);
    for (const p of this.context!.pages())
      if (
        p !== this.anchor &&
        ![...this.tabs.values()].some((t) => t.page === p)
      )
        await p.close();
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
        await this.browser?.close();
      } finally {
        await this.chrome.stop();
        this.log("steward.stopped");
      }
    }
  }
}

import { CdpClosedError, type CdpSession, type CdpConnection } from "./cdp.js";
import type { Config } from "./config.js";
import type { Log } from "./runtime.js";
import type { Downloads, DownloadOwner } from "./downloads.js";
const blockServiceWorkers = `(() => {
  if (typeof ServiceWorkerContainer !== 'undefined') Object.defineProperty(ServiceWorkerContainer.prototype, 'register', {
    value: () => Promise.reject(new DOMException('ServiceWorker registration is disabled by the shared-profile worker policy', 'NotSupportedError')),
    writable: false, configurable: false
  });
})();`;

export function matchesDomain(host: string, domains: string[]) {
  return domains.some((d) =>
    d.startsWith("*.")
      ? host.endsWith(d.slice(1)) && host !== d.slice(2)
      : host === d,
  );
}
export interface LaneOwner extends DownloadOwner {
  headers: Record<string, string>;
  lane: string;
}
/** Owns request interception, including recursively attached iframe/dedicated-worker targets. */
export class TabPolicy {
  readonly sessions = new Map<string, CdpSession>();
  private tasks = new Set<Promise<void>>();
  constructor(
    readonly cdp: CdpConnection,
    readonly config: Config,
    readonly downloads: Downloads,
    readonly log: Log,
    readonly fatal: (e: unknown) => void,
    readonly blocked: () => boolean,
  ) {}
  private track(task: Promise<void>) {
    this.tasks.add(task);
    void task
      .catch((e) => {
        if (!(e instanceof CdpClosedError)) this.fatal(e);
      })
      .finally(() => this.tasks.delete(task));
  }
  async watch(
    session: CdpSession,
    type: string,
    owner: LaneOwner,
    targetUrl: string,
  ) {
    this.sessions.set(session.id!, session);
    session.once("closed", () => this.sessions.delete(session.id!));
    session.on("Target.attachedToTarget", (e) =>
      this.track(
        (async () => {
          const child = this.cdp.session(e.sessionId);
          await this.watch(child, e.targetInfo.type, owner, e.targetInfo.url);
          if (e.waitingForDebugger)
            await child.send("Runtime.runIfWaitingForDebugger");
        })(),
      ),
    );
    session.on("Fetch.requestPaused", (e) =>
      this.track(this.route(session, owner, e)),
    );
    await session.send("Network.enable");
    await session.send("Network.setCacheDisabled", { cacheDisabled: true });
    if (type === "worker") {
      const origin = new URL(targetUrl).origin;
      const allowed =
        origin !== "null" &&
        matchesDomain(new URL(origin).hostname, this.config.headerDomains);
      // Worker Fetch is owned by the ancestor page. Network headers supply same-origin
      // nested worker startup scripts; ancestor Fetch removes these keys on external requests.
      await session.send("Network.setExtraHTTPHeaders", {
        headers: allowed ? owner.headers : {},
      });
      await session.send("Runtime.evaluate", {
        expression: blockServiceWorkers,
      });
    }
    await session.send("Network.setBypassServiceWorker", { bypass: true });
    if (type === "page" || type === "iframe") {
      await session.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
      });
      await session.send("Page.addScriptToEvaluateOnNewDocument", {
        source: blockServiceWorkers,
      });
      await this.downloads.watch(session, owner);
      this.log("worker.policy-installed", { tabId: owner.tabId });
    }
    await session.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "iframe" }, { type: "worker" }, { exclude: true }],
    });
  }
  private async route(session: CdpSession, owner: LaneOwner, e: any) {
    const headers = Object.fromEntries(
      Object.entries(e.request.headers as Record<string, string>).map(
        ([k, v]) => [k.toLowerCase(), v],
      ),
    );
    const url = new URL(e.request.url);
    if (
      this.blocked() ||
      headers["service-worker"] === "script" ||
      ["serviceworker", "sharedworker"].includes(headers["sec-fetch-dest"])
    ) {
      await session.send("Fetch.failRequest", {
        requestId: e.requestId,
        errorReason: "BlockedByClient",
      });
      this.log("request.blocked", {
        reason: this.blocked() ? "disk-guard" : "shared-or-service-worker",
        origin: url.origin,
      });
      return;
    }
    const allowed = matchesDomain(url.hostname, this.config.headerDomains);
    // Remove lane keys before applying policy: page-supplied values cannot spoof a lane or leak it across a redirect.
    for (const key of Object.keys(owner.headers)) delete headers[key];
    if (allowed) Object.assign(headers, owner.headers);
    await session.send("Fetch.continueRequest", {
      requestId: e.requestId,
      headers: Object.entries(headers).map(([name, value]) => ({
        name,
        value,
      })),
    });
    this.log("request.routed", {
      agentId: owner.agentId,
      tabId: owner.tabId,
      lane: owner.lane,
      type: e.resourceType,
      origin: url.origin,
      path: url.pathname,
      allowed,
      headerHit: Object.entries(owner.headers).every(([k, v]) =>
        allowed ? headers[k] === v : !(k in headers),
      ),
    });
  }
  async close() {
    await Promise.allSettled([...this.tasks]);
    this.sessions.clear();
  }
}

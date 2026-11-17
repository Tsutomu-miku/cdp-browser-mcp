import { Targets } from "./targets.js";
import { accessPolicy, permitted } from "./access.js";

const denied = new Set([
  "Page.close",
  "Page.crash",
  "Network.getAllCookies",
  "Network.getCookies",
  "Network.setCookie",
  "Network.setCookies",
  "Network.deleteCookies",
  "Network.clearBrowserCookies",
  "Network.clearBrowserCache",
]);
const matches = (type, filter = [{}]) => {
  const rule = filter.find((rule) => !rule.type || rule.type === type);
  return rule !== undefined && !rule.exclude;
};

/** One official CDP connection owns all flattened sessions; no client IDs cross this boundary. */
export class ExtensionCdp {
  constructor(api, emit) {
    this.api = api;
    this.emit = emit;
    this.targets = new Targets(api, emit);
  }
  async command({ method, params = {}, sessionId }) {
    if (
      typeof method !== "string" ||
      denied.has(method) ||
      /^(Browser|Storage|SystemInfo|Extensions)\./.test(method)
    )
      throw Error(`Unavailable in daily Chrome extension mode: ${method}`);
    const state = await this.targets.refresh();
    const all = Object.values(state.targets);
    if (method === "Target.getBrowserContexts")
      return { browserContextIds: [] };
    if (method === "Target.getTargets")
      return {
        targetInfos: all.flatMap((t) => [
          this.targets.info(t, "tab"),
          this.targets.info(t),
        ]),
      };
    if (method === "Target.setDiscoverTargets") {
      state.discover = params.discover;
      await this.targets.save(state);
      if (params.discover)
        for (const t of all)
          for (const type of ["tab", "page"])
            if (matches(type, params.filter))
              this.emit({
                method: "Target.targetCreated",
                params: { targetInfo: this.targets.info(t, type) },
              });
      return {};
    }
    if (!sessionId && method === "Target.setAutoAttach") {
      if (!params.flatten)
        throw Error("Extension mode requires flattened CDP sessions");
      state.autoAttach = params.autoAttach && matches("tab", params.filter);
      state.filter = params.filter;
      await this.targets.save(state);
      for (const t of all) {
        if (state.autoAttach) await this.targets.attach(t, state);
        else await this.targets.detach(t);
      }
      await this.targets.save(state);
      return {};
    }
    if (!sessionId && method === "Target.attachToTarget") {
      const target = all.find((t) => t.id === params.targetId);
      if (!target?.pageSession)
        throw Error("Target not available in approved daily tabs");
      const result = await this.api.debugger.sendCommand(
        { tabId: target.tabId },
        method,
        params,
      );
      return { sessionId: `${target.tabId}:${result.sessionId}` };
    }
    if (!sessionId && method === "Target.detachFromTarget") {
      const t = all.find(
        (t) =>
          t.tabSession === params.sessionId ||
          t.pageSession === params.sessionId ||
          params.sessionId?.startsWith(`${t.tabId}:`),
      );
      if (!t) throw Error("Unknown root session");
      if (params.sessionId.startsWith(`${t.tabId}:`))
        return await this.api.debugger.sendCommand({ tabId: t.tabId }, method, {
          sessionId: params.sessionId.slice(String(t.tabId).length + 1),
        });
      await this.targets.remove(state, String(t.tabId), true);
      await this.targets.save(state);
      return {};
    }
    const target = all.find(
      (t) =>
        t.pageSession === sessionId ||
        t.tabSession === sessionId ||
        sessionId?.startsWith(`${t.tabId}:`),
    );
    if (!target)
      throw Error(
        `Unknown or unavailable extension session: ${sessionId ?? "root"}`,
      );
    if (sessionId === target.tabSession) {
      if (method === "Target.setAutoAttach") {
        if (!params.autoAttach)
          throw Error(
            "End the relay connection to detach logical tab sessions",
          );
        if (params.autoAttach)
          this.emit({
            method: "Target.attachedToTarget",
            sessionId,
            params: {
              sessionId: target.pageSession,
              targetInfo: this.targets.info(target),
              waitingForDebugger: false,
            },
          });
        return {};
      }
      if (method === "Runtime.runIfWaitingForDebugger") return {}; // Relay tab containers have no runtime.
      if (method === "Target.getTargetInfo")
        return { targetInfo: this.targets.info(target, "tab") };
      throw Error(`Unsupported command on relay tab container: ${method}`);
    }
    if (method === "Target.getTargetInfo" && sessionId === target.pageSession)
      return { targetInfo: this.targets.info(target) };
    if (method === "Target.closeTarget" || method === "Target.createTarget")
      throw Error(
        "Creating/closing daily tabs is not exposed in extension mode",
      );
    if (
      method === "Page.navigate" &&
      !permitted(params.url, await accessPolicy(this.api))
    )
      throw Error("Navigation origin is not approved in the extension popup");
    const source = { tabId: target.tabId };
    if (sessionId !== target.pageSession)
      source.sessionId = sessionId.slice(String(target.tabId).length + 1);
    const forwarded = { ...params };
    if (
      method === "Target.detachFromTarget" &&
      typeof params.sessionId === "string"
    )
      forwarded.sessionId = params.sessionId.slice(
        String(target.tabId).length + 1,
      );
    return await this.api.debugger.sendCommand(source, method, forwarded);
  }
  async event(source, method, params) {
    const state = await this.targets.state();
    const target = state.targets[String(source.tabId)];
    if (!target?.pageSession) return; // Events from a detached generation are obsolete.
    const sessionId = source.sessionId
      ? `${source.tabId}:${source.sessionId}`
      : target.pageSession;
    const result = { ...params };
    if (
      method === "Target.attachedToTarget" ||
      method === "Target.detachedFromTarget"
    )
      result.sessionId = `${source.tabId}:${params.sessionId}`;
    this.emit({ method, params: result, sessionId });
  }
}

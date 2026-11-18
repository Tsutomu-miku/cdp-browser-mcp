import { accessPolicy, permitted } from "./access.js";

/** Chrome debugger targets projected as CDP tab/page targets for Puppeteer. */
export class Targets {
  constructor(api, emit) {
    this.api = api;
    this.emit = emit;
  }
  async state() {
    const { bridge = { targets: {}, discover: false, autoAttach: false } } =
      await this.api.storage.session.get("bridge");
    return bridge;
  }
  async save(state) {
    await this.api.storage.session.set({ bridge: state });
  }
  info(target, type = "page") {
    return {
      targetId: type === "tab" ? `tab:${target.id}` : target.id,
      type,
      title: target.title,
      url: target.url,
      attached: Boolean(target.pageSession),
      canAccessOpener: false,
    };
  }
  async refresh() {
    const state = await this.state();
    const policy = await accessPolicy(this.api);
    const tabs = await this.api.tabs.query({});
    const debugTargets = await this.api.debugger.getTargets();
    const visible = new Set();
    for (const tab of tabs) {
      if (tab.incognito || !permitted(tab.url, policy)) continue;
      const debug = debugTargets.find(
        (d) => d.tabId === tab.id && d.type === "page",
      );
      if (!debug) continue; // A tab can be between documents, without a page target.
      const key = String(tab.id);
      visible.add(key);
      let existing = state.targets[key];
      if (existing && existing.id !== debug.id) {
        await this.remove(state, key, true);
        existing = undefined;
      }
      const target = state.targets[key] ?? {
        tabId: tab.id,
        id: debug.id,
      };
      const changed = target.url !== tab.url || target.title !== tab.title;
      target.url = tab.url;
      target.title = debug.title;
      state.targets[key] = target;
      if (state.discover && (!existing || changed)) {
        const method = existing
          ? "Target.targetInfoChanged"
          : "Target.targetCreated";
        for (const type of ["tab", "page"])
          this.emit({
            method,
            params: { targetInfo: this.info(target, type) },
          });
      }
    }
    for (const key of Object.keys(state.targets))
      if (!visible.has(key)) {
        const target = state.targets[key];
        const attached = debugTargets.some(
          (debug) => debug.tabId === target.tabId && debug.attached,
        );
        await this.remove(state, key, attached);
      }
    await this.save(state);
    if (state.autoAttach)
      for (const target of Object.values(state.targets))
        await this.attach(target, state);
    return state;
  }
  async attach(target, state) {
    if (target.pageSession) return;
    try {
      await this.api.debugger.attach({ tabId: target.tabId }, "1.3");
    } catch (error) {
      throw Error(
        `Chrome extension debugger attach failed. Check the extension and managed debugger policy; extension mode does not need Remote Debugging or Allow. Cause: ${error.message}`,
      );
    }
    const epoch = crypto.randomUUID();
    target.tabSession = `tab:${epoch}`;
    target.pageSession = `page:${epoch}`;
    await this.save(state);
    this.emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId: target.tabSession,
        targetInfo: this.info(target, "tab"),
        waitingForDebugger: false,
      },
    });
  }
  async detach(target, physical = true) {
    if (physical && target.pageSession)
      await this.api.debugger.detach({ tabId: target.tabId });
    if (target.pageSession)
      this.emit({
        method: "Target.detachedFromTarget",
        sessionId: target.tabSession,
        params: { sessionId: target.pageSession, targetId: target.id },
      });
    if (target.tabSession)
      this.emit({
        method: "Target.detachedFromTarget",
        params: { sessionId: target.tabSession, targetId: `tab:${target.id}` },
      });
    delete target.pageSession;
    delete target.tabSession;
  }
  async remove(state, key, detach) {
    const target = state.targets[key];
    await this.detach(target, detach);
    for (const type of ["page", "tab"])
      this.emit({
        method: "Target.targetDestroyed",
        params: { targetId: this.info(target, type).targetId },
      });
    delete state.targets[key];
  }
  async reset() {
    const state = await this.state();
    state.discover = false;
    state.autoAttach = false;
    const failures = [];
    for (const [key, target] of Object.entries(state.targets)) {
      try {
        await this.remove(state, key, true);
      } catch (error) {
        // Chrome may close a tab between reading our session map and detaching.
        try {
          const active = await this.api.debugger.getTargets();
          if (
            active.some((item) => item.tabId === target.tabId && item.attached)
          )
            throw error;
          await this.remove(state, key, false);
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
    }
    await this.save(state);
    if (failures.length)
      throw new AggregateError(
        failures,
        "Could not detach every Chrome debugger session",
        { cause: failures[0] },
      );
  }
}

import { accessPolicy, permitted } from "./access.js";

const WORLD = "CDP Browser MCP activity";
const POST_ACTION_MS = 3000;
const ACTIVE_LIMIT_MS = 95_000;

// Serialized into an isolated world. No page content or request headers are read.
function render(presentation) {
  const key = "__cdpBrowserMcpActivity";
  const existing = globalThis[key];
  if (presentation === null) {
    if (existing) existing.remove();
    return;
  }
  // A navigation can commit after the service worker checked the frame URL.
  if (globalThis.origin !== presentation.origin) return;
  if (existing) {
    existing.update(presentation);
    return;
  }

  const host = document.createElement("div");
  host.id = "cdp-browser-mcp-activity";
  host.popover = "manual";
  host.setAttribute("aria-hidden", "true");
  const shadow = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host(:popover-open) {
      all: initial !important;
      display: block !important;
      color-scheme: light dark !important;
      position: fixed !important;
      inset: auto 0 0 auto !important;
      margin: 0 !important;
      pointer-events: none !important;
      user-select: none !important;
    }
    span {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 5px;
      max-width: min(240px, 100vw);
      min-height: 22px;
      padding: 0 7px 0 6px;
      overflow: hidden;
      white-space: nowrap;
      border-top: 1px solid light-dark(#d4d4d8, #52525b);
      border-left: 1px solid light-dark(#d4d4d8, #52525b);
      background: light-dark(#f8f9fb, #18181b);
      color: light-dark(#111827, #f4f4f5);
      font: 500 12px/1.3 system-ui, sans-serif;
    }
    span::before {
      content: "";
      flex: 0 0 5px;
      height: 5px;
      border-radius: 50%;
      background: light-dark(#15803d, #4ade80);
    }
  `);
  shadow.adoptedStyleSheets = [sheet];
  const status = document.createElement("span");
  shadow.append(status);
  document.documentElement.append(host);

  let timer;
  const remove = () => {
    clearTimeout(timer);
    host.remove();
    delete globalThis[key];
  };
  const update = ({ label, duration }) => {
    if (status.textContent !== label) status.textContent = label;
    if (!host.matches(":popover-open")) host.showPopover();
    clearTimeout(timer);
    timer = setTimeout(remove, duration);
  };
  globalThis[key] = { remove, update };
  update(presentation);
}

/** Page-local presentation for the attached tab; never blocks MCP command routing. */
export class PageActivity {
  constructor(api) {
    this.api = api;
    this.pages = new Map();
  }

  async evaluate(tabId, contextId, presentation) {
    try {
      const result = await this.api.debugger.sendCommand(
        { tabId },
        "Runtime.evaluate",
        {
          expression: `(${render.toString()})(${JSON.stringify(presentation)})`,
          contextId,
          silent: true,
          returnByValue: true,
        },
      );
      if (result.exceptionDetails)
        throw Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text,
        );
    } catch (error) {
      // A committed navigation or Chrome detachment already removed the old document's UI.
      if (
        !/Cannot find context|Execution context was destroyed|Debugger is not attached|No tab with id|Target closed/i.test(
          error.message,
        )
      )
        throw error;
    }
  }

  async update(tabId, label) {
    const previous = this.pages.get(tabId);
    if (label === undefined) {
      if (!previous) return;
      previous.endsAt = performance.now() + POST_ACTION_MS;
      if (previous.renderer) await this.display(tabId, previous);
      return;
    }
    const current = { label, renderer: previous?.renderer };
    this.pages.set(tabId, current);
    if (!current.renderer) await this.paint(tabId, current);
    else await this.display(tabId, current);
  }

  async display(tabId, current) {
    // Bound the display even if the browser connection stops unexpectedly.
    const duration =
      current.endsAt === undefined
        ? ACTIVE_LIMIT_MS
        : current.endsAt - performance.now();
    if (duration <= 0) {
      await this.clear(tabId);
      return;
    }
    const { contextId, origin } = current.renderer;
    await this.evaluate(tabId, contextId, {
      label: current.label,
      duration,
      origin,
    });
  }

  async paint(tabId, current) {
    const [tab, policy] = await Promise.all([
      this.api.tabs.get(tabId),
      accessPolicy(this.api),
    ]);
    if (
      tab.incognito ||
      !permitted(tab.url, policy) ||
      this.pages.get(tabId) !== current
    )
      return;
    const target = { tabId };
    const { frameTree } = await this.api.debugger.sendCommand(
      target,
      "Page.getFrameTree",
    );
    if (
      !permitted(frameTree.frame.url, policy) ||
      this.pages.get(tabId) !== current
    )
      return;
    const { executionContextId } = await this.api.debugger.sendCommand(
      target,
      "Page.createIsolatedWorld",
      { frameId: frameTree.frame.id, worldName: WORLD },
    );
    if (this.pages.get(tabId) !== current) return;
    current.renderer = {
      contextId: executionContextId,
      origin: new URL(frameTree.frame.url).origin,
    };
    await this.display(tabId, current);
  }

  async navigated(tabId) {
    const previous = this.pages.get(tabId);
    if (!previous) return;
    const { label, endsAt } = previous;
    if (endsAt !== undefined && endsAt <= performance.now()) {
      this.pages.delete(tabId);
      return;
    }
    const current = { label, endsAt };
    this.pages.set(tabId, current);
    await this.paint(tabId, current);
  }

  async clear(tabId) {
    const current = this.pages.get(tabId);
    this.pages.delete(tabId);
    if (current?.renderer)
      await this.evaluate(tabId, current.renderer.contextId, null);
  }

  async reset() {
    await Promise.all([...this.pages.keys()].map((tabId) => this.clear(tabId)));
  }
}

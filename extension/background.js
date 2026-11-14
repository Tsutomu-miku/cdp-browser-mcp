const HOST = "io.github.tsutomu_miku.cdp_browser_mcp";
const VERSION = 1;
import sites from "./sites.js";
const allowed = new Set(sites);
let port,
  retry = 250,
  retryTimer;
globalThis.nativeConnection = { connected: false, lastError: undefined };
let ruleQueue = Promise.resolve();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const requestRegex = `^(${sites.map(escapeRegex).join("|")})(/|$)`;

function serializeRules(task) {
  const next = ruleQueue.then(task);
  // Keep the queue usable after reporting a failed operation to its caller.
  ruleQueue = next.catch((error) =>
    console.error("Rule operation failed:", error.message),
  );
  return next;
}
async function replaceHeaders(tabId, headers) {
  if (!Number.isInteger(tabId) || tabId < 0)
    throw Error("A concrete Chrome tabId is required");
  const entries = Object.entries(headers);
  if (entries.length) await chrome.tabs.get(tabId);
  for (const [name, value] of entries) {
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) ||
      typeof value !== "string" ||
      /[\r\n\0]/.test(value) ||
      value.length > 8192 ||
      [
        "host",
        "cookie",
        "authorization",
        "proxy-authorization",
        "connection",
        "content-length",
      ].includes(name.toLowerCase())
    )
      throw Error("Invalid lane header");
  }
  return serializeRules(async () => {
    const old = (await chrome.declarativeNetRequest.getSessionRules()).filter(
      (r) => r.condition.tabIds.includes(tabId),
    );
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: old.map((r) => r.id),
      addRules: entries.length
        ? [
            {
              id: tabId + 1,
              priority: 1,
              action: {
                type: "modifyHeaders",
                requestHeaders: entries.map(([header, value]) => ({
                  header,
                  operation: "set",
                  value,
                })),
              },
              // tabIds is supported only on session rules. Never use TAB_ID_NONE (-1).
              condition: {
                tabIds: [tabId],
                regexFilter: requestRegex,
                resourceTypes: [
                  "main_frame",
                  "sub_frame",
                  "stylesheet",
                  "script",
                  "image",
                  "font",
                  "object",
                  "xmlhttprequest",
                  "ping",
                  "media",
                  "other",
                ],
              },
            },
          ]
        : [],
    });
  });
}
function clearRules(tabId) {
  return serializeRules(async () => {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: rules
        .filter(
          (r) => tabId === undefined || r.condition.tabIds.includes(tabId),
        )
        .map((r) => r.id),
    });
  });
}
async function requireSite(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !allowed.has(new URL(tab.url).origin))
    throw Error("Site is not in the extension's explicit origin allowlist");
  return tab;
}
async function loaded(tabId) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    await sleep(50);
  }
  throw Error("Page load timed out; navigation may still complete");
}
async function pageAction(tabId, action, args) {
  await requireSite(tabId);
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["page.js"],
  });
  const result = await chrome.tabs.sendMessage(
    tabId,
    { kind: "page-action", action, args },
    { frameId: 0 },
  );
  if (result.error) throw Error(result.error);
  return result;
}
async function dispatch(method, p) {
  switch (method) {
    case "health":
      return {
        version: VERSION,
        extensionId: chrome.runtime.id,
        rules: (await chrome.declarativeNetRequest.getSessionRules()).map(
          (r) => ({ id: r.id, tabIds: r.condition.tabIds }),
        ),
        backgroundHeaders: "unmodified",
      };
    case "tabs":
      return (await chrome.tabs.query({})).map((t) => ({
        id: t.id,
        windowId: t.windowId,
        active: t.active,
        url: t.url,
        title: t.title,
      }));
    case "create":
      return chrome.tabs.create({ url: "about:blank", active: false });
    case "get":
      return chrome.tabs.get(p.tabId);
    case "remove":
      await clearRules(p.tabId);
      try {
        await chrome.tabs.remove(p.tabId);
      } catch (error) {
        if (!/^No tab with id: \d+\.$/.test(error.message)) throw error;
      }
      return { closed: p.tabId };
    case "headers":
      await replaceHeaders(p.tabId, p.headers);
      return { updated: p.tabId };
    case "sync":
      await clearRules();
      for (const t of p.tabs) await replaceHeaders(t.tabId, t.headers);
      return { synced: p.tabs.length };
    case "action": {
      const { tabId, action, args } = p;
      if (action === "navigate") {
        const url = new URL(args.url);
        if (!allowed.has(url.origin))
          throw Error(
            "Navigation origin is not in the explicit allowlist; prepare a new extension directory to grant it",
          );
        await chrome.tabs.update(tabId, { url: url.href });
        await loaded(tabId);
        return pageAction(tabId, "snapshot", {});
      }
      if (action === "screenshot") {
        const tab = await requireSite(tabId);
        if (!tab.active)
          throw Error(
            "Activate the target tab and click this extension's toolbar button to grant activeTab screenshot access",
          );
        const data = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: "jpeg",
          quality: 60,
        });
        const active = await chrome.tabs.query({
          windowId: tab.windowId,
          active: true,
        });
        if (active[0]?.id !== tabId || active[0]?.url !== tab.url)
          throw Error(
            "Active tab changed while capturing; screenshot discarded",
          );
        if (data.length > 1800000)
          throw Error(
            "Screenshot exceeds the PoC response limit; reduce the viewport",
          );
        return {
          mimeType: "image/jpeg",
          data: data.slice(data.indexOf(",") + 1),
          url: tab.url,
        };
      }
      return pageAction(tabId, action, args);
    }
    default:
      throw Error(`Unknown extension operation: ${method}`);
  }
}
function lostHost(current, reason) {
  if (port !== current) return;
  globalThis.nativeConnection = { connected: false, lastError: reason };
  console.warn("Native host disconnected:", reason);
  port = undefined;
  void clearRules().catch((error) =>
    console.error("Rule cleanup failed:", error.message),
  );
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connectHost, retry);
  retry = Math.min(retry * 2, 10000);
}
function connectHost() {
  if (port) return;
  const current = chrome.runtime.connectNative(HOST);
  port = current;
  globalThis.nativeConnection.lastMessageAt = Date.now();
  current.onMessage.addListener((message) => {
    globalThis.nativeConnection.lastMessageAt = Date.now();
    if (message.kind === "pong" && message.version === VERSION) return;
    if (
      message.kind !== "request" ||
      message.version !== VERSION ||
      typeof message.id !== "string"
    ) {
      lostHost(current, "Invalid native protocol frame");
      current.disconnect();
      return;
    }
    globalThis.nativeConnection.connected = true;
    retry = 250;
    void dispatch(message.method, message.params)
      .then(
        (result) =>
          current.postMessage({ kind: "response", id: message.id, result }),
        (error) =>
          current.postMessage({
            kind: "response",
            id: message.id,
            error: error.message,
          }),
      )
      .catch((error) =>
        console.error("Native response unavailable:", error.message),
      );
  });
  current.onDisconnect.addListener(() =>
    lostHost(current, chrome.runtime.lastError?.message || "port closed"),
  );
}
chrome.tabs.onRemoved.addListener((tabId) => {
  void clearRules(tabId).catch((error) =>
    console.error("Closed-tab cleanup failed:", error.message),
  );
});
chrome.action.onClicked.addListener(() => {
  /* Chrome grants activeTab for this explicit user gesture. */
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "native-health") connectHost();
});
// connectNative keeps the worker alive. A watchdog also detects a silent/frozen
// host, where onDisconnect alone would never run. Chrome terminates it on disconnect.
setInterval(() => {
  if (!port) return;
  if (Date.now() - globalThis.nativeConnection.lastMessageAt > 15000) {
    const current = port;
    lostHost(current, "Native heartbeat timed out");
    current.disconnect();
    return;
  }
  port.postMessage({ kind: "ping", version: VERSION });
}, 5000);
void chrome.alarms.create("native-health", { periodInMinutes: 0.5 });
void clearRules()
  .then(connectHost)
  .catch((error) =>
    console.error("Startup rule cleanup failed:", error.message),
  );

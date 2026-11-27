import { ExtensionCdp } from "./cdp.js";
import { accessPolicy } from "./access.js";
import { PageActivity } from "./activity.js";

const HOST = "io.github.tsutomu_miku.cdp_browser_mcp";
// Only live transport/serialization handles live in memory. Consent and CDP
// ownership live in storage; losing this worker invalidates the whole relay.
let port;
let serial = Promise.resolve();
let epoch = 0;
let revoking = false;
const send = (message) => {
  if (port) port.postMessage(message);
};
const cdp = new ExtensionCdp(chrome, (message) => {
  if (!revoking) send({ kind: "cdp", message });
});
const activity = new PageActivity(chrome);

async function report(error) {
  console.error("CDP Browser MCP:", error);
  await chrome.storage.local.set({ lastError: String(error) });
  await chrome.action.setBadgeText({ text: "!" });
}

function schedule(task) {
  const result = serial.then(task);
  // This is the event boundary: persist a visible failure, never a success fallback.
  serial = result.catch(report);
  return result;
}

function reportActivity(error) {
  console.error("CDP Browser MCP activity indicator:", error);
}

async function resetChrome() {
  let timer;
  try {
    // Give the indicator a chance to clear without holding up debugger detach
    // if the page is paused by a dialog or breakpoint.
    await Promise.race([
      activity.reset().catch(reportActivity),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 150);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await cdp.targets.reset();
  }
}

async function showAccess() {
  await chrome.action.setBadgeText({
    text: (await accessPolicy(chrome)).paused ? "OFF" : "ON",
  });
}

function revokeAccess(latchPause = false) {
  const revoked = ++epoch;
  revoking = true;
  // The host may have cached data even if detaching a tab fails.
  try {
    send({ kind: "revoke" });
  } finally {
    void schedule(async () => {
      try {
        if (latchPause) {
          const access = await accessPolicy(chrome);
          await chrome.storage.local.set({
            access: { ...access, paused: true },
          });
        }
      } finally {
        await resetChrome();
      }
      if (epoch === revoked) revoking = false;
      await showAccess();
    });
  }
}

function handleCommand(connection, request) {
  const requested = epoch;
  const current = () => port === connection && epoch === requested && !revoking;
  const { id, sessionId } = request;
  async function respond(result) {
    const message = { id, sessionId };
    try {
      message.result = await result;
    } catch (error) {
      if (current()) {
        await chrome.storage.local.set({ lastError: error.message });
        message.error = { code: -32000, message: error.message };
      }
    }
    if (current()) connection.postMessage({ kind: "cdp", message });
  }
  void schedule(async () => {
    if (!current()) return;
    try {
      const route = await cdp.route(request);
      if (!current()) return;
      // Serialize routing and dispatch, then release the queue. Chrome commands
      // can await page code indefinitely and must never delay revocation.
      const result = route.dispatch ? route.dispatch() : route.result;
      void respond(result).catch(report);
    } catch (error) {
      void respond(Promise.reject(error)).catch(report);
    }
  });
}

async function connect() {
  if (port) return;
  const connecting = epoch;
  await resetChrome();
  if (epoch !== connecting) return;
  revoking = false;
  const connection = chrome.runtime.connectNative(HOST);
  port = connection;
  connection.onMessage.addListener((message) => {
    if (message.kind === "revoking" && message.version === 2) {
      void schedule(() =>
        chrome.storage.session.set({ nativeStopExpected: true }),
      );
      return;
    }
    if (message.kind === "ready" && message.version === 2) {
      void schedule(async () => {
        await chrome.storage.local.set({ lastError: "" });
        await showAccess();
      });
      return;
    }
    if (message.kind === "reset") {
      void schedule(resetChrome);
      return;
    }
    if (message.kind === "activity") {
      const requested = epoch;
      void schedule(async () => {
        const { sessionId, label } = message;
        if (
          typeof sessionId !== "string" ||
          (label !== undefined &&
            (typeof label !== "string" || label.length > 64))
        )
          throw Error("Invalid native activity envelope");
        const { targets } = await cdp.targets.state();
        if (requested !== epoch || revoking || port !== connection) return;
        const target = Object.values(targets).find(
          (item) => item.pageSession === sessionId,
        );
        if (target)
          void activity.update(target.tabId, label).catch(reportActivity);
      });
      return;
    }
    if (
      message.kind !== "command" ||
      !Number.isSafeInteger(message.message?.id)
    ) {
      void schedule(async () => {
        throw Error("Invalid native command envelope");
      });
      return;
    }
    handleCommand(connection, message.message);
  });
  connection.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message;
    if (port !== connection) return;
    port = undefined;
    const disconnected = ++epoch;
    void schedule(async () => {
      await resetChrome();
      if (epoch === disconnected) revoking = false;
      const { nativeStopExpected = false } =
        await chrome.storage.session.get("nativeStopExpected");
      await chrome.storage.session.set({ nativeStopExpected: false });
      if (nativeStopExpected) {
        await chrome.storage.local.set({ lastError: "" });
        await showAccess();
      } else if (reason) await report(Error(reason));
    });
  });
  connection.postMessage({ kind: "hello", version: 2, activity: true });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const received = epoch;
  if (revoking || !port) return;
  if (!source.sessionId && method === "Page.domContentEventFired")
    void activity.navigated(source.tabId).catch(reportActivity);
  void cdp
    .event(source, method, params, (message) => {
      if (epoch === received && !revoking) send({ kind: "cdp", message });
    })
    .catch(report);
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (reason === "canceled_by_user") {
    revokeAccess(true);
    return;
  }
  void schedule(async () => {
    void activity.clear(source.tabId).catch(reportActivity);
    const state = await cdp.targets.state();
    if (state.targets[String(source.tabId)]) {
      await cdp.targets.remove(state, String(source.tabId), false);
      await cdp.targets.save(state);
    }
  });
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (
    change.url !== undefined ||
    change.title !== undefined ||
    change.status === "complete"
  )
    void schedule(() => cdp.targets.refresh());
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void activity.clear(tabId).catch(reportActivity);
  void schedule(async () => {
    const state = await cdp.targets.state();
    if (!state.targets[String(tabId)]) return;
    await cdp.targets.remove(state, String(tabId), false);
    await cdp.targets.save(state);
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.access) return;
  revokeAccess();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "native-reconnect") void schedule(connect);
});
chrome.runtime.onStartup.addListener(() => {
  void schedule(connect);
});
chrome.runtime.onInstalled.addListener(() => {
  void schedule(connect);
});
void schedule(async () => {
  await chrome.alarms.create("native-reconnect", { periodInMinutes: 0.5 });
  await connect();
});

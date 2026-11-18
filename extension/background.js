import { ExtensionCdp } from "./cdp.js";
import { accessPolicy } from "./access.js";

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
        await cdp.targets.reset();
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
  await cdp.targets.reset();
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
      void schedule(() => cdp.targets.reset());
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
      await cdp.targets.reset();
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
  connection.postMessage({ kind: "hello", version: 2 });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const received = epoch;
  if (revoking || !port) return;
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
    const state = await cdp.targets.state();
    if (state.targets[String(source.tabId)]) {
      await cdp.targets.remove(state, String(source.tabId), false);
      await cdp.targets.save(state);
    }
  });
});
chrome.tabs.onUpdated.addListener(() => {
  void schedule(() => cdp.targets.refresh());
});
chrome.tabs.onRemoved.addListener((tabId) => {
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

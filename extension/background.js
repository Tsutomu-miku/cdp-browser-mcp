import { ExtensionCdp } from "./cdp.js";
import { accessPolicy } from "./access.js";

const HOST = "io.github.tsutomu_miku.cdp_browser_mcp";
// Only live transport/serialization handles live in memory. Consent and CDP
// ownership live in storage; losing this worker invalidates the whole relay.
let port;
let serial = Promise.resolve();
const send = (message) => {
  if (port) port.postMessage(message);
};
const cdp = new ExtensionCdp(chrome, (message) =>
  send({ kind: "cdp", message }),
);

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

async function connect() {
  if (port) return;
  await cdp.targets.reset();
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
        await chrome.action.setBadgeText({
          text: (await accessPolicy(chrome)).paused ? "OFF" : "ON",
        });
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
    void schedule(async () => {
      const { id, sessionId } = message.message;
      try {
        const result = await cdp.command(message.message);
        send({ kind: "cdp", message: { id, result, sessionId } });
      } catch (error) {
        await chrome.storage.local.set({ lastError: error.message });
        send({
          kind: "cdp",
          message: {
            id,
            sessionId,
            error: { code: -32000, message: error.message },
          },
        });
      }
    });
  });
  connection.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message;
    if (port !== connection) return;
    port = undefined;
    void schedule(async () => {
      await cdp.targets.reset();
      const { nativeStopExpected = false } =
        await chrome.storage.session.get("nativeStopExpected");
      await chrome.storage.session.set({ nativeStopExpected: false });
      if (nativeStopExpected) {
        await chrome.storage.local.set({ lastError: "" });
        await chrome.action.setBadgeText({
          text: (await accessPolicy(chrome)).paused ? "OFF" : "ON",
        });
      } else if (reason) await report(Error(reason));
    });
  });
  connection.postMessage({ kind: "hello", version: 2 });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  void cdp.event(source, method, params).catch(report);
});
chrome.debugger.onDetach.addListener((source, reason) => {
  void schedule(async () => {
    const state = await cdp.targets.state();
    if (state.targets[String(source.tabId)]) {
      await cdp.targets.remove(state, String(source.tabId), false);
      await cdp.targets.save(state);
    }
    if (reason === "canceled_by_user") {
      const access = await accessPolicy(chrome);
      await chrome.storage.local.set({ access: { ...access, paused: true } });
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
  void schedule(async () => {
    await cdp.targets.reset(true);
    await cdp.targets.refresh();
    // Drop the official collector as well: revocation must invalidate cached data.
    send({ kind: "revoke" });
    await chrome.action.setBadgeText({
      text: changes.access.newValue.paused ? "OFF" : "ON",
    });
  });
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

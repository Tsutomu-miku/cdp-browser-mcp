import { test } from "node:test";
import assert from "node:assert/strict";
import { ExtensionCdp } from "../extension/cdp.js";
import { exactOrigins, permitted } from "../extension/access.js";

// Only the Chrome API is substituted. Routing, policy and stored state are real.
function chromeFixture() {
  const local = {
    access: {
      paused: false,
      origins: ["https://example.com"],
      blocked: [] as string[],
    },
  };
  const session: Record<string, any> = {};
  const sent: any[] = [],
    events: any[] = [];
  const tabs = [1, 2].map((id) => ({
    id,
    url: "https://example.com/page",
    title: `Page ${id}`,
    incognito: false,
  }));
  const api = {
    storage: {
      local: { get: async () => structuredClone(local) },
      session: {
        get: async () => structuredClone(session),
        set: async (value: unknown) => {
          Object.assign(session, structuredClone(value));
        },
      },
    },
    tabs: { query: async () => tabs },
    debugger: {
      getTargets: async () =>
        tabs.map((tab) => ({
          id: `target-${tab.id}`,
          tabId: tab.id,
          type: "page",
          title: tab.title,
          attached: true,
        })),
      attach: async (target: unknown) => {
        sent.push({ attach: target });
      },
      detach: async (target: unknown) => {
        sent.push({ detach: target });
      },
      sendCommand: async (source: unknown, method: string, params: unknown) => {
        sent.push({ source, method, params });
        return { sessionId: "same-child-id" };
      },
    },
  };
  return {
    router: new ExtensionCdp(api, (event: unknown) => events.push(event)),
    local,
    session,
    sent,
    events,
    tabs,
  };
}

test("exact-origin approval is paused by default; blocked and privileged origins never qualify", () => {
  assert.deepEqual(
    exactOrigins(
      "https://example.com\nhttp://localhost:3000 https://example.com",
    ),
    ["https://example.com", "http://localhost:3000"],
  );
  for (const origin of [
    "https://example.com/",
    "https://u:p@example.com",
    "file:///tmp",
    "https://example.com/path",
  ])
    assert.throws(() => exactOrigins(origin));
  assert.equal(
    permitted("chrome://settings", {
      paused: false,
      origins: ["null"],
      blocked: [],
    }),
    false,
  );
  assert.equal(
    permitted("https://example.com/private", {
      paused: true,
      origins: ["https://example.com"],
      blocked: [],
    }),
    false,
  );
  assert.equal(
    permitted("https://example.com/private", {
      paused: false,
      origins: ["https://example.com"],
      blocked: ["https://example.com"],
    }),
    false,
  );
});

test("browser close, cookie export and unapproved navigation never reach Chrome", async () => {
  const f = chromeFixture();
  for (const method of [
    "Browser.close",
    "Browser.crash",
    "Storage.getCookies",
    "Network.getAllCookies",
    "Network.getCookies",
    "Network.clearBrowserCookies",
    "Page.close",
  ])
    await assert.rejects(f.router.command({ method }), /Unavailable/);
  assert.deepEqual(f.sent, []);
  await f.router.command({
    method: "Target.setAutoAttach",
    params: { autoAttach: true, flatten: true },
  });
  const { pageSession } = f.session.bridge.targets["1"];
  const before = f.sent.length;
  await assert.rejects(
    f.router.command({
      method: "Page.navigate",
      params: { url: "https://bank.example/" },
      sessionId: pageSession,
    }),
    /not approved/,
  );
  assert.equal(f.sent.length, before);
});

test("flattened child IDs with identical native values remain scoped to their Chrome tab", async () => {
  const f = chromeFixture();
  await f.router.command({
    method: "Target.setAutoAttach",
    params: { autoAttach: true, flatten: true },
  });
  for (const tabId of [1, 2]) {
    await f.router.event({ tabId }, "Target.attachedToTarget", {
      sessionId: "same-child-id",
      targetInfo: { targetId: `worker-${tabId}`, type: "worker" },
    });
    await f.router.command({
      method: "Runtime.enable",
      sessionId: `${tabId}:same-child-id`,
    });
    assert.deepEqual(f.sent.at(-1).source, {
      tabId,
      sessionId: "same-child-id",
    });
  }
  assert.deepEqual(
    f.events
      .filter((event) => event.params?.targetInfo?.type === "worker")
      .map((event) => event.params.sessionId),
    ["1:same-child-id", "2:same-child-id"],
  );
  await f.router.command({
    method: "Target.detachFromTarget",
    params: { sessionId: "1:same-child-id" },
  });
  assert.deepEqual(f.sent.at(-1), {
    source: { tabId: 1 },
    method: "Target.detachFromTarget",
    params: { sessionId: "same-child-id" },
  });
});

test("leaving approved origins detaches and hides a daily tab without closing it", async () => {
  const f = chromeFixture();
  await f.router.command({
    method: "Target.setAutoAttach",
    params: { autoAttach: true, flatten: true },
  });
  f.tabs[0].url = "https://bank.example/";
  const result = await f.router.command({ method: "Target.getTargets" });
  assert.equal(
    result.targetInfos.some((target: any) => target.targetId === "target-1"),
    false,
  );
  assert.ok(f.sent.some((command) => command.detach?.tabId === 1));
  assert.equal(
    f.sent.some((command) => /close|remove/i.test(command.method ?? "")),
    false,
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { ExtensionCdp } from "../extension/cdp.js";
import { PageActivity } from "../extension/activity.js";
import { accessPolicy, exactOrigins, permitted } from "../extension/access.js";

// Only the Chrome API is substituted. Routing, policy and stored state are real.
function chromeFixture() {
  const local = {
    access: {
      paused: false,
      allSites: false,
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
      detach: async (target: { tabId: number }) => {
        sent.push({ detach: target });
      },
      sendCommand: async (source: unknown, method: string, params: unknown) => {
        sent.push({ source, method, params });
        return { sessionId: "same-child-id" };
      },
    },
  };
  const router = new ExtensionCdp(api, (event: unknown) => events.push(event));
  return {
    command: async (request: Parameters<typeof router.route>[0]) => {
      const route = await router.route(request);
      return route.dispatch ? await route.dispatch() : route.result;
    },
    router,
    api,
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
    "*",
    "https://*.example.com",
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

test("an existing saved allowlist retains its scope after upgrade", async () => {
  const access = {
    paused: false,
    origins: ["https://example.com"],
    blocked: [],
  };
  const policy = await accessPolicy({
    storage: { local: { get: async () => ({ access }) } },
  });
  assert.equal(policy.allSites, false);
  assert.equal(permitted("https://example.com/page", policy), true);
  assert.equal(permitted("https://other.example/page", policy), false);
});

test("activity rendering rejects an origin that changed during context creation", async () => {
  const f = chromeFixture();
  const [tab] = f.tabs;
  let renderRequests = 0;
  const activity = new PageActivity({
    ...f.api,
    tabs: { get: async () => tab },
    debugger: {
      sendCommand: async (
        _target: unknown,
        method: string,
        params: { expression: string },
      ) => {
        if (method === "Page.getFrameTree")
          return { frameTree: { frame: { id: "frame", url: tab.url } } };
        if (method === "Page.createIsolatedWorld")
          return { executionContextId: 1 };
        assert.equal(method, "Runtime.evaluate");
        renderRequests++;
        runInNewContext(params.expression, {
          origin: "https://other.example",
          get document() {
            throw Error("Activity attempted to access a different origin");
          },
        });
        return {};
      },
    },
  });
  await activity.update(tab.id, "agent");
  await activity.update(tab.id, undefined);
  assert.equal(renderRequests, 2, "New and cached contexts must check origin");
});

test("all-sites consent applies to discovery and navigation with blocklist and pause precedence", async () => {
  const f = chromeFixture();
  f.local.access.allSites = true;
  f.local.access.origins = [];
  f.local.access.blocked = ["https://hidden.example"];
  f.tabs[1].url = "https://hidden.example/page";
  f.tabs.push(
    { id: 3, url: "chrome://settings", title: "Settings", incognito: false },
    { id: 4, url: "https://example.org/", title: "Incognito", incognito: true },
  );
  await f.command({
    method: "Target.setAutoAttach",
    params: { autoAttach: true, flatten: true },
  });
  assert.deepEqual(Object.keys(f.session.bridge.targets), ["1"]);
  const { pageSession } = f.session.bridge.targets["1"];
  await f.command({
    method: "Page.navigate",
    params: { url: "http://unlisted.example/next" },
    sessionId: pageSession,
  });
  assert.equal(f.sent.at(-1).params.url, "http://unlisted.example/next");
  for (const url of ["https://hidden.example/page", "chrome://settings"])
    await assert.rejects(
      f.command({
        method: "Page.navigate",
        params: { url },
        sessionId: pageSession,
      }),
      /not approved/,
    );
  f.local.access.paused = true;
  assert.deepEqual(
    (await f.command({ method: "Target.getTargets" })).targetInfos,
    [],
  );
  assert.ok(f.sent.some((entry) => entry.detach?.tabId === 1));
});

test("all-sites discovery excludes a Chrome-protected target while keeping other tabs", async () => {
  const f = chromeFixture();
  f.local.access.allSites = true;
  f.tabs[0].url = "https://chromewebstore.google.com/";
  const attach = f.api.debugger.attach;
  f.api.debugger.attach = async (target: { tabId: number }) => {
    if (target.tabId === 1)
      throw Error("The extensions gallery cannot be scripted.");
    await attach(target);
  };
  await f.command({
    method: "Target.setAutoAttach",
    params: { autoAttach: true, flatten: true },
  });
  assert.deepEqual(Object.keys(f.session.bridge.targets), ["2"]);
  const result = await f.command({ method: "Target.getTargets" });
  assert.deepEqual(
    result.targetInfos.map(({ targetId }) => targetId),
    ["tab:target-2", "target-2"],
  );
});

test("revocation cleans up other sessions when Chrome closes a tab during detach", async () => {
  const f = chromeFixture();
  await f.command({
    method: "Target.setAutoAttach",
    params: { autoAttach: true, flatten: true },
  });
  const detach = f.api.debugger.detach;
  f.api.debugger.detach = async (target) => {
    if (target.tabId === 1) {
      f.tabs.shift(); // Chrome already removed this debugger with the tab.
      throw Error("No tab with given id 1.");
    }
    await detach(target);
  };
  await f.router.targets.reset();
  assert.ok(f.sent.some((entry) => entry.detach?.tabId === 2));
  assert.deepEqual(f.session.bridge.targets, {});
  assert.equal(f.session.bridge.autoAttach, false);
});

test("revocation surfaces an unexpected detach error after cleaning up the other sessions", async () => {
  const f = chromeFixture();
  await f.command({
    method: "Target.setAutoAttach",
    params: { autoAttach: true, flatten: true },
  });
  const detach = f.api.debugger.detach;
  f.api.debugger.detach = async (target) => {
    if (target.tabId === 1) throw Error("Debugger detach refused");
    await detach(target);
  };
  await assert.rejects(
    f.router.targets.reset(),
    (error) =>
      error instanceof AggregateError &&
      error.errors.some((item) => item.message === "Debugger detach refused"),
  );
  assert.deepEqual(Object.keys(f.session.bridge.targets), ["1"]);
  assert.ok(f.sent.some((entry) => entry.detach?.tabId === 2));
  assert.equal(f.session.bridge.autoAttach, false);
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
    await assert.rejects(f.command({ method }), /Unavailable/);
  assert.deepEqual(f.sent, []);
  await f.command({
    method: "Target.setAutoAttach",
    params: { autoAttach: true, flatten: true },
  });
  const { pageSession } = f.session.bridge.targets["1"];
  const before = f.sent.length;
  await assert.rejects(
    f.command({
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
  await f.command({
    method: "Target.setAutoAttach",
    params: { autoAttach: true, flatten: true },
  });
  for (const tabId of [1, 2]) {
    await f.router.event({ tabId }, "Target.attachedToTarget", {
      sessionId: "same-child-id",
      targetInfo: { targetId: `worker-${tabId}`, type: "worker" },
    });
    await f.command({
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
  await f.command({
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
  await f.command({
    method: "Target.setAutoAttach",
    params: { autoAttach: true, flatten: true },
  });
  f.tabs[0].url = "https://bank.example/";
  const result = await f.command({ method: "Target.getTargets" });
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

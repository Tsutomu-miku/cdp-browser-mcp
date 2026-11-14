import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  access,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Broker, rpc } from "../src/broker.js";
import { configSchema } from "../src/config.js";
import { ExtensionBackend } from "../src/extension-backend.js";
import { extensionSite } from "./extension-site.js";
const execute = promisify(execFile);
async function until<T>(
  read: () => Promise<T>,
  accept: (v: T) => boolean,
  description: string,
  timeout = 20000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await read();
    if (accept(v)) return v;
    await delay(100);
  }
  throw Error("Timed out: " + description);
}

test(
  "headed extension/native/MCP PoC in a fresh synthetic profile",
  { timeout: 120000 },
  async () => {
    const root = await mkdtemp(
      join(process.env.POC_TEST_ROOT || tmpdir(), "extension-poc-"),
    );
    // Native manifest is read from this custom browser user-data-dir, never a daily profile.
    const profile = join(root, "test-profile"),
      unpacked = join(root, "unpacked"),
      observerPath = join(root, "observer"),
      state = await mkdtemp("/tmp/cdp-ext-");
    const site = await extensionSite();
    const evidence = join("test-results", "extension-headed");
    await mkdir(evidence, { recursive: true });
    await execute(process.execPath, [
      "scripts/extension-setup.mjs",
      "prepare",
      "--output",
      unpacked,
      "--origins",
      JSON.stringify([site.base]),
    ]);
    await mkdir(observerPath);
    await writeFile(
      join(observerPath, "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Synthetic request attribution observer",
        version: "1.0",
        permissions: ["webRequest"],
        host_permissions: ["http://127.0.0.1/*"],
        background: { service_worker: "observer.js" },
      }),
    );
    await writeFile(
      join(observerPath, "observer.js"),
      "globalThis.requests=[];chrome.webRequest.onBeforeRequest.addListener(d=>requests.push({path:new URL(d.url).pathname,search:new URL(d.url).search,tabId:d.tabId,type:d.type,requestId:d.requestId}),{urls:['http://127.0.0.1/*']});",
    );
    const context = await chromium
      .launchPersistentContext(profile, {
        headless: false,
        executablePath: process.env.POC_CHROME_PATH,
        env: { ...process.env, CHROME_LOG_FILE: join(root, "chrome.log") },
        args: [
          "--enable-logging",
          `--disable-extensions-except=${unpacked},${observerPath}`,
          `--load-extension=${unpacked},${observerPath}`,
          "--enable-unsafe-extension-debugging",
        ],
        viewport: { width: 1100, height: 800 },
      })
      .catch(async (error) => {
        await site.close();
        throw error;
      });
    let broker: Broker | undefined, client: Client | undefined;
    try {
      const extensionWorker =
        context
          .serviceWorkers()
          .find((w) => w.url().endsWith("/background.js")) ||
        (await context.waitForEvent("serviceworker", {
          predicate: (w) => w.url().endsWith("/background.js"),
        }));
      const extensionId = new URL(extensionWorker.url()).host;
      const observer =
        context
          .serviceWorkers()
          .find((w) => w.url().endsWith("/observer.js")) ||
        (await context.waitForEvent("serviceworker", {
          predicate: (w) => w.url().endsWith("/observer.js"),
        }));
      await execute(process.execPath, [
        "scripts/extension-setup.mjs",
        "install-native",
        "--extension-id",
        extensionId,
        "--state-dir",
        state,
        "--browser-user-data-dir",
        profile,
      ]);
      const configFile = join(root, "config.json");
      const config = configSchema.parse({
        backend: "extension",
        extensionId,
        stateDir: state,
        actionTimeoutMs: 10000,
      });
      await writeFile(configFile, JSON.stringify(config));
      broker = new Broker(config);
      await broker.start();
      const ready = await until(
        async () => broker!.steward.health(),
        (v) => v.ready === true,
        "native connection",
      ).catch(async (error) => {
        console.error(await readFile(join(root, "chrome.log"), "utf8"));
        console.error(
          await extensionWorker.evaluate(
            () => (globalThis as any).nativeConnection,
          ),
        );
        throw error;
      });
      const backend = broker.steward as ExtensionBackend;
      assert.equal((await stat(state)).mode & 0o777, 0o700);
      for (const name of [
        "native.sock",
        "control.sock",
        "native.json",
        "admin.json",
      ])
        assert.equal((await stat(join(state, name))).mode & 0o777, 0o600, name);
      const page = context.pages()[0];
      await page.goto(site.base + "/login");
      await page.getByLabel("Username").fill("synthetic-user");
      await page.getByLabel("Password").fill("synthetic-password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL("**/private");
      assert.match(await page.innerText("body"), /Signed in as Synthetic User/);
      const beforeAttach = site.records.length;
      client = new Client({ name: "extension-poc-verifier", version: "1.0" });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            "dist/cli.js",
            "mcp",
            "--config",
            configFile,
            "--agent",
            "poc-agent",
          ],
          stderr: "pipe",
        }),
      );
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const response = await client!.callTool({ name, arguments: args });
        assert.ok(!response.isError, JSON.stringify(response));
        return JSON.parse((response.content as { text: string }[])[0].text);
      };
      const tools = (await client.listTools()).tools.map((t) => t.name);
      for (const name of [
        "browser_navigate",
        "browser_click",
        "browser_type",
        "browser_snapshot",
        "browser_extract",
        "browser_tabs",
        "browser_take_screenshot",
      ])
        assert.ok(tools.includes(name));
      const available = await call("browser_tabs", { action: "available" });
      const chromeTabId = available.find(
        (t: { url: string }) => t.url === site.base + "/private",
      ).id;
      const attached = await call("browser_tabs", {
        action: "attach",
        chromeTabId,
      });
      const loginText = await call("browser_extract");
      assert.match(loginText.text, /Signed in as Synthetic User/);
      const snapshot = await call("browser_snapshot");
      assert.match(snapshot.snapshot, /textbox.*Message/);
      const ref = snapshot.snapshot.match(/textbox.*\[ref=([^\]]+)\]/)[1];
      await call("browser_type", {
        ref,
        text: "Session reused; input via native bridge",
      });
      await call("browser_click", { selector: "#save" });
      assert.match(
        (await call("browser_extract", { selector: "#result" })).text,
        /Session reused/,
      );
      assert.equal(
        site.records.slice(beforeAttach).some((r) => r.path === "/session"),
        false,
        "MCP must not sign in again",
      );
      // Test harness alone grants Chrome's toolbar activeTab gesture. Backend never uses CDP.
      await page.bringToFront();
      const cdp = await context.browser()!.newBrowserCDPSession();
      const tabTargets = await cdp.send("Target.getTargets", {
        filter: [{ type: "tab", exclude: false }],
      });
      await cdp.send("Extensions.triggerAction", {
        id: extensionId,
        targetId: tabTargets.targetInfos.find((t) => t.url === page.url())!
          .targetId,
      });
      const shot = await client.callTool({
        name: "browser_take_screenshot",
        arguments: {},
      });
      assert.ok(!shot.isError, JSON.stringify(shot));
      const image = (shot.content as { type: string; data: string }[]).find(
        (c) => c.type === "image",
      )!;
      assert.ok(image);
      await writeFile(
        join(evidence, "session-reuse.jpg"),
        Buffer.from(image.data, "base64"),
      );
      const a = await call("browser_tabs", {
        action: "new",
        headers: { "x-lane": "blue", "x-poc": "alpha" },
      });
      await call("browser_navigate", { url: site.base + "/probe?tag=A" });
      const b = await call("browser_tabs", {
        action: "new",
        headers: { "x-lane": "green", "x-poc": "beta" },
      });
      await call("browser_navigate", { url: site.base + "/probe?tag=B" });
      await until(
        async () => site.records.filter((r) => r.kind === "dedicated-fetch"),
        (v) => v.length === 2,
        "dedicated worker requests",
      );
      for (const [tag, lane, custom] of [
        ["A", "blue", "alpha"],
        ["B", "green", "beta"],
      ]) {
        const requests = site.records.filter((r) => r.tag === tag);
        assert.ok(requests.length >= 10);
        for (const request of requests) {
          assert.equal(request.lane, lane, JSON.stringify(request));
          assert.equal(request.custom, custom);
          assert.equal(request.loggedIn, true);
        }
      }
      await call("browser_tabs", {
        action: "headers",
        headers: { "x-lane": "amber" },
      });
      await call("browser_navigate", { url: site.base + "/echo?tag=changed" });
      assert.equal(
        site.records.find((r) => r.tag === "changed")!.lane,
        "amber",
      );
      assert.equal(site.records.find((r) => r.tag === "changed")!.custom, null);
      await call("browser_tabs", { action: "headers", headers: {} });
      await call("browser_navigate", { url: site.base + "/echo?tag=removed" });
      assert.equal(site.records.find((r) => r.tag === "removed")!.lane, null);
      await call("browser_tabs", {
        action: "headers",
        headers: { "x-lane": "green" },
      });
      await call("browser_navigate", { url: site.base + "/workers?tag=B" });
      await until(
        async () => call("browser_extract", { selector: "#worker-result" }),
        (v) => v.text.includes('"ready":true'),
        "worker completion",
      );
      await call("browser_tabs", { action: "select", tabId: a.tabId });
      await call("browser_navigate", { url: site.base + "/workers?tag=A" });
      await until(
        async () => call("browser_extract", { selector: "#worker-result" }),
        (v) => v.text.includes('"ready":true'),
        "second worker completion",
      );
      await observer.evaluate(async (base) => {
        await fetch(base + "/echo?kind=extension-background&tag=observer");
      }, site.base);
      const attribution = await observer.evaluate(
        () => (globalThis as any).requests,
      );
      const workers = site.records.filter((r) =>
        [
          "sw-background",
          "sw-forwarded",
          "shared-background",
          "extension-background",
        ].includes(r.kind || ""),
      );
      for (const r of workers) assert.equal(r.lane, null, JSON.stringify(r));
      assert.ok(workers.some((r) => r.kind === "shared-background"));
      assert.ok(workers.some((r) => r.kind === "sw-background"));
      for (const r of attribution.filter(
        (r: any) =>
          r.path === "/echo" &&
          /kind=(sw-background|sw-forwarded|shared-background|extension-background)/.test(
            r.search,
          ),
      ))
        assert.equal(r.tabId, -1, JSON.stringify(r));
      assert.equal(
        site.records.some((r) => r.path === "/sw-cache"),
        false,
        "SW synthetic response never reaches the server",
      );
      const beforeKill = backend.health();
      process.kill(beforeKill.hostPid as number, "SIGKILL");
      const recovered = await until(
        async () => backend.health(),
        (v) =>
          v.ready === true &&
          v.hostPid !== beforeKill.hostPid &&
          Number(v.generation) > Number(beforeKill.generation),
        "native host auto-reconnect",
      );
      await call("browser_navigate", {
        url: site.base + "/echo?tag=after-reconnect",
      });
      assert.equal(
        site.records.find((r) => r.tag === "after-reconnect")!.lane,
        "blue",
      );
      const beforeTimeout = backend.health();
      const timedOut = await client.callTool({
        name: "browser_navigate",
        arguments: { url: site.base + "/stall" },
      });
      assert.equal(timedOut.isError, true);
      const afterTimeout = await until(
        async () => backend.health(),
        (v) =>
          v.ready === true &&
          Number(v.generation) > Number(beforeTimeout.generation),
        "automatic recovery after an action/health timeout",
      );
      assert.equal(
        site.records.filter((r) => r.path === "/stall").length,
        1,
        "mutating navigation must never be replayed",
      );
      await call("browser_navigate", {
        url: site.base + "/echo?tag=after-timeout",
      });
      assert.equal(
        site.records.find((r) => r.tag === "after-timeout")!.lane,
        "blue",
      );
      // MV3 globals/timers can disappear. The durable alarm must wake a fresh
      // extension worker and restore broker-owned leases without storage duplication.
      const beforeWorkerRestart = backend.health();
      const targets = await cdp.send("Target.getTargets");
      const extensionTarget = targets.targetInfos.find(
        (t) => t.type === "service_worker" && t.url === extensionWorker.url(),
      )!;
      assert.ok(extensionTarget, "Extension worker target is present");
      await cdp.send("Target.closeTarget", {
        targetId: extensionTarget.targetId,
      });
      const afterWorkerRestart = await until(
        async () => backend.health(),
        (v) =>
          v.ready === true &&
          Number(v.generation) > Number(beforeWorkerRestart.generation),
        "alarm recovery after forced MV3 worker termination",
        45000,
      );
      await call("browser_navigate", {
        url: site.base + "/echo?tag=after-worker-restart",
      });
      assert.equal(
        site.records.find((r) => r.tag === "after-worker-restart")!.lane,
        "blue",
      );
      const rulesBefore = await backend.bridge.call("health");
      const liveA = context
        .pages()
        .find((p) => p.url().includes("tag=after-worker-restart"))!;
      await liveA.close();
      await until(
        async () => backend.bridge.call("health"),
        (v) => !v.rules.some((r: any) => r.tabIds.includes(a.chromeTabId)),
        "closed-tab DNR cleanup",
      );
      const afterClose = await backend.bridge.call("health");
      // Explicit origin rejection and exclusive tab ownership are public boundary contracts.
      await assert.rejects(
        rpc(broker.admin, "attach", {
          agentId: "other",
          chromeTabId,
          headers: {},
          lane: "default",
        }),
        /already has a lease/,
      );
      await call("browser_tabs", { action: "select", tabId: attached.tabId });
      const denied = await client.callTool({
        name: "browser_navigate",
        arguments: { url: "https://example.com" },
      });
      assert.equal(denied.isError, true);
      await client.close();
      client = undefined;
      assert.equal(
        page.isClosed(),
        false,
        "unregister must preserve a user's attached tab",
      );
      const report = {
        testedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        browserVersion: context.browser()?.version(),
        headed: true,
        independentProfile: true,
        loginMethod:
          "Synthetic page form submitted by Playwright before MCP attach; no real account or human login claimed",
        backendControl:
          "MCP -> broker -> Unix native bridge -> standard Chrome native messaging -> own MV3 extension; CDP used only by test harness",
        loginReused: true,
        perTabHeaderIsolation: true,
        dynamicHeaderReplacementAndRemoval: true,
        tabCloseRuleCleanup: true,
        activeTabScreenshot: true,
        permissions: { directory: "0700", sockets: "0600", tokens: "0600" },
        nativeBefore: beforeKill,
        nativeAfter: recovered,
        timeoutBefore: beforeTimeout,
        timeoutAfter: afterTimeout,
        timeoutRecovered: true,
        workerRestartBefore: beforeWorkerRestart,
        workerRestartAfter: afterWorkerRestart,
        workerRestartRecovered: true,
        timedOutNavigationRequests: 1,
        initialHealth: ready,
        rulesBeforeClose: rulesBefore,
        rulesAfterClose: afterClose,
        workerBoundary:
          "ServiceWorker forwarded/background, SharedWorker and extension background requests observed with tabId=-1 and no injected lane header. No global rule.",
        multiLaneSupport:
          "Diagnostic two-tab experiment only; extension mode is single-lane, CDP is required for parallel lanes",
        requests: site.records,
        attribution,
      };
      await writeFile(
        join(evidence, "report.json"),
        JSON.stringify(report, null, 2) + "\n",
      );
    } finally {
      const cleanup = await Promise.allSettled([
        client?.close(),
        broker?.stop(),
      ]);
      await context.close();
      await site.close();
      for (const result of cleanup)
        if (result.status === "rejected") throw result.reason;
      // Retain synthetic test profile for inspection; it is never a daily profile.
      await writeFile(
        join(evidence, "local-inspection.txt"),
        `Synthetic test artifacts: ${root}\nLocal bridge state: ${state}\n`,
      );
    }
  },
);

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  access,
  writeFile,
  mkdir,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { configSchema } from "../src/config.js";
import { Broker, rpc } from "../src/broker.js";
import { syntheticSite } from "./site.js";
async function until(check: () => boolean | Promise<boolean>, message: string) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(100);
  }
  throw Error(message);
}
test(
  "two concurrent MCP clients: shared login, every request lane, worker block, leases, downloads, reconnect",
  { timeout: 90000 },
  async () => {
    const root = await mkdtemp("/tmp/steward-e2e-");
    const site = await syntheticSite();
    const config = configSchema.parse({
      stateDir: root,
      executablePath:
        process.env.CHROME_PATH ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      cdpPort: 0,
      headless: !process.env.STEWARD_HEADED,
      leaseMs: 10000,
      lanes: {
        default: {},
        blue: { "x-lane": "A", "x-environment": "blue" },
        green: { "x-lane": "B", "x-environment": "green" },
      },
    });
    const broker = new Broker(config);
    const clients: Client[] = [],
      transports: StdioClientTransport[] = [];
    let rawA: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined,
      rawB: typeof rawA;
    const checkpoints: Record<string, unknown> = {};
    try {
      await broker.start();
      rawA = await chromium.connectOverCDP(broker.steward.chrome.endpoint!, {
        noDefaults: true,
      });
      rawB = await chromium.connectOverCDP(broker.steward.chrome.endpoint!, {
        noDefaults: true,
      });
      for (const id of ["A", "B"]) {
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [
            "dist/cli.js",
            "mcp",
            "--state-dir",
            root,
            "--agent",
            id,
            "--lane",
            id === "A" ? "blue" : "green",
          ],
          stderr: "pipe",
        });
        const client = new Client({ name: "test-" + id, version: "1.0.0" });
        await client.connect(transport);
        clients.push(client);
        transports.push(transport);
      }
      async function tool(
        i: number,
        name: string,
        args: Record<string, unknown> = {},
      ) {
        const r = await clients[i].callTool({ name, arguments: args });
        assert.ok(!r.isError, JSON.stringify(r));
        const content = r.content as { type: string; text: string }[];
        return JSON.parse(content[0].text);
      }
      await tool(0, "browser_navigate", { url: site.base + "/login" });
      const cookies = await broker.steward.context!.cookies();
      assert.equal(
        cookies.find((c) => c.name === "identity")?.value,
        "synthetic-shared-login",
      );
      checkpoints.cookieSharedAcrossMCPClients = true;
      assert.deepEqual(
        await rawA.contexts()[0].cookies(),
        await rawB.contexts()[0].cookies(),
      );
      checkpoints.cookieSharedAcrossIndependentCDPClients = true;
      await Promise.all([
        tool(0, "browser_navigate", { url: site.base + "/page?a=A" }),
        tool(1, "browser_navigate", { url: site.base + "/page?a=B" }),
      ]);
      const tabs = broker.steward.list();
      assert.equal(tabs.length, 2);
      const ta = tabs.find((t) => t.agentId === "A")!,
        tb = tabs.find((t) => t.agentId === "B")!;
      const pa = broker.steward.tabs.get(ta.tabId)!.page,
        pb = broker.steward.tabs.get(tb.tabId)!.page;
      assert.equal(
        await pa.evaluate(() => document.cookie),
        "identity=synthetic-shared-login",
      );
      assert.equal(
        await pb.evaluate(() => document.cookie),
        "identity=synthetic-shared-login",
      );
      await Promise.all([
        pa.evaluate(() => (window as any).done),
        pb.evaluate(() => (window as any).done),
      ]);
      await Promise.all([
        tool(0, "browser_type", { selector: "#name", text: "Alice" }),
        tool(1, "browser_type", { selector: "#name", text: "Bob" }),
      ]);
      const snapshots = await Promise.all([
        tool(0, "browser_snapshot"),
        tool(1, "browser_snapshot"),
      ]);
      for (let i = 0; i < 2; i++) {
        const ref = snapshots[i].snapshot.match(
          /button "Apply" \[ref=([^\]]+)\]/,
        )?.[1];
        assert.ok(ref, snapshots[i].snapshot);
        await tool(i, "browser_click", { element: "Apply", ref });
      }
      const values = await Promise.all([
        tool(0, "browser_extract", { selector: "#value" }),
        tool(1, "browser_extract", { selector: "#value" }),
      ]);
      assert.deepEqual(
        values.map((v) => v.text),
        ["Alice", "Bob"],
      );
      checkpoints.independentOperations = [
        "navigate",
        "type",
        "snapshot",
        "click by ref",
        "extract",
        "download",
        "navigation",
      ];
      await assert.rejects(
        rpc(broker.admin, "action", {
          agentId: "A",
          tabId: tb.tabId,
          action: "snapshot",
        }),
        /belongs to another/,
      );
      const { token } = await rpc(broker.admin, "register", {
        agentId: "outsider",
      });
      await assert.rejects(
        rpc(broker.admin, "status", {}, token),
        /Agent scope|unauthorized/i,
      );
      await rpc(broker.admin, "unregister", {}, token);
      checkpoints.crossAgentDenied = true;
      await Promise.all([
        tool(0, "browser_click", { selector: "#download" }),
        pb
          .frames()
          .find(
            (f) =>
              f.parentFrame() &&
              f.url().startsWith(site.base.replace("127.0.0.1", "localhost")),
          )!
          .locator("#frame-download")
          .click(),
      ]);
      await until(
        () => broker.steward.downloads!.completed.length === 2,
        "downloads not distributed",
      );
      const downloads = broker.steward.downloads!.completed;
      for (const d of downloads) {
        assert.ok(d.path.includes(`/agents/${d.agentId}/${d.tabId}/`));
        assert.equal(
          await readFile(d.path, "utf8"),
          "private download for " + d.agentId,
        );
      }
      assert.notEqual(downloads[0].path, downloads[1].path);
      assert.equal((await tool(0, "browser_downloads")).length, 1);
      assert.equal((await tool(1, "browser_downloads")).length, 1);
      checkpoints.downloads = downloads.map((d) => ({
        agentId: d.agentId,
        source: d.agentId === "B" ? "cross-origin iframe" : "main-frame",
        relativePath: d.path.slice(root.length + 1),
      }));
      for (const p of [pa, pb]) {
        assert.equal(await p.evaluate(() => (window as any).swBlocked), true);
        assert.equal(
          await p.evaluate(() => (window as any).sharedBlocked),
          true,
        );
      }
      assert.equal(
        site.records.filter((r) =>
          ["/sw", "/shared", "/forbidden-background"].includes(r.path),
        ).length,
        0,
      );
      await Promise.all([
        tool(0, "browser_click", { selector: "#next" }),
        tool(1, "browser_click", { selector: "#next" }),
      ]);
      const expected = [
        "/page",
        "/style",
        "/script",
        "/image",
        "/fetch",
        "/xhr",
        "/beacon",
        "/iframe",
        "/iframe-fetch",
        "/worker",
        "/worker-fetch",
        "/nested-worker",
        "/nested-fetch",
        "/iframe-worker",
        "/iframe-worker-fetch",
        "/navigation",
        "/download",
      ];
      for (const agent of ["A", "B"])
        for (const path of expected)
          assert.ok(
            site.records.some((r) => r.agent === agent && r.path === path),
            `missing ${agent} ${path}`,
          );
      for (const r of site.records.filter((r) => r.agent)) {
        assert.equal(r.lane, r.agent, JSON.stringify(r));
        assert.equal(r.environment, r.agent === "A" ? "blue" : "green");
      }
      checkpoints.allRequestTypesVerified = expected;
      checkpoints.workerPolicy = {
        shared: "disabled at Chrome launch",
        service: "registration script and all SW-owned requests aborted",
        forbiddenRequestsReceived: 0,
      };
      // Native tab close must release mappings and CDP sessions.
      await pa.close();
      await until(
        () => !broker.steward.tabs.has(ta.tabId),
        "native close leaked tab",
      );
      assert.ok(
        ![...broker.steward.downloads!.frameOwners.values()].some(
          (o) => o.tabId === ta.tabId,
        ),
      );
      assert.ok(!broker.steward.downloads!.sessions.has(ta.tabId));
      checkpoints.nativeCloseRecycled = true;
      await tool(1, "browser_close");
      assert.equal(broker.steward.tabs.size, 0);
      // Lease expiry uses the public behavior; crashed clients do not keep a tab alive.
      const lease = await rpc(broker.admin, "open", {
        agentId: "expired",
        lane: "blue",
      });
      await until(
        () => !broker.steward.tabs.has(lease.tabId),
        "expired lease leaked",
      );
      checkpoints.leaseExpiryRecycled = true;
      const oldPid = broker.steward.chrome.child!.pid;
      const old = await rpc(broker.admin, "open", {
        agentId: "A",
        lane: "blue",
      });
      // Simulate genuine CDP transport loss, not a navigation or stubbed health check.
      await broker.steward.browser!.close();
      await until(
        () =>
          broker.steward.health().ready &&
          broker.steward.chrome.child?.pid !== oldPid,
        "browser did not recover",
      );
      assert.equal(broker.steward.tabs.size, 0);
      await assert.rejects(
        rpc(broker.admin, "action", {
          agentId: "A",
          tabId: old.tabId,
          action: "snapshot",
        }),
      );
      assert.equal(
        (await rpc(broker.admin, "downloads", { agentId: "A" })).length,
        1,
      );
      const fresh = await rpc(broker.admin, "open", {
        agentId: "A",
        lane: "blue",
      });
      await rpc(broker.admin, "action", {
        agentId: "A",
        tabId: fresh.tabId,
        action: "navigate",
        args: { url: site.base + "/navigation?a=A" },
      });
      checkpoints.reconnect = {
        ready: true,
        oldLeasesInvalidated: true,
        newPid: true,
        cookieRetained: !!(await broker.steward.context!.cookies()).find(
          (c) => c.name === "identity",
        ),
      };
      assert.equal((checkpoints.reconnect as any).cookieRetained, true);
      await rpc(broker.admin, "close", { agentId: "A", tabId: fresh.tabId });
      // Guard transitions reject work and return to service only when the budget permits it.
      const limit = broker.config.maxDownloadBytes;
      broker.config.maxDownloadBytes = 1;
      await broker.steward.sweep();
      await assert.rejects(
        rpc(broker.admin, "open", { agentId: "disk", lane: "default" }),
        /Disk guard/,
      );
      broker.config.maxDownloadBytes = limit;
      await broker.steward.sweep();
      checkpoints.diskGuard = true;
      const log = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      assert.ok(
        log.some(
          (e) =>
            e.event === "request.blocked" &&
            e.reason === "shared-or-service-worker",
        ),
      );
      assert.ok(
        log
          .filter((e) => e.event === "request.routed")
          .every((e) => e.headerHit),
      );
      const mode = config.headless ? "headless" : "headed";
      await mkdir("evidence", { recursive: true });
      await writeFile(
        `evidence/concurrent-${mode}.json`,
        JSON.stringify(
          {
            testedAt: new Date().toISOString(),
            platform: process.platform,
            chrome: broker.steward.browser!.version(),
            playwright: "1.65.1",
            mode: config.headless ? "headless=new" : "headed",
            site: "synthetic loopback; fixed test identity",
            checkpoints,
            requests: site.records,
            events: log
              .map(({ time, ...e }) => e)
              .filter((e) => !["chrome.started"].includes(e.event)),
          },
          null,
          2,
        ),
      );
    } catch (e) {
      console.log("debug tabs", broker.steward.list());
      console.log(
        "debug log",
        (await readFile(join(root, "events.jsonl"), "utf8")).slice(-9000),
      );
      throw e;
    } finally {
      await Promise.allSettled(clients.map((c) => c.close()));
      await rawA?.close();
      await rawB?.close();
      await broker.stop();
      await site.close();
      assert.ok(!broker.steward.chrome.child);
      assert.equal(broker.steward.tabs.size, 0);
      await assert.rejects(readFile(join(root, "admin.json")));
      await assert.rejects(access(join(root, "control.sock")));
      await rm(root, { recursive: true, force: true });
    }
  },
);

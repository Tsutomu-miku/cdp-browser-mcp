import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readAdmin } from "../src/broker.js";
const execute = promisify(execFile);
// Browser.close can close CDP before macOS finishes process teardown.
async function assertExited(pid: number) {
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return;
    }
    await delay(100);
  }
  assert.fail("managed process did not exit: " + pid);
}
test(
  "CLI detached launch, permissions, reuse and stop leave no supervisor or socket",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp("/tmp/steward-cli-"),
      file = join(root, "config.json");
    await writeFile(
      file,
      JSON.stringify({
        stateDir: root,
        cdpPort: 0,
        headless: !process.env.STEWARD_HEADED,
        executablePath: process.env.CHROME_PATH,
      }),
    );
    const cli = async (command: string) =>
      JSON.parse(
        (
          await execute(
            process.execPath,
            ["dist/cli.js", command, "--config", file, "--json"],
            { timeout: 20000 },
          )
        ).stdout,
      );
    let stopped = false;
    try {
      const first = await cli("launch");
      assert.equal(first.ready, true);
      let admin = await readAdmin(root);
      assert.equal((await stat(admin.socket)).mode & 0o777, 0o600);
      assert.equal((await stat(join(root, "admin.json"))).mode & 0o777, 0o600);
      assert.equal((await stat(root)).mode & 0o777, 0o700);
      const second = await cli("launch");
      assert.equal(second.alreadyRunning, true);
      assert.equal((await readAdmin(root)).pid, admin.pid);
      assert.equal((await cli("status")).connected, true);
      const log = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      let launched = log.find((e) => e.event === "chrome.started");
      assert.ok(launched.endpoint.startsWith("http://127.0.0.1:"));
      const orphanPid = launched.pid;
      process.kill(admin.pid, "SIGKILL");
      await delay(200);
      const recovered = await cli("launch");
      assert.equal(recovered.ready, true);
      admin = await readAdmin(root);
      const recoveredLog = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      assert.ok(recoveredLog.some((e) => e.event === "chrome.orphan-closed"));
      launched = recoveredLog
        .filter((e) => e.event === "chrome.started")
        .at(-1);
      assert.notEqual(launched.pid, orphanPid);
      await assertExited(orphanPid);
      const stop = await cli("stop");
      assert.equal(stop.stopping, true);
      for (let i = 0; i < 100; i++) {
        try {
          await access(join(root, "admin.json"));
          await delay(100);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          stopped = true;
          break;
        }
      }
      assert.ok(stopped, "supervisor failed to stop");
      await assert.rejects(access(admin.socket));
      await assert.rejects(access(join(root, "lock")));
      for (const pid of [launched.pid, admin.pid]) {
        await assertExited(pid);
      }
      await mkdir("test-results", { recursive: true });
      await writeFile(
        "test-results/cli-lifecycle.json",
        JSON.stringify(
          {
            testedAt: new Date().toISOString(),
            dedicatedChrome: true,
            cdpLoopback: true,
            detachedLaunch: true,
            reusedExistingSupervisor: true,
            recoveredKilledSupervisor: true,
            orphanChromeClosed: true,
            socketMode: "0600",
            stateDirMode: "0700",
            adminMode: "0600",
            chromeStopped: true,
            supervisorStopped: true,
            socketRemoved: true,
            lockRemoved: true,
          },
          null,
          2,
        ),
      );
    } finally {
      if (!stopped) {
        try {
          await cli("stop");
        } catch (e) {
          console.error("CLI test cleanup failed", String(e));
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "two first-run MCP clients start one browser without a config file and keep their header defaults",
  { timeout: 45000 },
  async () => {
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const { StdioClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/stdio.js"
    );
    const { syntheticSite } = await import("./site.js");
    const { rpc } = await import("../src/broker.js");
    const root = await mkdtemp("/tmp/cdp-mcp-start-");
    const site = await syntheticSite();
    const clients = ["A", "B"].map(
      (id) => new Client({ name: "cold-start-" + id, version: "1.0.0" }),
    );
    const cli = async (command: string, ...args: string[]) =>
      execute(
        process.execPath,
        ["dist/cli.js", command, "--state-dir", root, ...args],
        { timeout: 20000 },
      );
    try {
      assert.match((await cli("status")).stdout, /not running/);
      const transports = ["A", "B"].map(
        (id) =>
          new StdioClientTransport({
            command: process.execPath,
            args: [
              "dist/cli.js",
              "mcp",
              "--state-dir",
              root,
              "--agent",
              id,
              "--header-domains",
              '["127.0.0.1","localhost"]',
              "--headers",
              JSON.stringify({ "x-lane": id }),
              process.env.STEWARD_HEADED ? "--headed" : "--headless",
              ...(process.env.CHROME_PATH
                ? ["--executable-path", process.env.CHROME_PATH]
                : []),
            ],
            stderr: "pipe",
          }),
      );
      await Promise.all(
        clients.map((client, i) => client.connect(transports[i])),
      );
      const admin = await readAdmin(root);
      const call = async (
        index: number,
        name: string,
        args: Record<string, unknown> = {},
      ) => {
        const result = await clients[index].callTool({ name, arguments: args });
        assert.ok(!result.isError, JSON.stringify(result));
        return JSON.parse((result.content as { text: string }[])[0].text);
      };
      await call(0, "browser_navigate", { url: site.base + "/login" });
      await Promise.all(
        [0, 1].map((i) =>
          call(i, "browser_navigate", {
            url: site.base + "/navigation?a=" + (i === 0 ? "A" : "B"),
          }),
        ),
      );
      for (const id of ["A", "B"]) {
        const request = site.records.find(
          (r) => r.path === "/navigation" && r.agent === id,
        )!;
        assert.equal(request.lane, id);
        assert.equal(request.identity, "identity=synthetic-shared-login");
      }
      await call(0, "browser_tabs", { action: "new" });
      await call(0, "browser_navigate", { url: site.base + "/navigation?a=A" });
      assert.equal(
        site.records.filter((r) => r.agent === "A").at(-1)!.lane,
        "A",
      );
      await call(0, "browser_tabs", {
        action: "new",
        headers: { "x-lane": "custom" },
      });
      await call(0, "browser_navigate", { url: site.base + "/navigation?a=C" });
      assert.equal(site.records.find((r) => r.agent === "C")!.lane, "custom");
      const status = JSON.parse((await cli("status", "--json")).stdout);
      assert.equal(status.agents.length, 2);
      assert.equal(status.tabs.length, 4);
      assert.match((await cli("status")).stdout, /AGENT\s+TAB\s+LANE\s+URL/);
      const events = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      assert.equal(
        events.filter((e) => e.event === "chrome.started").length,
        1,
      );
      await clients[0].close();
      assert.equal((await rpc(admin, "status")).agents.length, 1);
      await call(1, "browser_extract");
      await clients[1].close();
      assert.equal((await rpc(admin, "status")).tabs.length, 0);
      assert.equal((await rpc(admin, "health")).ready, true);
      const manual = JSON.parse(
        (await cli("open", site.base + "/login", "--json")).stdout,
      );
      assert.equal(manual.agentId, "manual");
      await cli("close", "--agent", "manual", "--tab", manual.tabId);
      await mkdir("test-results", { recursive: true });
      await writeFile(
        `test-results/mcp-startup-${process.env.STEWARD_HEADED ? "headed" : "headless"}.json`,
        JSON.stringify(
          {
            mode: process.env.STEWARD_HEADED ? "headed" : "headless=new",
            concurrentClients: 2,
            browserStarts: 1,
            configFileRequired: false,
            sharedCookie: true,
            clientHeadersInheritedByNewTabs: true,
            perTabHeaderOverride: true,
            otherClientSurvivedDisconnect: true,
            browserRemainedRunning: true,
            requests: site.records,
          },
          null,
          2,
        ),
      );
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await cli("stop");
      for (let i = 0; i < 100; i++) {
        try {
          await access(join(root, "admin.json"));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
          throw e;
        }
        await delay(100);
      }
      await site.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

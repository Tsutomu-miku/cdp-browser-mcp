import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { syntheticSite } from "./site.js";

const execute = promisify(execFile);

test(
  "terminal skill: independent CLI invocations retain owned tabs, shared login, isolated headers and downloads",
  { timeout: 90000 },
  async () => {
    const root = await mkdtemp("/tmp/cdp-skill-");
    const site = await syntheticSite();
    const mode = process.env.STEWARD_HEADED ? "headed" : "headless";
    const raw = (command: string, ...args: string[]) =>
      execute(
        process.execPath,
        ["dist/cli.js", command, "--state-dir", root, ...args],
        { timeout: 20000 },
      );
    const cli = async (command: string, ...args: string[]) =>
      JSON.parse((await raw(command, ...args, "--json")).stdout);
    const scope = (agentId: string, tabId?: string) => [
      "--agent",
      agentId,
      ...(tabId ? ["--tab", tabId] : []),
    ];
    try {
      // Invalid requests fail before starting a browser or acquiring any tab.
      await assert.rejects(raw("snapshot"), /--agent is required/);
      await assert.rejects(raw("snapshot", ...scope("A")), /--tab is required/);
      await assert.rejects(
        raw("type", ...scope("A", "unused"), "--selector", "#name"),
        /type requires --text/,
      );
      assert.equal((await cli("status")).running, false);

      const tabs = await Promise.all(
        ["A", "B"].map((id) =>
          cli(
            "open",
            ...scope(id),
            "--headers",
            JSON.stringify({ "x-lane": id }),
            mode === "headed" ? "--headed" : "--headless",
            ...(process.env.CHROME_PATH
              ? ["--executable-path", process.env.CHROME_PATH]
              : []),
          ),
        ),
      );
      assert.notEqual(tabs[0].tabId, tabs[1].tabId);
      await cli("navigate", site.base + "/login", ...scope("A", tabs[0].tabId));
      await Promise.all(
        tabs.map((tab, i) =>
          cli(
            "navigate",
            site.base + "/page?a=" + tab.agentId,
            ...scope(tab.agentId, tabs[i].tabId),
          ),
        ),
      );
      const expected = ["Alice", "Bob"];
      await Promise.all(
        tabs.map(async (tab, i) => {
          const own = scope(tab.agentId, tab.tabId);
          await cli("type", "--selector", "#name", "--text", "", ...own);
          const snapshot = await cli("snapshot", ...own);
          const inputRef = snapshot.snapshot.match(
            /textbox "Name".*?\[ref=([^\]]+)\]/,
          )?.[1];
          assert.ok(inputRef, snapshot.snapshot);
          await cli("type", "--ref", inputRef, "--text", expected[i], ...own);
          const latest = await cli("snapshot", ...own);
          const buttonRef = latest.snapshot.match(
            /button "Apply" \[ref=([^\]]+)\]/,
          )?.[1];
          assert.ok(buttonRef, latest.snapshot);
          await cli("click", "--ref", buttonRef, ...own);
          assert.deepEqual(
            await cli("extract", "--selector", "#value", ...own),
            {
              text: expected[i],
            },
          );
          assert.equal((await cli("tabs", ...scope(tab.agentId))).length, 1);
          assert.match(
            (await raw("snapshot", ...own)).stdout,
            /button "Apply"/,
          );
          await cli("click", "--selector", "#download", ...own);
        }),
      );
      const files = await Promise.all(
        tabs.map(async (tab) => {
          for (let i = 0; i < 50; i++) {
            const files = await cli("downloads", ...scope(tab.agentId));
            if (files.length) {
              assert.equal(files.length, 1);
              assert.equal(files[0].agentId, tab.agentId);
              assert.match(
                files[0].path,
                new RegExp(`/agents/${tab.agentId}/${tab.tabId}/`),
              );
              assert.equal(
                await readFile(files[0].path, "utf8"),
                "private download for " + tab.agentId,
              );
              return files[0];
            }
            await delay(100);
          }
          throw Error("Download did not complete for " + tab.agentId);
        }),
      );
      assert.notEqual(files[0].path, files[1].path);
      await assert.rejects(
        cli("snapshot", ...scope("A", tabs[1].tabId)),
        /belongs to another/,
      );
      const tagged = site.records.filter(
        (r) => r.agent === "A" || r.agent === "B",
      );
      assert.ok(tagged.length >= 40);
      for (const request of tagged) {
        assert.equal(request.lane, request.agent, JSON.stringify(request));
        // The localhost iframe is cross-origin; its host-only cookie is distinct.
        if (request.path === "/page")
          assert.equal(request.identity, "identity=synthetic-shared-login");
      }
      assert.ok(
        !site.records.some((r) =>
          ["/sw", "/shared", "/forbidden-background"].includes(r.path),
        ),
      );
      await cli("reclaim", ...scope("A"));
      assert.deepEqual(await cli("tabs", ...scope("A")), []);
      assert.match(
        (await cli("snapshot", ...scope("B", tabs[1].tabId))).snapshot,
        /Bob/,
      );
      await cli("reclaim", ...scope("B"));
      assert.deepEqual(await cli("tabs", ...scope("B")), []);
      const status = await cli("status");
      assert.equal(status.ready, true);
      assert.equal(status.tabs.length, 0);
      assert.equal(
        status.agents.length,
        0,
        "terminal calls must not leak MCP registrations",
      );
      const events = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      assert.equal(
        events.filter((e) => e.event === "chrome.started").length,
        1,
      );
      await mkdir("test-results", { recursive: true });
      await writeFile(
        `test-results/skill-cli-${mode}.json`,
        JSON.stringify(
          {
            testedAt: new Date().toISOString(),
            mode: mode === "headless" ? "headless=new" : mode,
            platform: process.platform,
            site: "synthetic loopback; no real accounts",
            entry: "CLI, no MCP client or browser extension",
            concurrentExecutions: 2,
            browserStarts: 1,
            sharedCookie: true,
            independentActions: true,
            crossAgentTabDenied: true,
            sharedAndServiceWorkersBlocked: true,
            scopedDownloads: true,
            ownReclaimPreservedOtherExecution: true,
            remainingTabs: 0,
            remainingMcpRegistrations: 0,
            headerMismatches: 0,
            requests: site.records,
          },
          null,
          2,
        ),
      );
    } finally {
      await cli("stop");
      let stopped = false;
      for (let i = 0; i < 100; i++) {
        try {
          await access(join(root, "admin.json"));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          stopped = true;
          break;
        }
        await delay(100);
      }
      await site.close();
      assert.ok(stopped, "browser service did not stop");
      await rm(root, { recursive: true, force: true });
    }
  },
);

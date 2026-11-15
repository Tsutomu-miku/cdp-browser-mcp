import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { configSchema } from "../src/config.js";
import { Broker, rpc } from "../src/broker.js";
import { syntheticSite } from "./site.js";

test(
  "official server coexistence: domain allowlist across redirects, iframes and classic/module/nested workers",
  { timeout: 90000 },
  async () => {
    const root = await mkdtemp("/tmp/cdp-policy-");
    const site = await syntheticSite();
    const broker = new Broker(
      configSchema.parse({
        stateDir: root,
        executablePath: process.env.CHROME_PATH,
        headless: !process.env.STEWARD_HEADED,
        headerDomains: ["127.0.0.1"],
      }),
    );
    let raw: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    try {
      await broker.start();
      raw = await chromium.connectOverCDP(broker.steward.chrome.endpoint!, {
        noDefaults: true,
      });
      const tabs = await Promise.all(
        ["A", "B"].map((agentId) =>
          rpc(broker.admin, "open", {
            agentId,
            headers: { "x-lane": agentId },
          }),
        ),
      );
      const action = (
        i: number,
        name: string,
        args: Record<string, unknown> = {},
      ) =>
        rpc(broker.admin, "action", {
          agentId: tabs[i].agentId,
          tabId: tabs[i].tabId,
          action: name,
          args,
        });
      await Promise.all(
        tabs.map((tab, i) =>
          action(i, "navigate", {
            url: site.base + "/policy?a=" + tab.agentId,
          }),
        ),
      );
      for (const tab of tabs) {
        const page = raw
          .contexts()[0]
          .pages()
          .find((p) => p.url() === site.base + "/policy?a=" + tab.agentId)!;
        await page.evaluate(() => (window as any).done);
        await page.waitForFunction(
          () => document.querySelector("iframe")?.contentWindow !== null,
        );
      }
      const expected = [
        "/policy",
        "/policy-fetch",
        "/policy-xhr",
        "/policy-beacon",
        "/policy-frame",
        "/policy-frame-fetch",
        "/policy-worker",
        "/policy-worker-fetch",
        "/policy-import",
        "/policy-module",
        "/policy-module-fetch",
        "/policy-nested",
        "/policy-nested-fetch",
        "/policy-frame-worker",
        "/policy-frame-worker-fetch",
        "/redirect-out",
        "/redirect-in",
        "/policy-echo",
        "/redirect-import",
      ];
      for (const agent of ["A", "B"])
        for (const path of expected)
          assert.ok(
            site.records.some((r) => r.agent === agent && r.path === path),
            `Missing ${agent} ${path}`,
          );
      const tagged = site.records.filter(
        (r) => r.agent === "A" || r.agent === "B",
      );
      for (const r of tagged)
        assert.equal(
          r.lane,
          r.host === "127.0.0.1" ? r.agent : undefined,
          JSON.stringify(r),
        );
      assert.notEqual(tabs[0].pageId, tabs[1].pageId);
      const diagnostics = await Promise.all([
        action(0, "devtools", { name: "list_console_messages", arguments: {} }),
        action(1, "devtools", { name: "list_network_requests", arguments: {} }),
      ]);
      assert.match(JSON.stringify(diagnostics[0]), /owned-console-A/);
      assert.doesNotMatch(JSON.stringify(diagnostics[0]), /owned-console-B/);
      assert.match(JSON.stringify(diagnostics[1]), /policy\?a=B/);
      assert.doesNotMatch(JSON.stringify(diagnostics[1]), /policy\?a=A/);
      await assert.rejects(
        action(0, "devtools", {
          name: "emulate",
          arguments: { extraHttpHeaders: '{"x-lane":"leak"}' },
        }),
        /Only owned-page diagnostics/,
      );
      await assert.rejects(
        action(0, "devtools", {
          name: "take_screenshot",
          arguments: { pageId: tabs[1].pageId },
        }),
        /pageId is assigned/,
      );
      await mkdir("test-results", { recursive: true });
      await writeFile(
        `test-results/allowlist-${process.env.STEWARD_HEADED ? "headed" : "headless"}.json`,
        JSON.stringify(
          {
            platform: process.platform,
            chrome: raw.version(),
            official: "1.13.0",
            headerDomains: ["127.0.0.1"],
            insideRequests: tagged.filter((r) => r.host === "127.0.0.1").length,
            outsideRequests: tagged.filter((r) => r.host === "localhost")
              .length,
            headerMismatches: 0,
            expected,
            requests: tagged,
          },
          null,
          2,
        ),
      );
    } finally {
      await raw?.close();
      await broker.stop();
      await site.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

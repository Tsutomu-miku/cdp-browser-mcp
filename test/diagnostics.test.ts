import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Broker, rpc } from "../src/broker.js";
import { configSchema } from "../src/config.js";
import { syntheticSite } from "./site.js";

test(
  "owned official diagnostics: screenshot, Lighthouse, trace and trace ownership",
  { timeout: 90000 },
  async () => {
    const root = await mkdtemp("/tmp/cdp-diagnostics-"),
      site = await syntheticSite();
    const broker = new Broker(
      configSchema.parse({
        stateDir: root,
        headless: !process.env.STEWARD_HEADED,
        executablePath: process.env.CHROME_PATH,
      }),
    );
    try {
      await broker.start();
      const tabs = await Promise.all(
        ["A", "B"].map((agentId) => rpc(broker.admin, "open", { agentId })),
      );
      const action = (
        i: number,
        action: string,
        args: Record<string, unknown>,
      ) =>
        rpc(broker.admin, "action", {
          agentId: tabs[i].agentId,
          tabId: tabs[i].tabId,
          action,
          args,
        });
      const diagnostic = (
        i: number,
        name: string,
        args: Record<string, unknown> = {},
      ) => action(i, "devtools", { name, arguments: args });
      await Promise.all(
        tabs.map((t, i) =>
          action(i, "navigate", {
            url: site.base + "/navigation?a=" + t.agentId,
          }),
        ),
      );
      const image = await diagnostic(0, "take_screenshot");
      assert.ok(
        image.content.some(
          (c: any) =>
            c.type === "image" && Buffer.from(c.data, "base64").length > 100,
        ),
      );
      const lighthouse = await diagnostic(0, "lighthouse_audit", {
        mode: "snapshot",
        outputDirPath: join(root, "audit"),
      });
      assert.doesNotMatch(JSON.stringify(lighthouse), /"isError":true/);
      assert.ok((await stat(join(root, "audit"))).isDirectory());
      const trace = await diagnostic(0, "performance_start_trace", {
        reload: true,
        autoStop: true,
        filePath: join(root, "trace.json.gz"),
      });
      assert.ok((await stat(join(root, "trace.json.gz"))).size > 100);
      await assert.rejects(
        diagnostic(1, "performance_analyze_insight", {
          insightSetId: "wrong-tab",
          insightName: "LCPBreakdown",
        }),
        /belongs to another tab/,
      );
      await assert.rejects(
        diagnostic(0, "performance_start_trace", { autoStop: false }),
        /autoStop/,
      );
      await mkdir("test-results", { recursive: true });
      await writeFile(
        `test-results/diagnostics-${process.env.STEWARD_HEADED ? "headed" : "headless"}.json`,
        JSON.stringify(
          {
            platform: process.platform,
            official: "1.13.0",
            screenshot: true,
            lighthouseSnapshot: true,
            trace: true,
            traceOwnership: true,
            lighthouse: lighthouse.content,
            trace: trace.content,
          },
          null,
          2,
        ),
      );
    } finally {
      await broker.stop();
      await site.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

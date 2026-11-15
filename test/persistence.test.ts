import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Broker, rpc } from "../src/broker.js";
import { configSchema } from "../src/config.js";
import { syntheticSite } from "./site.js";

test(
  "persistent shared login and storage survive service restart; official server loss recovers without replay",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp("/tmp/cdp-persist-"),
      site = await syntheticSite();
    const config = configSchema.parse({
      stateDir: root,
      executablePath: process.env.CHROME_PATH,
      headless: !process.env.STEWARD_HEADED,
    });
    let broker = new Broker(config);
    const open = () => rpc(broker.admin, "open", { agentId: "login" });
    const navigate = (tabId: string, path: string) =>
      rpc(broker.admin, "action", {
        agentId: "login",
        tabId,
        action: "navigate",
        args: { url: site.base + path },
      });
    const extract = (tabId: string) =>
      rpc(broker.admin, "action", {
        agentId: "login",
        tabId,
        action: "extract",
      });
    try {
      await broker.start();
      let tab = await open();
      await navigate(tab.tabId, "/persistent-login");
      await navigate(tab.tabId, "/persistent-private");
      assert.match(
        (await extract(tab.tabId)).text,
        /Signed in storage=shared-profile/,
      );
      await broker.stop();
      broker = new Broker(config);
      await broker.start();
      tab = await open();
      await navigate(tab.tabId, "/persistent-private");
      assert.match(
        (await extract(tab.tabId)).text,
        /Signed in storage=shared-profile/,
      );
      const oldChrome = broker.steward.chrome.child!.pid,
        oldOfficial = broker.steward.devtools!.transport!.pid!;
      process.kill(oldOfficial, "SIGKILL");
      let recovered = false;
      for (let i = 0; i < 200; i++) {
        if (
          broker.steward.health().ready &&
          broker.steward.chrome.child?.pid !== oldChrome
        ) {
          recovered = true;
          break;
        }
        await delay(100);
      }
      assert.ok(recovered, "official process loss did not recover");
      await assert.rejects(extract(tab.tabId), /absent/);
      tab = await open();
      await navigate(tab.tabId, "/persistent-private");
      assert.match(
        (await extract(tab.tabId)).text,
        /Signed in storage=shared-profile/,
      );
      assert.equal(
        site.records.filter((r) => r.path === "/persistent-login").length,
        1,
        "login action was replayed",
      );
      await mkdir("test-results", { recursive: true });
      await writeFile(
        `test-results/persistence-${process.env.STEWARD_HEADED ? "headed" : "headless"}.json`,
        JSON.stringify(
          {
            platform: process.platform,
            official: "1.13.0",
            persistentCookie: true,
            localStorage: true,
            serviceRestart: true,
            officialProcessKillRecovery: true,
            oldLeasesInvalidated: true,
            loginRequests: 1,
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

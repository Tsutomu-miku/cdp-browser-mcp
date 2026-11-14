import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
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
        executablePath:
          process.env.CHROME_PATH ||
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }),
    );
    const cli = async (command: string) =>
      JSON.parse(
        (
          await execute(
            process.execPath,
            ["dist/cli.js", command, "--config", file],
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
      assert.throws(() => process.kill(orphanPid, 0));
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
        let gone = false;
        for (let i = 0; i < 50; i++) {
          try {
            process.kill(pid, 0);
            await delay(100);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
            gone = true;
            break;
          }
        }
        assert.ok(gone, "managed process did not exit: " + pid);
      }
      await writeFile(
        "evidence/cli-lifecycle.json",
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

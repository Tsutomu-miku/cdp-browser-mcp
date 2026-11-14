import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { configSchema } from "../src/config.js";
import { NativeBridge } from "../src/native-bridge.js";
const extensionId = "a".repeat(32);
const frame = (value: unknown) => {
  const body = Buffer.from(JSON.stringify(value)),
    header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};

test(
  "native executable validates caller, handles fragmented frames and bounds input",
  { timeout: 10000 },
  async () => {
    const root = await mkdtemp("/tmp/native-frame-");
    const launch = (origin: string) =>
      spawn(
        process.execPath,
        [
          "dist/native-host.js",
          "--state-dir",
          root,
          "--extension-id",
          extensionId,
          origin,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
    try {
      const denied = launch(`chrome-extension://${"b".repeat(32)}/`);
      let deniedOutput = "";
      denied.stdout.on("data", (d) => (deniedOutput += d));
      assert.equal((await once(denied, "exit"))[0], 1);
      assert.equal(deniedOutput, "");
      const host = launch(`chrome-extension://${extensionId}/`);
      try {
        const reply = new Promise<Buffer>((resolve) => {
          let output = Buffer.alloc(0);
          host.stdout.on("data", (d) => {
            output = Buffer.concat([output, d]);
            if (
              output.length >= 4 &&
              output.length >= output.readUInt32LE(0) + 4
            )
              resolve(output);
          });
        });
        const ping = frame({ kind: "ping", version: 1 });
        host.stdin.write(ping.subarray(0, 2));
        host.stdin.write(ping.subarray(2, 7));
        host.stdin.write(ping.subarray(7));
        const bytes = await reply;
        assert.equal(bytes.readUInt32LE(0), bytes.length - 4);
        assert.deepEqual(JSON.parse(bytes.subarray(4).toString()), {
          kind: "pong",
          version: 1,
        });
        const oversized = Buffer.alloc(4);
        oversized.writeUInt32LE(8 * 1024 * 1024 + 1);
        host.stdin.write(oversized);
        assert.equal((await once(host, "exit"))[0], 1);
      } finally {
        if (host.exitCode === null) host.kill("SIGKILL");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "native bridge rejects an unauthenticated socket and accepts a subsequent authenticated session",
  { timeout: 10000 },
  async () => {
    const root = await mkdtemp("/tmp/native-auth-");
    const bridge = new NativeBridge(
      configSchema.parse({ backend: "extension", stateDir: root, extensionId }),
      () => {},
      async () => {},
    );
    await bridge.start();
    try {
      const identity = JSON.parse(
        await readFile(join(root, "native.json"), "utf8"),
      );
      const bad = connect(identity.socket);
      bad.on("error", () => {});
      bad.write(
        JSON.stringify({
          kind: "hello",
          version: 1,
          extensionId,
          token: "invalid",
          pid: process.pid,
        }) + "\n",
      );
      await once(bad, "close");
      assert.equal(bridge.ready, false);
      const good = connect(identity.socket);
      good.on("error", () => {});
      let buffer = "";
      good.setEncoding("utf8");
      good.on("data", (d) => {
        buffer += d;
        const end = buffer.indexOf("\n");
        if (end >= 0) {
          const request = JSON.parse(buffer.slice(0, end));
          good.write(
            JSON.stringify({
              kind: "response",
              id: request.id,
              result: { healthy: true },
            }) + "\n",
          );
          buffer = buffer.slice(end + 1);
        }
      });
      good.write(
        JSON.stringify({
          kind: "hello",
          version: 1,
          extensionId,
          token: identity.token,
          pid: process.pid,
        }) + "\n",
      );
      await bridge.waitReady();
      assert.deepEqual(await bridge.call("health"), { healthy: true });
      good.destroy();
    } finally {
      await bridge.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("rejected native manifest reinstall leaves the original launcher and manifest unchanged", async () => {
  const { execFile } = await import("node:child_process"),
    { promisify } = await import("node:util");
  const execute = promisify(execFile),
    root = await mkdtemp("/tmp/native-install-");
  const state = join(root, "state"),
    profile = join(root, "test-profile");
  const install = (id: string) =>
    execute(process.execPath, [
      "scripts/extension-setup.mjs",
      "install-native",
      "--extension-id",
      id,
      "--state-dir",
      state,
      "--browser-user-data-dir",
      profile,
    ]);
  try {
    const first = JSON.parse((await install(extensionId)).stdout);
    const before = [
      await readFile(first.launcher),
      await readFile(first.manifestPath),
    ];
    await assert.rejects(install("b".repeat(32)), /EEXIST/);
    assert.deepEqual(
      [await readFile(first.launcher), await readFile(first.manifestPath)],
      before,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

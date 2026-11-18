import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, endianness } from "node:os";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import { NativeChannel } from "../src/extension/native-channel.js";
import { reserveState, readRelay } from "../src/extension/state.js";
import { startRelay } from "../src/extension/relay.js";
import { Audit } from "../src/extension/audit.js";
import { runSelectedMode } from "../src/cli-mode.js";
import { RelayClient } from "../src/extension/client.js";
import { ExtensionTools } from "../src/extension/tools.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execute = promisify(execFile);

test("closing during initial tool discovery prevents a late upstream process", async (t) => {
  const start = t.mock.method(
    StdioClientTransport.prototype,
    "start",
    async () => {
      throw Error("Stopped relay tried to start a subprocess");
    },
  );
  const tools = new ExtensionTools(
    "ws://127.0.0.1:1/cdp",
    "test",
    new Audit(tmpdir()),
    (error) => {
      throw error;
    },
  );
  const discovery = tools.list();
  await tools.close();
  await assert.rejects(discovery, /Extension backend is stopping/);
  assert.equal(start.mock.callCount(), 0);
});

test("ending an MCP session during relay discovery must not open a late orphan socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "extension-cancel-"));
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  let connected = 0;
  server.on("connection", () => {
    connected++;
  });
  const client = new RelayClient(directory);
  try {
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await writeFile(
      join(directory, "relay.json"),
      JSON.stringify({
        pid: process.pid,
        token: "a".repeat(64),
        endpoint: `ws://127.0.0.1:${port}/mcp`,
      }),
      { mode: 0o600 },
    );
    const pending = client.call("tools/list");
    client.close();
    await assert.rejects(pending, /ended|not connected/);
    assert.equal(
      connected,
      0,
      "EOF during discovery must not leave a new WebSocket behind",
    );
  } finally {
    client.close();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "native host consumes an immediate hello and EOF removes only its own relay state",
  { timeout: 10000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "extension-host-"));
    const child = spawn(
      process.execPath,
      [
        "dist/extension/host.js",
        "--state-dir",
        directory,
        "--extension-id",
        "a".repeat(32),
        `chrome-extension://${"a".repeat(32)}/`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    const exited = once(child, "exit");
    try {
      const ready = new Promise<void>((resolve, reject) => {
        let input = Buffer.alloc(0);
        child.stdout.on("data", (chunk) => {
          input = Buffer.concat([input, chunk]);
          if (input.length < 4) return;
          const length =
            endianness() === "LE" ? input.readUInt32LE() : input.readUInt32BE();
          if (input.length < length + 4) return;
          try {
            assert.deepEqual(
              JSON.parse(String(input.subarray(4, length + 4))),
              { kind: "ready", version: 2 },
            );
            resolve();
          } catch (error) {
            reject(error);
          }
        });
        child.once("exit", () => reject(Error(stderr)));
      });
      const body = Buffer.from(JSON.stringify({ kind: "hello", version: 2 }));
      const header = Buffer.alloc(4);
      if (endianness() === "LE") header.writeUInt32LE(body.length);
      else header.writeUInt32BE(body.length);
      child.stdin.write(Buffer.concat([header, body]));
      await ready;
      assert.equal((await readRelay(directory)).pid, child.pid);
      child.stdin.end();
      assert.deepEqual(await exited, [0, null], stderr);
      for (const name of ["relay.json", "host.lock"])
        await assert.rejects(stat(join(directory, name)), { code: "ENOENT" });
    } finally {
      child.kill();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("extension mode rejects isolated/attach options before any browser work", async () => {
  await assert.rejects(
    runSelectedMode("launch", { mode: "extension" }),
    /mcp only/,
  );
  await assert.rejects(
    runSelectedMode("mcp", { mode: "extension" }),
    /requires --state-dir/,
  );
  for (const option of [
    "agent",
    "tab",
    "lane",
    "headers",
    "header-domains",
    "config",
    "headless",
    "headed",
    "channel",
    "executable-path",
    "attach-timeout-ms",
  ])
    await assert.rejects(
      runSelectedMode("mcp", { mode: "extension", [option]: "x" }),
      /unavailable in extension/,
    );
});

test("MCP initialization works without a host and discovery fails actionably without launching Chrome or writing state", async () => {
  const root = await mkdtemp(join(tmpdir(), "extension-offline-"));
  const directory = join(root, "not-installed");
  const client = new Client({ name: "offline-contract", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          "dist/cli.js",
          "mcp",
          "--mode",
          "extension",
          "--state-dir",
          directory,
        ],
        stderr: "pipe",
      }),
    );
    await assert.rejects(client.listTools(), /relay unavailable/);
    await assert.rejects(stat(directory), { code: "ENOENT" });
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("native framing accepts split frames and rejects oversize/invalid JSON", () => {
  const input = new PassThrough(),
    output = new PassThrough();
  const channel = new NativeChannel(input, output);
  const values: unknown[] = [],
    failures: Error[] = [],
    chunks: Buffer[] = [];
  channel.on("message", (value) => values.push(value));
  channel.on("failure", (error) => failures.push(error));
  output.on("data", (bytes) => chunks.push(bytes));
  channel.send({ kind: "hello", version: 2 });
  const frame = Buffer.concat(chunks);
  input.write(frame.subarray(0, 2));
  input.write(frame.subarray(2, 7));
  input.write(frame.subarray(7));
  assert.deepEqual(values, [{ kind: "hello", version: 2 }]);
  assert.throws(() => channel.send({ text: "x".repeat(1024 * 1024) }), /1 MiB/);
  const invalid = Buffer.alloc(4);
  if (endianness() === "LE") invalid.writeUInt32LE(33 * 1024 * 1024);
  else invalid.writeUInt32BE(33 * 1024 * 1024);
  input.write(invalid);
  assert.match(failures[0].message, /frame length/);
});

test("native host identity is exclusive, private, and never points off loopback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "extension-state-"));
  let lock: Awaited<ReturnType<typeof reserveState>> | undefined;
  try {
    lock = await reserveState(directory);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(lock.path)).mode & 0o777, 0o600);
    await assert.rejects(reserveState(directory), /already owns/);
    await writeFile(
      lock.path,
      JSON.stringify({
        pid: process.pid,
        endpoint: "ws://example.com/mcp",
        token: "a".repeat(64),
      }),
    );
    await assert.rejects(readRelay(directory), /relay unavailable/);
    assert.equal(
      JSON.parse(await readFile(lock.path, "utf8")).pid,
      process.pid,
    );
  } finally {
    await lock?.handle.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("relay refuses unauthenticated/CDP/browser-origin peers without browser work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "extension-relay-"));
  const channel = new NativeChannel(new PassThrough(), new PassThrough());
  const relay = await startRelay(channel, new Audit(directory));
  try {
    for (const [endpoint, headers] of [
      [relay.endpoint, {}],
      [
        relay.endpoint,
        {
          Authorization: `Bearer ${relay.token}`,
          Origin: "https://example.com",
        },
      ],
      [
        relay.endpoint.replace("/mcp", "/cdp"),
        { Authorization: `Bearer ${relay.token}` },
      ],
    ] as const) {
      const peer = new WebSocket(endpoint, { headers });
      await assert.rejects(
        new Promise<void>((resolve, reject) => {
          peer.once("open", resolve);
          peer.once("error", reject);
        }),
        /403/,
      );
    }
  } finally {
    await relay.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer reserves manifests and launchers without overwriting an existing installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "extension-install-"));
  const args = [
    "dist/extension/setup.js",
    "install-native",
    "--extension-id",
    "a".repeat(32),
    "--state-dir",
    join(root, "state"),
    "--browser-user-data-dir",
    join(root, "profile"),
  ];
  try {
    const installed = JSON.parse(
      (await execute(process.execPath, args)).stdout,
    );
    const before = await readFile(installed.manifestPath);
    assert.deepEqual(JSON.parse(String(before)).allowed_origins, [
      `chrome-extension://${"a".repeat(32)}/`,
    ]);
    assert.equal((await stat(installed.launcher)).mode & 0o777, 0o700);
    await assert.rejects(execute(process.execPath, args), /EEXIST/);
    assert.deepEqual(await readFile(installed.manifestPath), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

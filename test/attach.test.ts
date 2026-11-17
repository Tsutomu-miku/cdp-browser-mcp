import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { attachArgs } from "../src/attach/connection.js";
import { attachOptionsSchema } from "../src/attach/options.js";
import { runSelectedMode } from "../src/cli-mode.js";

const execute = promisify(execFile);
const fixture = "test/fixtures/attach-process.ts";

test("attach args use installed 1.13.0 autoConnect/channel and never launch or target loopback Chrome", async () => {
  const help = (
    await execute(process.execPath, [
      "node_modules/chrome-devtools-mcp/out/Default/gen/src/bin/chrome-devtools-mcp.js",
      "--help",
    ])
  ).stdout;
  for (const channel of ["stable", "beta", "dev", "canary"]) {
    const args = attachArgs(attachOptionsSchema.parse({ channel }));
    assert.equal(args.includes("--autoConnect"), true);
    assert.equal(args[args.indexOf("--channel") + 1], channel);
    for (const flag of args.filter((arg) => arg.startsWith("--")))
      assert.ok(help.includes(flag), flag);
    assert.doesNotMatch(
      args.join(" "),
      /browserUrl|127\.0\.0\.1|headless|userDataDir|workspace|executablePath|autoConnectPort/,
    );
  }
  assert.equal(attachOptionsSchema.parse({}).channel, "stable");
});

test("isolated stays default; attach rejects unsupported commands/options before any browser work", async () => {
  assert.equal(await runSelectedMode("mcp", {}), false);
  assert.equal(await runSelectedMode("mcp", { mode: "isolated" }), false);
  await assert.rejects(runSelectedMode("mcp", { mode: "unknown" }));
  await assert.rejects(
    runSelectedMode("mcp", { channel: "beta" }),
    /require --mode attach/,
  );
  await assert.rejects(
    runSelectedMode("launch", { mode: "attach" }),
    /mcp only/,
  );
  for (const key of [
    "agent",
    "tab",
    "lane",
    "headers",
    "header-domains",
    "config",
    "state-dir",
    "headless",
    "headed",
    "executable-path",
  ]) {
    await assert.rejects(
      runSelectedMode("mcp", { mode: "attach", [key]: "value" }),
      /unavailable in attach mode/,
    );
  }
  for (const args of [
    ["--channel", "nightly"],
    ["--attach-timeout-ms", "0"],
  ])
    await assert.rejects(
      execute(process.execPath, [
        "dist/cli.js",
        "mcp",
        "--mode=attach",
        ...args,
      ]),
      /Error|error/,
    );
});

for (const scenario of ["stopped", "old", "disabled", "denied", "pending"]) {
  test(
    `attach ${scenario}: fail closed with actionable guidance and no connected claim`,
    { timeout: 15000 },
    async () => {
      await assert.rejects(
        execute(
          process.execPath,
          ["--import", "tsx", fixture, "host", scenario],
          { timeout: 12000 },
        ),
        (error: unknown) => {
          const result = error as { code: number; stderr: string };
          assert.equal(result.code, 1);
          assert.match(result.stderr, /waiting-for-authorization/);
          assert.match(result.stderr, /未连接或未授权/);
          assert.match(
            result.stderr,
            {
              stopped: /Cause: ECONNREFUSED/,
              old: /Cause: Chrome\/143/,
              disabled: /Cause: ENOENT DevToolsActivePort/,
              denied: /Cause: WebSocket connection closed/,
              pending: /Request timed out/,
            }[scenario]!,
          );
          assert.match(result.stderr, /Chrome 144\+/);
          assert.match(result.stderr, /chrome:\/\/inspect\/#remote-debugging/);
          assert.match(result.stderr, /Allow \/ 允许/);
          assert.doesNotMatch(result.stderr, /"state":"connected"/);
          const pid = Number(
            result.stderr.match(/"fakeUpstreamPid":(\d+)/)?.[1],
          );
          assert.ok(pid > 0);
          assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
          return true;
        },
      );
    },
  );
}

test(
  "attach relays official schemas/results/errors; EOF closes the subprocess",
  { timeout: 15000 },
  async () => {
    const client = new Client({ name: "attach-contract", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", fixture, "host", "ready"],
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr!.on("data", (data) => {
      stderr += String(data);
    });
    try {
      await client.connect(transport);
      assert.match(client.getInstructions()!, /no agent\/tab leases/);
      const tools = (await client.listTools()).tools;
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ["list_pages", "page_echo", "tool_error", "disconnect"],
      );
      const echo = tools.find((tool) => tool.name === "page_echo")!;
      assert.deepEqual(echo.inputSchema.required, ["pageId", "text"]);
      assert.ok(echo.outputSchema);
      assert.equal(echo.annotations!.readOnlyHint, true);
      const args = { pageId: 37, text: "daily profile" };
      const result = await client.callTool({
        name: "page_echo",
        arguments: args,
      });
      assert.deepEqual(result.structuredContent, args);
      assert.deepEqual(result._meta, { fixture: true });
      const failure = await client.callTool({ name: "tool_error" });
      assert.equal(failure.isError, true);
      assert.deepEqual(failure.content, [
        { type: "text", text: "Official operation failed" },
      ]);
      assert.match(stderr, /"state":"connected"/);
    } finally {
      await client.close();
    }
    const pid = Number(stderr.match(/"fakeUpstreamPid":(\d+)/)?.[1]);
    assert.ok(pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  },
);

test(
  "upstream death ends attach instead of reporting a usable session",
  { timeout: 15000 },
  async () => {
    const client = new Client({ name: "attach-disconnect", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", fixture, "host", "ready"],
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr!.on("data", (data) => {
      stderr += String(data);
    });
    try {
      await client.connect(transport);
      await assert.rejects(client.callTool({ name: "disconnect" }));
    } finally {
      await client.close();
    }
    assert.match(stderr, /Official server disconnected/);
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(
    `attach ${signal} while authorization is pending closes only the subprocess`,
    { timeout: 15000 },
    async () => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", fixture, "host", "pending"],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stderr = "";
      const closed = once(child, "close");
      try {
        await new Promise<void>((resolve, reject) => {
          child.stderr.on("data", (data) => {
            stderr += String(data);
            if (/"fakeUpstreamPid":\d+/.test(stderr)) resolve();
          });
          child.once("error", reject);
          child.once("close", () =>
            reject(Error("Attach exited before signal test")),
          );
        });
        child.kill(signal);
        const [code] = await closed;
        assert.equal(code, 0, stderr);
        assert.doesNotMatch(stderr, /"state":"connected"/);
        const pid = Number(stderr.match(/"fakeUpstreamPid":(\d+)/)?.[1]);
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    },
  );
}

const initialize = Buffer.from(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 101,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "预授权 client", version: "1.0.0" },
    },
  }) + "\n",
);

for (const bufferedInput of [false, true]) {
  test(
    `stdin EOF during pending authorization exits promptly (${bufferedInput ? "buffered initialize" : "empty pipe"})`,
    { timeout: 15000 },
    async () => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", fixture, "host", "pending-eof"],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const closed = once(child, "close");
      let stderr = "";
      try {
        await new Promise<void>((resolve, reject) => {
          child.stderr.on("data", (data) => {
            stderr += String(data);
            if (/"authorizationPending":true/.test(stderr)) resolve();
          });
          child.once("error", reject);
          child.once("close", () =>
            reject(Error("Attach exited before the pending approval probe")),
          );
        });
        const promptClose = once(child, "close", {
          signal: AbortSignal.timeout(5000),
        });
        child.stdin.end(bufferedInput ? initialize : undefined);
        const [code, signal] = await promptClose;
        assert.equal(code, 0, stderr);
        assert.equal(signal, null);
        assert.doesNotMatch(stderr, /Request timed out|"state":"connected"/);
        const pid = Number(stderr.match(/"fakeUpstreamPid":(\d+)/)?.[1]);
        assert.ok(pid > 0);
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGTERM");
        await closed;
      }
    },
  );
}

test(
  "MCP initialize bytes sent before approval survive buffering, including fragmented UTF-8",
  { timeout: 15000 },
  async () => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", fixture, "host", "approval-gate"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const closed = once(child, "close");
    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    try {
      await new Promise<void>((resolve, reject) => {
        child.stderr.on("data", (data) => {
          stderr += String(data);
          if (/"authorizationPending":true/.test(stderr)) resolve();
        });
        child.once("error", reject);
        child.once("close", () =>
          reject(Error("Attach exited before approval")),
        );
      });
      const response = once(lines, "line", {
        signal: AbortSignal.timeout(5000),
      });
      const split = initialize.indexOf(Buffer.from("预")) + 1;
      assert.ok(split > 0);
      child.stdin.write(initialize.subarray(0, split));
      await new Promise<void>((resolve, reject) =>
        child.stdin.write(initialize.subarray(split), (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      const pid = Number(stderr.match(/"fakeUpstreamPid":(\d+)/)?.[1]);
      process.kill(pid, "SIGUSR1"); // Approves the fixture peer only; never real Chrome.
      const [line] = await response;
      const message = JSON.parse(line);
      assert.equal(message.id, 101);
      assert.equal(message.result.serverInfo.name, "cdp-browser-mcp-attach");
      const tools = once(lines, "line", { signal: AbortSignal.timeout(5000) });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n",
      );
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 102, method: "tools/list" }) +
          "\n",
      );
      const [toolLine] = await tools;
      assert.equal(JSON.parse(toolLine).result.tools[1].name, "page_echo");
      child.stdin.end();
      const [code] = await closed;
      assert.equal(code, 0, stderr);
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      await closed;
    }
  },
);

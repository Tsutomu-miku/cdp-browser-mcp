#!/usr/bin/env node
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { mkdir, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, configSchema } from "./config.js";
import { Broker, readAdmin, rpc } from "./broker.js";
import { serveMcp } from "./mcp.js";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    agent: { type: "string" },
    lane: { type: "string" },
    tab: { type: "string" },
    url: { type: "string" },
    headers: { type: "string" },
    headed: { type: "boolean" },
    headless: { type: "boolean" },
    "state-dir": { type: "string" },
    help: { type: "boolean" },
  },
});
const command = positionals[0];
async function main() {
  if (values.help || !command) {
    console.log(
      `cdp-browser-steward <launch|serve|status|open|close|renew|reclaim|reconnect|stop|mcp>\n  --config /path/config.json --state-dir /path/dedicated-state\n  launch [--headed|--headless]    Start a detached local supervisor\n  status                        Show health + agent↔tab↔lane + downloads\n  open --agent A --lane blue [--headers '{"x-custom":"value"}'] [--url URL]\n  close --agent A --tab UUID     Close only this agent's tab\n  renew --agent A --tab UUID     Renew lease\n  reclaim --agent A             Revoke agent and close its tabs\n  reconnect                     Restart owned Chrome; invalidate all tabs\n  stop                          Stop Chrome, supervisor, socket; preserve profile/downloads\n  mcp --agent A --lane blue      MCP stdio; connect to running supervisor\nNo npm publish. CDP binds 127.0.0.1; control uses a 0600 Unix socket + bearer token.`,
    );
    return;
  }
  const config = await loadConfig(values.config);
  if (values["state-dir"]) config.stateDir = resolve(values["state-dir"]);
  if (values.headed && values.headless)
    throw Error("Choose headed or headless");
  if (values.headed) config.headless = false;
  if (values.headless) config.headless = true;
  configSchema.parse(config);
  if (command === "serve") {
    const broker = new Broker(config);
    await broker.start();
    let closing = false;
    const stop = async () => {
      if (closing) return;
      closing = true;
      try {
        await broker.stop();
      } catch (e) {
        console.error(e);
        process.exitCode = 1;
      }
    };
    process.once("SIGINT", () => {
      void stop();
    });
    process.once("SIGTERM", () => {
      void stop();
    });
    return;
  }
  if (command === "launch") {
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    try {
      const admin = await readAdmin(config.stateDir);
      const health = await rpc(admin, "health");
      console.log(JSON.stringify({ alreadyRunning: true, ...health }));
      return;
    } catch (e) {
      if (
        !["ENOENT", "ECONNREFUSED", "ENOTSOCK"].includes(
          (e as NodeJS.ErrnoException).code || "",
        )
      )
        throw e;
    }
    const snapshot = join(config.stateDir, "launch-config.json");
    await writeFile(snapshot, JSON.stringify(config, null, 2), { mode: 0o600 });
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "serve", "--config", snapshot],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    let startupError: Error | undefined;
    child.once("error", (e) => {
      startupError = e;
    });
    for (let i = 0; i < 200; i++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw Error(
          `Supervisor exited. Inspect ${join(config.stateDir, "events.jsonl")} or run serve in foreground.`,
        );
      try {
        const health = await rpc(await readAdmin(config.stateDir), "health");
        console.log(
          JSON.stringify({
            pid: child.pid,
            stateDir: config.stateDir,
            ...health,
          }),
        );
        return;
      } catch (e) {
        if (
          !["ENOENT", "ECONNREFUSED", "ENOTSOCK"].includes(
            (e as NodeJS.ErrnoException).code || "",
          )
        )
          throw e;
      }
      await delay(100);
    }
    throw Error(
      `Startup timed out; cleanup with stop --state-dir ${config.stateDir}`,
    );
  }
  if (command === "mcp") {
    if (!values.agent) throw Error("--agent required");
    await serveMcp(config.stateDir, values.agent, values.lane || "default");
    return;
  }
  const admin = await readAdmin(config.stateDir);
  let result: unknown;
  switch (command) {
    case "status":
    case "stop":
    case "reconnect":
      result = await rpc(admin, command);
      break;
    case "reclaim":
    case "renew":
    case "close":
      result = await rpc(admin, command, {
        agentId: values.agent,
        tabId: values.tab,
      });
      break;
    case "open": {
      const t = await rpc(admin, "open", {
        agentId: values.agent,
        lane: values.lane || "default",
        headers: values.headers ? JSON.parse(values.headers) : {},
      });
      result = values.url
        ? {
            ...t,
            result: await rpc(admin, "action", {
              agentId: values.agent,
              tabId: t.tabId,
              action: "navigate",
              args: { url: values.url },
            }),
          }
        : t;
      break;
    }
    default:
      throw Error(`Unknown command ${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => {
  console.error(
    JSON.stringify({
      event: "error",
      error: e instanceof Error ? e.message : String(e),
    }),
  );
  process.exitCode = 1;
});

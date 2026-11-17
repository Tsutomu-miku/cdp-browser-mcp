#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  loadConfig,
  configSchema,
  headerSchema,
  idSchema,
  headerDomainsSchema,
} from "./config.js";
import { Broker, rpc, SupervisorBusyError } from "./broker.js";
import {
  ensureSupervisor,
  runningSupervisor,
  type StartupMessage,
} from "./supervisor.js";
import { serveMcp } from "./mcp.js";
import { help } from "./cli-help.js";
import { runSelectedMode } from "./cli-mode.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mode: { type: "string" },
    channel: { type: "string" },
    "attach-timeout-ms": { type: "string" },
    config: { type: "string" },
    agent: { type: "string" },
    lane: { type: "string" },
    tab: { type: "string" },
    url: { type: "string" },
    headers: { type: "string" },
    "header-domains": { type: "string" },
    ref: { type: "string" },
    selector: { type: "string" },
    tool: { type: "string" },
    arguments: { type: "string" },
    text: { type: "string" },
    submit: { type: "boolean" },
    slowly: { type: "boolean" },
    headed: { type: "boolean" },
    headless: { type: "boolean" },
    "state-dir": { type: "string" },
    "executable-path": { type: "string" },
    json: { type: "boolean" },
    version: { type: "boolean", short: "V" },
    help: { type: "boolean", short: "h" },
  },
});
const command = positionals[0];
const browserActions = [
  "navigate",
  "click",
  "type",
  "snapshot",
  "extract",
  "devtools",
];
const commands = [
  "launch",
  "serve",
  "status",
  "open",
  "close",
  "renew",
  "reclaim",
  "reconnect",
  "stop",
  "mcp",
  "tabs",
  "downloads",
  ...browserActions,
];

function output(data: unknown, message: string) {
  console.log(values.json ? JSON.stringify(data, null, 2) : message);
}
function startupMessage(message: StartupMessage) {
  if (process.connected) process.send!(message);
}
async function main() {
  if (values.version) {
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    console.log(pkg.version);
    return;
  }
  if (values.help || !command) {
    console.log(help);
    return;
  }
  if (!commands.includes(command))
    throw Error(`Unknown command: ${command}. Run cdp-browser-mcp --help.`);
  if (positionals.length > (["open", "navigate"].includes(command) ? 2 : 1))
    throw Error("Unexpected positional arguments");
  if (await runSelectedMode(command, values)) return;
  const config =
    command === "serve" && process.connected
      ? configSchema.parse(
          await new Promise((resolve) => process.once("message", resolve)),
        )
      : await loadConfig(values.config);
  if (values["state-dir"]) config.stateDir = resolve(values["state-dir"]);
  if (values["executable-path"])
    config.executablePath = resolve(values["executable-path"]);
  if (values.headed && values.headless)
    throw Error("Choose --headed or --headless");
  if (values.headed) config.headless = false;
  if (values.headless) config.headless = true;
  if (values["header-domains"])
    config.headerDomains = headerDomainsSchema.parse(
      JSON.parse(values["header-domains"]),
    );
  configSchema.parse(config);
  if (command === "serve") {
    const broker = new Broker(config);
    const starting = broker.start();
    let closing = false;
    const stop = async () => {
      if (closing) return;
      closing = true;
      try {
        await starting;
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
    await starting;
    startupMessage({ type: "ready" });
    if (!process.connected)
      console.error(
        `Browser service ready (${config.stateDir}). Press Ctrl+C to stop.`,
      );
    return;
  }
  const headers = headerSchema.parse(
    values.headers ? JSON.parse(values.headers) : {},
  );
  const agentId =
    command === "open"
      ? idSchema.parse(values.agent || "manual")
      : values.agent;
  const browserAction = browserActions.includes(command);
  if (browserAction || ["tabs", "downloads"].includes(command)) {
    if (!agentId) throw Error(`--agent is required for ${command}`);
    idSchema.parse(agentId);
  }
  const actionArgs: Record<string, unknown> = {};
  if (browserAction) {
    if (!values.tab) throw Error(`--tab is required for ${command}`);
    if (command === "navigate") {
      const url = positionals[1] || values.url;
      if (!url) throw Error("navigate requires a URL");
      actionArgs.url = url;
    }
    if (command === "click" || command === "type") {
      if (!!values.ref === !!values.selector)
        throw Error("Choose exactly one of --ref or --selector");
      if (values.ref) actionArgs.ref = values.ref;
      if (values.selector) actionArgs.selector = values.selector;
    }
    if (command === "type") {
      if (values.text === undefined) throw Error("type requires --text");
      Object.assign(actionArgs, {
        text: values.text,
        submit: values.submit,
        slowly: values.slowly,
      });
    }
    if (command === "devtools") {
      if (!values.tool) throw Error("devtools requires --tool");
      actionArgs.name = values.tool;
      actionArgs.arguments = values.arguments
        ? JSON.parse(values.arguments)
        : {};
    }
    if (command === "extract" && values.selector)
      actionArgs.selector = values.selector;
  }
  if (command === "mcp") {
    if (!agentId)
      throw Error(
        "--agent is required. Use a different ID for each MCP client.",
      );
    idSchema.parse(agentId);
    await ensureSupervisor(config);
    await serveMcp(config.stateDir, agentId, values.lane || "default", headers);
    return;
  }
  if (command === "launch") {
    const { admin, health, alreadyRunning } = await ensureSupervisor(config);
    output(
      { pid: admin.pid, stateDir: config.stateDir, alreadyRunning, ...health },
      `Browser ${alreadyRunning ? "already running" : "started"} (${health.mode}).\nData: ${config.stateDir}\nStop: cdp-browser-mcp stop${values.config ? ` --config ${values.config}` : values["state-dir"] ? ` --state-dir ${config.stateDir}` : ""}`,
    );
    return;
  }
  const running =
    command === "open"
      ? await ensureSupervisor(config)
      : await runningSupervisor(config.stateDir);
  if (!running) {
    if (command === "status" || command === "stop") {
      output({ running: false }, "Browser is not running.");
      return;
    }
    throw Error("Browser is not running. Run cdp-browser-mcp launch first.");
  }
  const { admin } = running;
  if (browserAction) {
    const result = await rpc(admin, "action", {
      agentId,
      tabId: values.tab,
      action: command,
      args: actionArgs,
    });
    output(
      result,
      command === "devtools"
        ? JSON.stringify(result)
        : command === "extract"
          ? result.text
          : result.snapshot,
    );
    return;
  }
  switch (command) {
    case "tabs": {
      const tabs = await rpc<{ tabId: string; lane: string; url: string }[]>(
        admin,
        "list",
        { agentId },
      );
      output(
        tabs,
        tabs.length
          ? tabs.map((t) => `${t.tabId}  ${t.lane}  ${t.url}`).join("\n")
          : "No active tabs for this agent.",
      );
      break;
    }
    case "downloads": {
      const downloads = await rpc<{ path: string }[]>(admin, "downloads", {
        agentId,
      });
      output(
        downloads,
        downloads.length
          ? downloads.map((d) => d.path).join("\n")
          : "No completed downloads for this agent.",
      );
      break;
    }
    case "status": {
      const status = await rpc(admin, "status");
      const tabs = status.tabs as {
        agentId: string;
        tabId: string;
        lane: string;
        url: string;
      }[];
      const rows = tabs.map(
        (t) =>
          `${t.agentId.padEnd(16)} ${t.tabId}  ${t.lane.padEnd(12)} ${t.url}`,
      );
      output(
        status,
        [
          `Browser: ${status.ready ? "ready" : "unavailable"} (${status.mode})`,
          `Data: ${config.stateDir}`,
          `Agents: ${status.agents.length}  Tabs: ${tabs.length}  Downloads: ${status.downloads.length}`,
          ...(status.diskError ? [`Disk: ${status.diskError}`] : []),
          "",
          ...(tabs.length
            ? [
                "AGENT            TAB                                   LANE         URL",
                ...rows,
              ]
            : ["No active tabs."]),
        ].join("\n"),
      );
      break;
    }
    case "stop":
      output(
        await rpc(admin, "stop"),
        "Stopping browser service. Login state and downloads are preserved.",
      );
      break;
    case "reconnect":
      output(
        await rpc(admin, "reconnect"),
        "Browser restarted. Existing tab leases have been released.",
      );
      break;
    case "reclaim":
    case "renew":
    case "close":
      output(
        await rpc(admin, command, { agentId, tabId: values.tab }),
        `${command === "reclaim" ? "Agent reclaimed" : command === "renew" ? "Lease renewed" : "Tab closed"}: ${command === "reclaim" ? agentId : values.tab}`,
      );
      break;
    case "open": {
      const tab = await rpc(admin, "open", {
        agentId,
        lane: values.lane || "default",
        headers,
      });
      const url = positionals[1] || values.url;
      const result = url
        ? {
            ...tab,
            result: await rpc(admin, "action", {
              agentId,
              tabId: tab.tabId,
              action: "navigate",
              args: { url },
            }),
          }
        : tab;
      output(
        result,
        `Opened ${url || "about:blank"}\nAgent: ${agentId}\nTab: ${tab.tabId}\nLane: ${tab.lane}\nThe tab lease expires after ${config.leaseMs / 1000}s of inactivity; use renew to extend it.`,
      );
      break;
    }
  }
}
main().catch((e) => {
  const error = e instanceof Error ? e.message : String(e);
  if (process.connected)
    startupMessage(
      e instanceof SupervisorBusyError
        ? { type: "busy" }
        : { type: "error", error },
    );
  else
    console.error(
      values.json || command === "mcp"
        ? JSON.stringify({ event: "error", error })
        : `Error: ${error}`,
    );
  process.exitCode = 1;
});

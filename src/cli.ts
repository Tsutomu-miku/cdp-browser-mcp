#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, configSchema, headerSchema, idSchema } from "./config.js";
import { Broker, rpc, SupervisorBusyError } from "./broker.js";
import {
  ensureSupervisor,
  runningSupervisor,
  type StartupMessage,
} from "./supervisor.js";
import { serveMcp } from "./mcp.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    backend: { type: "string" },
    "chrome-tab": { type: "string" },
    agent: { type: "string" },
    lane: { type: "string" },
    tab: { type: "string" },
    url: { type: "string" },
    headers: { type: "string" },
    ref: { type: "string" },
    selector: { type: "string" },
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
  "screenshot",
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
  "available",
  "attach",
  "headers",
  "downloads",
  ...browserActions,
];
const help = `cdp-browser-mcp — shared browser sessions for multiple agents

Usage: cdp-browser-mcp <command> [options]

Commands:
  mcp --agent <id>       Start an MCP stdio server; start/reuse the shared browser
  open [url]            Open an owned tab (default agent: manual)
  navigate <url>        Navigate an owned tab; return snapshot and refs
  click                 Click --ref <ref> or --selector <css>
  type                  Fill --ref/--selector with --text <value>
  snapshot              Read an owned tab's accessibility snapshot and refs
  extract               Read visible text (optional --selector <css>)
  tabs --agent <id>     List only this agent's tabs
  available --agent <id> List Chrome tabs (extension backend only)
  attach --chrome-tab <number> --agent <id> Lease an existing Chrome tab
  headers --agent <id> --tab <id> --headers <json> Replace extension tab headers; {} removes
  screenshot            Capture an owned tab (extension requires activeTab gesture)
  downloads --agent <id>  List only this agent's completed downloads
  launch                Start the local browser service in the background
  status                Show browser health, tabs, agents and downloads
  stop                  Stop the shared browser; keep login state and downloads
  close --agent <id> --tab <id>   Close an agent's tab
  renew --agent <id> --tab <id>   Extend a tab lease
  reclaim --agent <id>   Close an agent's tabs and revoke its session
  reconnect             CDP: restart owned Chrome; extension: resync live tab rules
  serve                 Run the browser service in the foreground

Options:
  --headers <json>      Per-tab request headers, e.g. '{"x-lane":"blue"}'
  --agent <id>          Unique execution/session ID (not a shared agent name)
  --tab <id>            Explicit owned tab ID for browser actions
  --ref / --selector    Element ref from snapshot, or a CSS selector
  --text <value>        Text to fill; --submit presses Enter; --slowly types keys
  --lane <name>         Header template from config (default: default)
  --config <file>       Optional JSON configuration
  --backend <name>      cdp (default) or extension; extension requires config.extensionId
  --state-dir <path>    Dedicated browser data directory
  --executable-path <path>  Chrome executable (otherwise auto-detected)
  --headed / --headless Choose the display mode when starting a new browser
  --json                Print command results as JSON
  -V, --version         Print version
  -h, --help            Show this help

Examples:
  cdp-browser-mcp mcp --agent codex
  cdp-browser-mcp open https://example.com
  cdp-browser-mcp snapshot --agent task-123 --tab <tab-id>
  cdp-browser-mcp status
  cdp-browser-mcp stop`;

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
  const config =
    command === "serve" && process.connected
      ? configSchema.parse(
          await new Promise((resolve) => process.once("message", resolve)),
        )
      : await loadConfig(values.config);
  if (values["state-dir"]) config.stateDir = resolve(values["state-dir"]);
  if (values.backend)
    config.backend = configSchema.shape.backend.parse(values.backend);
  if (values["executable-path"])
    config.executablePath = resolve(values["executable-path"]);
  if (values.headed && values.headless)
    throw Error("Choose --headed or --headless");
  if (values.headed) config.headless = false;
  if (values.headless) config.headless = true;
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
  if (
    browserAction ||
    ["tabs", "downloads", "available", "attach", "headers"].includes(command)
  ) {
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
      `Browser service ${alreadyRunning ? "already running" : "started"} (${health.mode}).\nData: ${config.stateDir}\nStop: cdp-browser-mcp stop${values.config ? ` --config ${values.config}` : values["state-dir"] ? ` --state-dir ${config.stateDir}` : ""}`,
    );
    return;
  }
  const running = ["open", "attach"].includes(command)
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
      command === "screenshot"
        ? JSON.stringify(result)
        : command === "extract"
          ? result.text
          : result.snapshot,
    );
    return;
  }
  switch (command) {
    case "available": {
      const tabs = await rpc(admin, "available", { agentId });
      output(tabs, JSON.stringify(tabs, null, 2));
      break;
    }
    case "attach": {
      if (!values["chrome-tab"])
        throw Error("attach requires --chrome-tab <number>");
      const tab = await rpc(admin, "attach", {
        agentId,
        chromeTabId: Number(values["chrome-tab"]),
        lane: values.lane || "default",
        headers,
      });
      output(tab, JSON.stringify(tab, null, 2));
      break;
    }
    case "headers": {
      if (!values.tab || values.headers === undefined)
        throw Error("headers requires --tab and --headers (use {} to remove)");
      const result = await rpc(admin, "headers", {
        agentId,
        tabId: values.tab,
        headers,
      });
      output(result, JSON.stringify(result, null, 2));
      break;
    }
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
        config.backend === "extension"
          ? "Extension connection checked and live tab rules resynchronized."
          : "Browser restarted. Existing tab leases have been released.",
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

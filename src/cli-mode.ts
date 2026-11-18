import { z } from "zod";
import { upstreamTransport } from "./upstream.js";
import { attachArgs } from "./attach/connection.js";
import { serveAttach } from "./attach/server.js";
import { attachOptionsSchema } from "./attach/options.js";
import { runExtensionMode } from "./extension/mode.js";

/** CLI-only selection keeps isolated configuration and supervisor state intact. */
export async function runSelectedMode(
  command: string,
  values: Record<string, string | boolean | undefined>,
) {
  const mode = z
    .enum(["isolated", "attach", "extension"])
    .parse(values.mode ?? "isolated");
  if (mode === "extension") return runExtensionMode(command, values);
  if (mode === "isolated") {
    if (
      values.channel !== undefined ||
      values["attach-timeout-ms"] !== undefined
    )
      throw Error("--channel and --attach-timeout-ms require --mode attach");
    return false;
  }
  if (command !== "mcp")
    throw Error(
      "Attach supports mcp only: run cdp-browser-mcp mcp --mode attach. Use official MCP tools for pages; leases, lane headers and isolated downloads require --mode isolated.",
    );
  const allowed = new Set(["mode", "channel", "attach-timeout-ms", "json"]);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && !allowed.has(key))
      throw Error(
        `--${key} is unavailable in attach mode. Attach uses the daily Chrome profile without agent/tab leases, lane headers, download isolation or Chrome launch settings. Use --mode isolated for these options.`,
      );
  }
  const options = attachOptionsSchema.parse({
    channel: values.channel,
    timeoutMs: values["attach-timeout-ms"],
  });
  await serveAttach(
    options,
    await upstreamTransport(attachArgs(options), "inherit"),
  );
  return true;
}

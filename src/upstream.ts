import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";

/** Resolve only the installed, lockfile-pinned official executable. */
export async function upstreamTransport(
  args: string[],
  stderr: "pipe" | "inherit",
) {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("chrome-devtools-mcp/package.json");
  const { bin } = JSON.parse(await readFile(pkg, "utf8"));
  return new StdioClientTransport({
    command: process.execPath,
    args: [resolve(dirname(pkg), bin["chrome-devtools-mcp"]), ...args],
    stderr,
  });
}

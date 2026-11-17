import { resolve } from "node:path";
import { serveExtension } from "./server.js";

export async function runExtensionMode(
  command: string,
  values: Record<string, string | boolean | undefined>,
) {
  if (command !== "mcp") throw Error("Extension mode supports mcp only");
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && !["mode", "state-dir", "json"].includes(key))
      throw Error(
        `--${key} is unavailable in extension mode; use the extension popup for site consent`,
      );
  if (typeof values["state-dir"] !== "string")
    throw Error(
      "Extension mode requires --state-dir matching the native host installation (separate from isolated state)",
    );
  await serveExtension(resolve(values["state-dir"]));
  return true;
}

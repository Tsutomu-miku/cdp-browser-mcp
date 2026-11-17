#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  access,
  chmod,
  cp,
  mkdir,
  open,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOST = "io.github.tsutomu_miku.cdp_browser_mcp";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: "string" },
    "extension-id": { type: "string" },
    "state-dir": { type: "string" },
    "browser-user-data-dir": { type: "string" },
  },
});
const root = fileURLToPath(new URL("../../", import.meta.url));

async function main() {
  if (positionals[0] === "prepare") {
    if (!values.output)
      throw Error("prepare requires --output <new extension directory>");
    const destination = resolve(values.output);
    await mkdir(destination, { mode: 0o700 });
    await cp(join(root, "extension"), destination, { recursive: true });
    console.log(
      JSON.stringify({
        extensionDirectory: destination,
        next: "Load this directory in chrome://extensions, then install-native using its extension ID. Access is paused until you approve sites in the popup.",
      }),
    );
    return;
  }
  if (
    positionals[0] !== "install-native" ||
    !/^[a-p]{32}$/.test(values["extension-id"] ?? "") ||
    !values["state-dir"] ||
    !values["browser-user-data-dir"]
  )
    throw Error(
      "Usage: cdp-browser-mcp-extension-setup prepare --output <new-directory> | install-native --extension-id <id> --state-dir <dedicated-directory> --browser-user-data-dir <explicit-Chrome-root>",
    );
  if (/\s/.test(process.execPath))
    throw Error(
      "Native launcher requires a Node executable path without whitespace",
    );
  const host = join(root, "dist/extension/host.js");
  await access(host);
  const directory = resolve(values["state-dir"]);
  const profileRoot = resolve(values["browser-user-data-dir"]);
  if (directory === profileRoot)
    throw Error("Extension state must be separate from the Chrome profile");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const manifestDirectory = join(profileRoot, "NativeMessagingHosts");
  await mkdir(manifestDirectory, { recursive: true, mode: 0o700 });
  const manifestPath = join(manifestDirectory, HOST + ".json");
  const launcher = join(directory, "native-launcher.mjs");
  const code = `#!${process.execPath}\nprocess.argv = [process.argv[0], ${JSON.stringify(host)}, "--state-dir", ${JSON.stringify(directory)}, "--extension-id", ${JSON.stringify(values["extension-id"])}, ...process.argv.slice(2)];\nawait import(${JSON.stringify(pathToFileURL(host).href)});\n`;
  const reservation = await open(manifestPath, "wx", 0o600);
  let created = false;
  try {
    await writeFile(launcher, code, { flag: "wx", mode: 0o700 });
    created = true;
    await reservation.writeFile(
      JSON.stringify(
        {
          name: HOST,
          description: "CDP Browser MCP daily Chrome bridge",
          path: launcher,
          type: "stdio",
          allowed_origins: [`chrome-extension://${values["extension-id"]}/`],
        },
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    if (created) await rm(launcher);
    await rm(manifestPath);
    throw error;
  } finally {
    await reservation.close();
  }
  console.log(
    JSON.stringify({
      manifestPath,
      launcher,
      stateDir: directory,
      uninstall:
        "Pause/disable the extension first, then remove only this manifest and launcher. Keep Chrome and its tabs open.",
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  readFile,
  writeFile,
  mkdir,
  chmod,
  cp,
  access,
  open,
  rm,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: "string" },
    origins: { type: "string" },
    "extension-id": { type: "string" },
    "state-dir": { type: "string" },
    "browser-user-data-dir": { type: "string" },
  },
});
const root = fileURLToPath(new URL("../", import.meta.url));
const hostName = "io.github.tsutomu_miku.cdp_browser_mcp";
if (positionals[0] === "prepare") {
  if (!values.output || !values.origins)
    throw Error(
      "prepare requires --output <new-directory> --origins '<JSON array of exact http(s) origins>'",
    );
  const origins = JSON.parse(values.origins);
  if (
    !Array.isArray(origins) ||
    !origins.length ||
    origins.some((origin) => {
      if (typeof origin !== "string") return true;
      const u = new URL(origin);
      return (
        !["http:", "https:"].includes(u.protocol) ||
        u.origin !== origin ||
        /[*]/.test(origin)
      );
    })
  )
    throw Error(
      "Use exact http(s) origins without paths, credentials, wildcards or trailing slash",
    );
  const destination = resolve(values.output);
  await mkdir(destination, { mode: 0o700 }); // Never overwrite an installed extension.
  await cp(join(root, "extension"), destination, { recursive: true });
  const manifest = JSON.parse(
    await readFile(join(destination, "manifest.json"), "utf8"),
  );
  // Chrome match patterns ignore ports. The DNR regex and page checks enforce exact origins.
  manifest.host_permissions = [
    ...new Set(
      origins.map((origin) => {
        const u = new URL(origin);
        return `${u.protocol}//${u.hostname}/*`;
      }),
    ),
  ];
  await writeFile(
    join(destination, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await writeFile(
    join(destination, "sites.js"),
    `export default ${JSON.stringify(origins)};\n`,
  );
  console.log(JSON.stringify({ extensionDirectory: destination, origins }));
} else if (positionals[0] === "install-native") {
  if (!["darwin", "linux"].includes(process.platform))
    throw Error(
      "Native installer supports macOS/Linux only; Windows is not implemented",
    );
  if (
    !/^[a-p]{32}$/.test(values["extension-id"] || "") ||
    !values["state-dir"] ||
    !values["browser-user-data-dir"]
  )
    throw Error(
      "install-native requires --extension-id, --state-dir and explicit --browser-user-data-dir. It never chooses a daily profile automatically.",
    );
  if (/\s/.test(process.execPath))
    throw Error(
      "Native launcher requires a Node executable path without whitespace",
    );
  const stateDir = resolve(values["state-dir"]);
  if (Buffer.byteLength(join(stateDir, "native.sock")) > 100)
    throw Error("state-dir socket path must be at most 100 bytes");
  await access(join(root, "dist/native-host.js"));
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const launcher = join(stateDir, "native-launcher.mjs");
  const code = `#!${process.execPath}\nprocess.argv = [process.argv[0], ${JSON.stringify(join(root, "dist/native-host.js"))}, "--state-dir", ${JSON.stringify(stateDir)}, "--extension-id", ${JSON.stringify(values["extension-id"])}, ...process.argv.slice(2)];\nawait import(${JSON.stringify(pathToFileURL(join(root, "dist/native-host.js")).href)});\n`;
  const directory = join(
    resolve(values["browser-user-data-dir"]),
    "NativeMessagingHosts",
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifestPath = join(directory, hostName + ".json");
  const manifest = {
    name: hostName,
    description: "CDP Browser MCP local extension bridge",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${values["extension-id"]}/`],
  };
  // Reserve the manifest before touching a launcher. A rejected reinstall must
  // leave an existing host fully usable, including its previous extension ID.
  const reservation = await open(manifestPath, "wx", 0o600);
  let createdLauncher = false;
  try {
    await writeFile(launcher, code, { flag: "wx", mode: 0o700 });
    createdLauncher = true;
    await chmod(launcher, 0o700);
    await reservation.writeFile(JSON.stringify(manifest, null, 2) + "\n");
  } catch (error) {
    if (createdLauncher) await rm(launcher);
    await rm(manifestPath);
    throw error;
  } finally {
    await reservation.close();
  }
  console.log(
    JSON.stringify({
      manifestPath,
      launcher,
      stateDir,
      uninstall: `Remove ${manifestPath} and ${launcher} after stopping the extension backend`,
    }),
  );
} else
  throw Error(
    "Usage: node scripts/extension-setup.mjs prepare|install-native [options]",
  );

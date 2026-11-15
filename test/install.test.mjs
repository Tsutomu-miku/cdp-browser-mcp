import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const installer = resolve("scripts/install.sh");
const shell = process.env.INSTALL_TEST_SHELL ?? "/bin/sh";
const repository = "https://github.com/Tsutomu-miku/cdp-browser-mcp";
const asset = `${repository}/releases/download/v9.8.7/cdp-browser-mcp-9.8.7.tgz`;

// Only GitHub's network boundary is stubbed. Real npm packs/installs the fixture
// offline, so these tests protect the local-tgz install and bin-link contract.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "cdp-installer-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const stubs = join(root, "stubs");
  mkdirSync(source);
  mkdirSync(stubs);
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name: "cdp-browser-mcp",
      version: "9.8.7",
      private: true,
      bin: { "cdp-browser-mcp": "cli.js" },
    }),
  );
  writeFileSync(
    join(source, "cli.js"),
    '#!/usr/bin/env node\nif (process.argv[2] !== "--version") process.exit(1);\nconsole.log("9.8.7");\n',
  );
  const prefix = join(root, "prefix with spaces");
  const env = {
    ...process.env,
    PATH: `${stubs}:${process.env.PATH}`,
    npm_config_prefix: join(root, "inherited-prefix"),
    NPM_CONFIG_PREFIX: prefix,
    NPM_CONFIG_CACHE: join(root, "cache"),
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    CDP_TEST_ARCHIVE: join(root, "cdp-browser-mcp-9.8.7.tgz"),
    CDP_TEST_REQUESTS: join(root, "requests.jsonl"),
  };
  delete env.VERSION;
  execFileSync(
    "npm",
    ["pack", source, "--ignore-scripts", "--pack-destination", root],
    { env, stdio: "pipe" },
  );
  writeFileSync(
    join(stubs, "curl"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const url = args.at(-1);
fs.appendFileSync(process.env.CDP_TEST_REQUESTS, JSON.stringify(url) + "\\n");
if (process.env.CDP_TEST_FAIL === "all" || (process.env.CDP_TEST_FAIL === "asset" && url.endsWith(".tgz"))) process.exit(22);
const destination = args[args.indexOf("--output") + 1];
if (url === "https://api.github.com/repos/Tsutomu-miku/cdp-browser-mcp/releases/latest") {
  fs.writeFileSync(destination, JSON.stringify({tag_name: "v9.8.7"}));
} else if (url === ${JSON.stringify(asset)}) {
  fs.copyFileSync(process.env.CDP_TEST_ARCHIVE, destination);
} else {
  throw Error("Unexpected download URL: " + url);
}
`,
    { mode: 0o755 },
  );
  return { root, prefix, env };
}

function run(env) {
  return spawnSync(shell, [installer], { env, encoding: "utf8" });
}

test("installer is valid POSIX sh syntax", () => {
  const result = spawnSync(shell, ["-n", installer], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

for (const version of [undefined, "v9.8.7"]) {
  test(`installs ${version ?? "latest"} from a local tgz into a user prefix`, (t) => {
    const { prefix, env } = fixture(t);
    if (version) env.VERSION = version;
    const result = run(env);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const bin = join(prefix, "bin/cdp-browser-mcp");
    assert.ok(lstatSync(bin).isSymbolicLink());
    assert.equal(
      execFileSync(bin, ["--version"], { encoding: "utf8" }).trim(),
      "9.8.7",
    );
    const config = JSON.parse(
      result.stdout.slice(result.stdout.indexOf('{\n  "mcpServers"')),
    );
    assert.deepEqual(config.mcpServers.browser, {
      command: "cdp-browser-mcp",
      args: ["mcp", "--agent", "agent-a"],
    });
    const requests = readFileSync(env.CDP_TEST_REQUESTS, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      requests,
      version
        ? [asset]
        : [
            "https://api.github.com/repos/Tsutomu-miku/cdp-browser-mcp/releases/latest",
            asset,
          ],
    );
  });
}

for (const failure of ["all", "asset"]) {
  test(`missing ${failure === "all" ? "Release" : "tgz"} fails before installation with source-build guidance`, (t) => {
    const { prefix, env } = fixture(t);
    const result = run({ ...env, CDP_TEST_FAIL: failure });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /git clone.*build from source/);
    assert.ok(!existsSync(join(prefix, "bin/cdp-browser-mcp")));
  });
}

test("unusable npm prefix gives a no-root installation command", (t) => {
  const { root, env } = fixture(t);
  const file = join(root, "file");
  writeFileSync(file, "not a directory");
  const result = run({ ...env, NPM_CONFIG_PREFIX: file });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /NPM_CONFIG_PREFIX="\$HOME\/\.local"/);
  assert.match(result.stderr, /not writable/);
  assert.ok(!existsSync(env.CDP_TEST_REQUESTS));
});

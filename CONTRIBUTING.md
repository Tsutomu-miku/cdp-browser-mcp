# Development

Requires Node.js 22.12+, npm, and Google Chrome current Stable or newer, matching the official chrome-devtools-mcp requirements. This also applies to Linux headless=new; older Chrome/other Chromium browsers are not part of the supported baseline. Development quality tools require Node.js 22.13+.

## Installation

### 1. Release installer (recommended for users)

```sh
curl -fsSL https://raw.githubusercontent.com/Tsutomu-miku/cdp-browser-mcp/main/scripts/install.sh -o install.sh && sh install.sh
```

The installer defaults to the latest GitHub Release. Set `VERSION` to pin a published tag and `NPM_CONFIG_PREFIX` to choose an absolute installation prefix, for example `VERSION=v0.2.0 NPM_CONFIG_PREFIX="$HOME/.local" sh install.sh`. That tag is an example; it must contain the matching tgz asset. Add `$HOME/.local/bin` to your shell and MCP client's PATH. No sudo is invoked; missing artifacts fail rather than compiling a checkout. See [deployment](docs/deployment.md#installation) for the full contract.

**This project does not publish to npmjs. The public npm package with the same name is unrelated.** Keep `private: true`; do not use `npm publish`, registry-name installation, or registry-name npx commands for this project. npm only installs our local archive and resolves its runtime dependencies.

### 2. Build from a clone

```sh
git clone https://github.com/Tsutomu-miku/cdp-browser-mcp.git
cd cdp-browser-mcp
npm ci
npm run build
node dist/cli.js --version
```

To install your source build as a command (the archive name follows `package.json`):

```sh
npm pack
NPM_CONFIG_PREFIX="$HOME/.local" npm install --global --omit=dev ./cdp-browser-mcp-0.2.0.tgz
export PATH="$HOME/.local/bin:$PATH"
cdp-browser-mcp --version
```

`npm pack` includes the prebuilt `dist/` through the existing `prepare` build and the package's `files` allowlist. If lifecycle scripts are restricted, run `npm run build` explicitly before packing. Consumers of the Release archive need no TypeScript compiler or development dependencies.

## Checks

```sh
npm run hooks:install
npm run check
npm test
npm run test:headed
npm pack
```

Read [AGENTS.md](AGENTS.md) for ownership and error contracts, and [quality gates](docs/quality-gates.md) for gate coverage, size debt and evaluation limits. The pre-push hook runs deterministic checks; CI also runs the complete browser suite.

`npm run test:install` is included in `check`. It runs `sh -n` and exercises latest/tag downloads through a network stub with a real fixture tgz and real offline `npm install -g` into a temporary prefix. It verifies the bin symlink, version and MCP configuration, plus missing Release/tgz and unusable-prefix failures. No browser, registry access or extra test dependency is needed. Linux CI uses dash as `/bin/sh`; the same installer path runs on macOS. To exercise dash explicitly where installed, run `INSTALL_TEST_SHELL=/bin/dash npm run test:install`.

Browser tests use disposable profiles and synthetic loopback sites. Use `CHROME_PATH` to select another installed Chrome executable. A visible test run requires a graphical session. Test artifacts are written to `test-results/` and are not committed by default. Do not include browser profiles, login exports, credentials, or runtime logs in changes.

## Release artifacts

Releases distribute npm-pack tgz files on GitHub, with no npmjs publication. `.github/workflows/release.yml` runs only when a `v*` tag is pushed. It requires the tag to equal `v` plus `package.json` version, installs with `npm ci`, runs `npm run check`, runs `npm pack`, inspects required archive entries, and attaches `cdp-browser-mcp-<version>.tgz` to a GitHub Release. Prerelease versions (such as `0.3.0-rc.1`) are marked prerelease and are excluded from the installer's default latest selection; they remain installable with explicit `VERSION`.

The tgz contains `dist/cli.js` and other built modules, `skills/`, examples, README/CHANGELOG/CONTRIBUTING, docs, package metadata, LICENSE, NOTICE and the upstream license in `third_party/`. Dependencies are declared in package metadata and installed by npm, rather than bundled. Tests, source TypeScript and development tools are outside the runtime file allowlist.

Before a separately authorized release, update `package.json` and its lockfile to the intended version in a reviewed change and verify the browser CI. Only then push the matching tag. The workflow uses `--verify-tag` and fails on build, check, inventory or upload errors; it never publishes to npm. To reproduce the artifact locally without creating a tag or Release:

```sh
npm ci
npm run check
npm pack
tar -tzf cdp-browser-mcp-0.2.0.tgz
```

Adding this workflow does not create a tag, Release or published package. Existing Releases are not backfilled automatically; a tag without the expected asset fails installation and the user may explicitly choose the clone/build method.

See [architecture](docs/architecture.md) for state ownership and isolation boundaries, and [testing](docs/testing.md) for the integration scenarios.

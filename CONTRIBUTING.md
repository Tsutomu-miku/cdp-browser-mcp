# Development

Requires Node.js 22.12+, npm, and Google Chrome current Stable or newer, matching the official chrome-devtools-mcp requirements. This also applies to Linux headless=new; older Chrome/other Chromium browsers are not part of the supported baseline.

```sh
git clone https://github.com/Tsutomu-miku/cdp-browser-mcp.git
cd cdp-browser-mcp
npm ci
npm run build
node dist/cli.js --help
```

To install the local checkout as a command:

```sh
npm pack
npm install --global ./cdp-browser-mcp-0.2.0-dev.tgz
cdp-browser-mcp --help
```

Installing a built tarball avoids Git preparation during global installation. Some npm versions propagate global install settings into Git preparation, leaving build dependencies unavailable; use the `npx` entry point or the tarball above.

If lifecycle scripts are restricted by your package manager, `npm run build` builds the executable explicitly.

## Checks

```sh
npm run hooks:install
npm run check
npm test
npm run test:headed
npm pack
```

Read [AGENTS.md](AGENTS.md) for ownership and error contracts, and [quality gates](docs/quality-gates.md) for gate coverage, size debt and evaluation limits. The pre-push hook runs deterministic checks; CI also runs the complete browser suite.

Tests use disposable profiles and synthetic loopback sites. Use `CHROME_PATH` to select another installed Chrome executable. A visible test run requires a graphical session. Test artifacts are written to `test-results/` and are not committed by default.

The package is installed from Git or a local tarball. Its `private` flag prevents accidental registry publication. Do not include browser profiles, login exports, credentials, or runtime logs in changes.

See [architecture](docs/architecture.md) for state ownership and isolation boundaries, and [testing](docs/testing.md) for the integration scenarios.

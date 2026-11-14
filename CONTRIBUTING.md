# Development

Requires Node.js 22+, npm, and an installed Chrome/Chromium browser.

```sh
git clone https://github.com/Tsutomu-miku/cdp-browser-mcp.git
cd cdp-browser-mcp
npm ci
npm run build
node dist/cli.js --help
```

To install the local checkout as a command:

```sh
npm link
cdp-browser-mcp --help
```

If lifecycle scripts are restricted by your package manager, `npm run build` builds the executable explicitly.

## Checks

```sh
npm run format:check
npm test
npm run test:headed
npm pack
```

Tests use disposable profiles and synthetic loopback sites. Use `CHROME_PATH` to select another installed Chrome executable. A visible test run requires a graphical session. Test artifacts are written to `test-results/` and are not committed by default.

The package is installed from Git or a local tarball. Its `private` flag prevents accidental registry publication. Do not include browser profiles, login exports, credentials, or runtime logs in changes.

See [architecture](docs/architecture.md) for state ownership and isolation boundaries, and [testing](docs/testing.md) for the integration scenarios.

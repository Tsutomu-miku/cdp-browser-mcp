# Testing

```sh
npm ci
npm test
npm run test:headed
```

Tests build the CLI, start an isolated Chrome profile with a random loopback CDP port, and use a local synthetic HTTP site. They do not access an existing browser profile or real account. Set `CHROME_PATH` to override the browser executable.

Generated request logs and results go to the ignored `test-results/` directory. Running tests does not modify tracked validation records.

## Coverage

- Two independent MCP clients sharing a login while operating separate tabs.
- Two independent Playwright CDP connections sharing default-context cookies.
- Per-tab headers across documents, resources, navigation, frames, dedicated/nested workers, fetch, XHR, beacon, and downloads.
- SharedWorker/SW blocking, cross-agent denial, tab close, idle expiry, and download isolation.
- Browser disconnection, cookie recovery, disk guard, and process/socket cleanup.
- Concurrent first-run MCP startup, client header defaults, and reuse of one browser service.
- Terminal skill execution through separate CLI invocations: two execution IDs, shared login, independent actions by snapshot ref, scoped tab/download lists, rejected cross-task access, and cleanup that preserves the other task. Request evidence is written to `test-results/skill-cli-{headed,headless}.json`.

## Validation records

[Archived request-level records](https://github.com/Tsutomu-miku/cdp-browser-mcp/tree/main/docs/validation) document macOS Chrome runs in visible and `headless=new` modes. All identities and hosts in those records are synthetic.

The [Linux Chrome workflow](../.github/workflows/linux.yml) pins Chrome for Testing 136.0.7103.113 and 146.0.7680.165 on Ubuntu 22.04 and runs all four existing tests in `headless=new`. The startup and concurrent-download scenarios guard the default-context download contract: the browser-level CDP commands omit `browserContextId`, and downloads still arrive in separate agent/tab directories.

**v0.1.1 measured results:** all four tests passed on each of macOS Chrome 157.0.8103.51 headed/headless and Ubuntu 22.04 Chrome 136.0.7103.113 / 146.0.7680.165 headless. [CI run](https://github.com/Tsutomu-miku/cdp-browser-mcp/actions/runs/43626922425) · [request evidence](validation/v0.1.1/README.md). Every concurrent scenario recorded 44 synthetic requests (43 agent-tagged), zero header mismatches, and separate A/B downloads, including a cross-origin iframe download.

The official CDP definitions specify that omitting `browserContextId` selects the default context for both [setDownloadBehavior](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-setDownloadBehavior) and [cancelDownload](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-cancelDownload). No platform/version selection or retry path is involved. The staging UUID is generated locally and never sent as a context ID.

Linux headed/Xvfb deployment, cross-host login migration, IDE-level client setup, and external browser providers have not been exercised on their target environments. The MCP transport and tool calls are tested directly using the MCP SDK.

## Worker probe

The standalone probe shows the request header gap without worker blocking and compares it with the explicit blocking policy:

```sh
npm run spike
npm run spike -- --block
npm run spike -- --block --headed
```

Probe results are also written to `test-results/`. The shared/background worker fetches are intentionally outside per-tab attribution in the baseline. In blocking mode, their scripts and fetches must not reach the synthetic server.

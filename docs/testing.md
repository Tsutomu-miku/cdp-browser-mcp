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

Linux/Xvfb deployment, cross-host login migration, IDE-level client setup, and external browser providers have not been exercised on their target environments. macOS headless results do not establish Linux compatibility. The MCP transport and tool calls are tested directly using the MCP SDK.

## Worker probe

The standalone probe shows the request header gap without worker blocking and compares it with the explicit blocking policy:

```sh
npm run spike
npm run spike -- --block
npm run spike -- --block --headed
```

Probe results are also written to `test-results/`. The shared/background worker fetches are intentionally outside per-tab attribution in the baseline. In blocking mode, their scripts and fetches must not reach the synthetic server.

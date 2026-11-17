# Testing

```sh
npm ci
npm test
npm run test:headed
```

Browser tests build the CLI, start an isolated Chrome profile with a random loopback CDP port, and use a local synthetic HTTP site. They do not access an existing browser profile or real account. Set `CHROME_PATH` to override the browser executable.

Generated request logs and results go to the ignored `test-results/` directory. Running tests does not modify tracked validation records.

## Coverage

- Two independent MCP clients sharing a login while operating separate tabs.
- Two independent Playwright CDP connections sharing default-context cookies.
- Per-tab headers across documents, resources, navigation, frames, dedicated/nested workers, fetch, XHR, beacon, and downloads.
- SharedWorker/SW blocking, cross-agent denial, tab close, idle expiry, and download isolation.
- Browser disconnection, official subprocess SIGKILL recovery, cookie recovery, disk guard, and process/socket cleanup.
- Persistent cookies and localStorage after a full service restart, with a single synthetic login request.
- Exact hostname filtering across allowlisted and external origins, including redirects, iframe workers, classic/module/nested workers and importScripts.
- Official screenshots, Lighthouse snapshot audits and automatic traces, with cross-tab diagnostic and insight ownership checks.
- Concurrent first-run MCP startup, client header defaults, and reuse of one browser service.
- Terminal skill execution through separate CLI invocations: two execution IDs, shared login, independent actions by snapshot ref, scoped tab/download lists, rejected cross-task access, and cleanup that preserves the other task. Request evidence is written to `test-results/skill-cli-{headed,headless}.json`.

## Validation records

[Archived request-level records](https://github.com/Tsutomu-miku/cdp-browser-mcp/tree/main/docs/validation) document macOS Chrome runs in visible and `headless=new` modes. All identities and hosts in those records are synthetic.

The [Browser Stable workflow](../.github/workflows/linux.yml) installs **Google Chrome current Stable** from Google's `google-chrome-stable_current_amd64.deb` channel URL on Ubuntu 22.04 and runs the complete seven-test integration suite in `headless=new`. It prints the actual browser version and uploads `chrome-version.txt` alongside request evidence. Stable is followed automatically rather than pinned to an old major version, matching the [official browser requirements](https://github.com/ChromeDevTools/chrome-devtools-mcp#requirements). The startup and concurrent-download scenarios guard the default-context download contract: the browser-level CDP commands omit `browserContextId`, and downloads still arrive in separate agent/tab directories.

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

## 0.2.0 migration gate

The suite now contains seven integration tests. All page actions go through the controlled official MCP server. Test-only Playwright connections independently observe Chrome state and exercise native tab closure; they are not a production execution path. Every test gets an independent temporary profile and a random loopback port. `test-results/` includes separate headed/headless request evidence and diagnostic reports.

The ServiceWorker fixture asserts rejected registration before scripts or background fetch reach the synthetic server. Registration prevention is a page-entry policy; attaching Fetch only after a ServiceWorker target appears does not prevent its first network activity. No real SSO, everyday Chrome profile or extension backend is exercised by these tests. Linux headed/Xvfb and Windows are outside the measured matrix.

## Why the old Linux pins were removed

The initial pre-release run for 0.2.0 on Chrome 136/146 passed six of seven integration tests, but official diagnostics hit the existing 80-second SDK request deadline ([failed run](https://github.com/Tsutomu-miku/cdp-browser-mcp/actions/runs/43690432173)). The independently established cause is Lighthouse's use of the newer `Network.emulateNetworkConditionsByRule` CDP command, unavailable in those old browser pins. The supported baseline is current Stable or newer; the old four-test v0.1.1 results above remain historical measurements, not a 0.2 diagnostic compatibility promise.

After Linux passes, macOS Stable runs the full suite in headed and headless modes, with the two macOS jobs serialized. All jobs download from Google's live Stable channel, print the actual version and retain request evidence.

The Stable gate keeps all seven tests, deadlines and assertions intact. There is no retry, skip, platform/version branch or alternate browser implementation. The CDP download commands still omit `browserContextId` on every supported platform.

## 0.3.0 attach contracts

`npm run test:attach` (also included in `npm run check` and `npm test`) requires no Chrome. It checks all four channel arguments against the installed official 1.13.0 help, default isolated selection, explicit capability rejection, and real MCP stdio peers at the external subprocess boundary. Stopped/older Chrome, disabled debugging, denied/pending authorization and upstream death must fail without a connected claim, retain actionable guidance, and clean up the MCP subprocess. The older/denied scenarios are simulated official failures, not claims to detect those states on a real profile. Official schemas, annotations, structured results and operation errors must survive relay unchanged. Pending-approval EOF is tested with empty input and a buffered initialize request under a 120-second authorization budget; both must clean up within 5 seconds. A fragmented UTF-8 initialize request sent before approval must survive buffering.

The existing seven isolated browser tests and their deadlines/assertions remain intact. No attach contract opens Chrome, reads daily tabs, enables remote debugging or approves a dialog.

## Attach manual acceptance

**Pending: the maintainer must authorize this on their own Mac Chrome. Automated contract success does not satisfy these items.** An agent must not operate the remote-debugging switch or the connection approval dialog.

- [ ] Record the reviewed PR head, Chrome version/channel and macOS version.
- [ ] With that channel stopped, run attach; verify failure and the startup/remote-debugging/Allow instructions. Also check Chrome below 144 if available; there is no supported fallback.
- [ ] Start Chrome 144+ with remote debugging disabled: attach must fail without reporting connected.
- [ ] The human enables `chrome://inspect/#remote-debugging`. Run `mcp --mode attach` from the MCP client, decline Chrome's dialog, and verify actionable failure.
- [ ] Reconnect and leave the dialog pending: waiting status then bounded failure, never connected. Configure client startup timeout above the approval budget.
- [ ] Reconnect and **the human clicks Allow**. Verify connected, `list_pages` sees existing tabs/windows, `take_snapshot` and a harmless page operation work, and existing login is reused without a dedicated profile.
- [ ] Verify screenshot, network and console tools through official schemas; if available, repeat with `--channel beta` (or another installed channel).
- [ ] Close the MCP client or send Ctrl+C: its subprocess ends, daily Chrome and its existing tabs remain open. Reconnect and verify Chrome's approval behavior.
- [ ] Confirm attach rejects lane/header, agent/tab lease, launch/profile options and provides no independent download isolation. Do not use a sensitive download for acceptance.

Until these checks are recorded, daily-profile attach E2E remains **not performed / awaiting human authorization**. Isolated synthetic browser results and attach protocol fixtures are reported separately.

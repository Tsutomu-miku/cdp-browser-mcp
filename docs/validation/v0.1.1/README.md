# v0.1.1 platform validation

Tested source commit: `c9818f000e6b3e36d60341696dd0831f6807b453`. Subsequent release documentation adds these records without changing production code or test configuration.

| Environment      | Chrome         | Mode           | Full suite | Request evidence                           |
| ---------------- | -------------- | -------------- | ---------- | ------------------------------------------ |
| macOS arm64      | 157.0.8103.51  | Headed         | 4/4 passed | [JSON](macos-headed.json)                  |
| macOS arm64      | 157.0.8103.51  | `headless=new` | 4/4 passed | [JSON](macos-headless.json)                |
| Ubuntu 22.04 x64 | 136.0.7103.113 | `headless=new` | 4/4 passed | [JSON](linux-136.0.7103.113-headless.json) |
| Ubuntu 22.04 x64 | 146.0.7680.165 | `headless=new` | 4/4 passed | [JSON](linux-146.0.7680.165-headless.json) |

[Linux CI run and full logs](https://github.com/Tsutomu-miku/cdp-browser-mcp/actions/runs/43626922425). The pinned Linux matrix remains a regression gate on production/test changes. The existing integration test must start the browser and complete two independent downloads, including one from a cross-origin iframe. No production platform/version branches or fallback calls are used.

Each concurrent scenario recorded 44 requests, including 43 agent-tagged requests, with zero header mismatches. Files with the same suggested name reached separate `downloads/agents/A/<tab>/...` and `downloads/agents/B/<tab>/...` paths with their expected contents. Shared login, worker blocking, tab ownership, native close, idle expiry, CDP recovery, disk guards, and process/socket cleanup also passed. All sites, identities, headers, and downloaded contents are synthetic; every test uses a disposable dedicated profile and random loopback debugging port.

## Root cause and single CDP path

In v0.1.0, `src/steward.ts:96–99` obtained a page target's `browserContextId` and passed it to `Downloads` at line 121. `src/downloads.ts:53` sent that value in `Browser.setDownloadBehavior`; cancellation paths at lines 86, 135, and 145 sent it too. That page-reported ID must not be used to select this persistent default context for download commands.

v0.1.1 deletes the parameter, its constructor input, and the target-ID lookup. It calls `Browser.setDownloadBehavior` on a browser-level CDP session with `behavior`, `downloadPath`, and `eventsEnabled` only. `Browser.cancelDownload` sends the download `guid` only. The [official CDP contract](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-setDownloadBehavior) selects the default context when `browserContextId` is omitted; [cancelDownload](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-cancelDownload) has the same rule. Non-default contexts have a different contract and are not used by this service.

The staging context UUID is generated locally. It is a directory namespace, never a CDP parameter. Chrome still assigns the download GUID; the existing frame → page → agent mapping distributes the completed file. No download-isolation semantics were removed.

Linux headed/Xvfb, cross-host login migration, real business accounts, and externally managed browser providers remain unverified. The macOS tests use Chrome 157; they do not claim older macOS Chrome versions were tested.

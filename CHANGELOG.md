# Changelog

## 0.3.1

- Complete the packaged browser skill with isolated/attach mode selection, daily-Chrome setup, human authorization, official tool usage and capability/error boundaries. Update skill discovery metadata; browser behavior is unchanged from 0.3.0.

## 0.3.0

- Add explicit `mcp --mode attach` alongside the unchanged default isolated mode, implementing ADR 0001 through pinned official chrome-devtools-mcp 1.13.0 `--autoConnect` and configurable stable/beta/dev/canary channels.
- Expose official page/snapshot/network/console and diagnostic tools directly. Daily profile mode provides no lane headers, tab/pageId leases or independent download isolation; unsupported CLI options fail explicitly.
- Verify attachment with `list_pages` before accepting requests; report waiting/connected status and actionable Chrome 144+, remote-debugging and human approval instructions. Bound pending approval, propagate failures and close only the MCP subprocess on exit.
- Add Chrome-free argument/failure/stdio lifecycle contracts and document mode comparison, setup and required manual daily-browser authorization acceptance. This version change does not create a tag, Release or npm publication.

## 0.2.0

- Require Google Chrome current Stable or newer, matching the official diagnostic baseline; Linux CI follows Google's Stable channel and records its actual version instead of pinning unsupported Chrome 136/146.

- Delegate page interaction and diagnostics to pinned official chrome-devtools-mcp 1.13.0, attached through browserUrl; keep MIT orchestration and include Apache-2.0 notices.
- Use independent flat CDP sessions for tab ownership, domain-filtered lane headers, recursive worker policy and GUID downloads in the persistent default context.
- Add explicit headerDomains / --header-domains and owned browser_devtools / CLI diagnostics; preserve existing tool names and snapshot-ref syntax.
- Close Chrome gracefully so persistent login state reaches disk; recover official-server or CDP loss without replaying actions.
- Expand synthetic platform tests for domain boundaries, diagnostics and persistent login. The extension PoC remains a separate draft PR.

## 0.1.1

- Fix persistent default-context downloads by omitting `browserContextId` from browser-level CDP download settings and cancellation. A page target's context ID is not used for download commands.
- Keep GUID staging and frame → page → agent download distribution. The staging context UUID is local to the connection, not a CDP context identifier.
- Add Linux headless CI pinned to Chrome for Testing 136.0.7103.113 and 146.0.7680.165. It runs the complete suite, including concurrent per-agent download isolation.
- Verify all four tests on macOS Chrome 157.0.8103.51 headed/headless and Ubuntu 22.04 Chrome 136.0.7103.113 / 146.0.7680.165 headless, with zero request-header mismatches and isolated downloads in all four concurrent scenarios.
- See [platform validation](docs/testing.md) for measured results and remaining deployment limits.

## 0.1.0

- Shared persistent login, independent execution-owned tabs, per-tab headers, leases, and downloads.
- Skill, CLI, and MCP entry points with headed and `headless=new` modes.
- MIT license.

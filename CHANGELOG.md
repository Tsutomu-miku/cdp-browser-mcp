# Changelog

## 0.2.0-extension-poc.1 (prerelease)

- Add a local MV3 extension, an independently implemented native messaging host, and a backend interface shared with CDP.
- Add explicit existing-tab attachment, tab-scoped DNR session header rules, native health/reconnection, and screenshot tools.
- Ship a manual extension preparation/native-manifest installer, MCP examples, architecture and synthetic request evidence.
- Keep CDP as the default and preserve the v0.1.0 tag/npx entry. Extension mode targets single-lane session reuse; background workers remain unmodified. No store distribution, auto-update or registry publication.

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

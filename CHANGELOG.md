# Changelog

## 0.1.1

- Fix persistent default-context downloads by omitting `browserContextId` from browser-level CDP download settings and cancellation. A page target's context ID is not used for download commands.
- Keep GUID staging and frame → page → agent download distribution. The staging context UUID is local to the connection, not a CDP context identifier.
- Add Linux headless CI pinned to Chrome for Testing 136.0.7103.113 and 146.0.7680.165. It runs the complete suite, including concurrent per-agent download isolation.
- See [platform validation](docs/testing.md) for measured results and remaining deployment limits.

## 0.1.0

- Shared persistent login, independent execution-owned tabs, per-tab headers, leases, and downloads.
- Skill, CLI, and MCP entry points with headed and `headless=new` modes.
- MIT license.

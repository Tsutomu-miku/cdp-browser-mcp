# Changelog

## 0.2.0-extension-poc.1 (prerelease)

- Add a local MV3 extension, an independently implemented native messaging host, and a backend interface shared with CDP.
- Add explicit existing-tab attachment, tab-scoped DNR session header rules, native health/reconnection, and screenshot tools.
- Ship a manual extension preparation/native-manifest installer, MCP examples, architecture and synthetic request evidence.
- Keep CDP as the default and preserve the v0.1.0 tag/npx entry. Extension mode targets single-lane session reuse; background workers remain unmodified. No store distribution, auto-update or registry publication.

## 0.1.0

Dedicated shared-login CDP browser, agent-owned tabs, per-tab request headers and CLI/MCP entry points.

# Validation records

Captured on macOS with Node.js 22.17.0, Playwright 1.65.1, and Chrome 157.0.8103.51. The server is loopback-only; cookie values are fixed synthetic identities.

| Run              | Received requests | Agent-tagged requests | Incorrect headers | Record                           |
| ---------------- | ----------------: | --------------------: | ----------------: | -------------------------------- |
| Headless (`new`) |                44 |                    43 |                 0 | [JSON](concurrent-headless.json) |
| Visible          |                44 |                    43 |                 0 | [JSON](concurrent-headed.json)   |

Each run includes concurrent MCP operations, shared cookies, ordinary resources, frames, dedicated/nested workers, worker blocking, downloads, tab/lease cleanup, reconnect, and disk checks. Request rows record the headers actually received by the server.

- [Worker baseline](spike-baseline-headless.json): shared/background worker fetches lack a per-tab lane header.
- [Blocked headless probe](spike-block-headless.json) and [blocked visible probe](spike-block-headed.json): shared/SW scripts and fetches received by the server: zero.
- [Concurrent first startup, headless](mcp-startup-headless.json) and [visible](mcp-startup-headed.json): two MCP clients start exactly one Chrome, share a login, inherit client headers on new tabs, and release tabs on a clean disconnect.
- [CLI lifecycle](cli-lifecycle.json): detached launch, reuse, permission checks, orphan browser recovery, and process/socket cleanup.
- [Git installation](git-install.json): public Git install, npx MCP cold start/tool call/disconnect, and global tarball installation. The current npm global Git preparation failure is recorded separately.
- [Package manifest](pack.json): packaged files and integrity from an installed-bin smoke test.

These are captured records, not files rewritten by every test run. Current test output is written to `test-results/`. See [testing](../testing.md) for commands and platform scope.

- [Extension PoC: request attribution, native recovery and screenshot](extension-poc/README.md): independent headed profile; includes measured worker limits and platform caveats.

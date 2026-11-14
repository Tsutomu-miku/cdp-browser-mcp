# CDP Browser MCP

A shared Chrome browser for multiple AI agents. Log in once, give each agent its own tabs, and attach different request headers to each tab.

- **Shared login:** cookies and browser storage persist in a dedicated Chrome profile.
- **Independent tabs:** each agent owns its tabs, actions, leases, and downloads.
- **Per-tab headers:** use custom headers or named presets without changing another agent's requests.
- **Standard MCP tools:** navigate, click, type, snapshot, extract, and manage tabs through Playwright.

Requires **Node.js 22+** and **Google Chrome or Chromium** on macOS or Linux.

**Linux:** use v0.1.1 or later. v0.1.0 incorrectly supplied a page target's `browserContextId` to default-context download commands, which can reject startup. v0.1.1 omits that parameter for every platform and preserves per-agent download isolation. [Platform validation and CI](docs/testing.md) distinguish measured results from deployment guidance.

## Quick start

Run directly from GitHub:

```sh
npx --yes github:Tsutomu-miku/cdp-browser-mcp --help
```

The package is not published to the npm registry. `npx` builds and caches the Git package automatically. For a persistent local command, see [source installation](CONTRIBUTING.md).

## Connect your agent

### Skill with terminal access

Import [`skills/cdp-browser-mcp`](skills/cdp-browser-mcp/SKILL.md) into your agent's skill library. The skill uses the CLI directly, so an agent with terminal access does not need an MCP configuration or browser extension. Each execution uses a unique agent ID, shares the dedicated browser's login, and releases only its own tabs when finished.

```sh
npx --yes github:Tsutomu-miku/cdp-browser-mcp open --agent task-123 --json
npx --yes github:Tsutomu-miku/cdp-browser-mcp navigate https://example.com --agent task-123 --tab <tab-id>
npx --yes github:Tsutomu-miku/cdp-browser-mcp reclaim --agent task-123
```

Use the returned `tabId` from `open`. Browser actions print snapshots or visible text; `--json` returns structured results. Execution output stays in the agent's existing terminal/tool log. The skill does not add a UI panel or install software by itself.

### MCP tools

Add this to your client's MCP configuration:

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": [
        "--yes",
        "github:Tsutomu-miku/cdp-browser-mcp",
        "mcp",
        "--agent",
        "agent-a"
      ]
    }
  }
}
```

The MCP server starts the shared browser automatically. Give each client a different `--agent` ID; clients using the same data directory share one browser and login session.

For Codex, add to `~/.codex/config.toml`:

```toml
[mcp_servers.browser]
command = "npx"
args = ["--yes", "github:Tsutomu-miku/cdp-browser-mcp", "mcp", "--agent", "codex"]
```

Node.js and `npx` must be on the MCP client's `PATH`. See [client configuration](docs/configuration.md#mcp-clients) for local installation options.

## Log in once

```sh
npx --yes github:Tsutomu-miku/cdp-browser-mcp open https://example.com
```

Log in in the dedicated Chrome window. Other agents share that session. macOS opens a visible browser by default; Linux defaults to headless. To use a visible browser on Linux, start it with `launch --headed` in a graphical session.

The browser stays running when an MCP client exits. Its login state is stored in `~/.local/state/cdp-browser-mcp`, independently of your everyday Chrome profile.

```sh
npx --yes github:Tsutomu-miku/cdp-browser-mcp status
npx --yes github:Tsutomu-miku/cdp-browser-mcp stop
```

## Per-tab headers

Set headers for all tabs opened by an MCP client:

```json
{
  "mcpServers": {
    "blue": {
      "command": "npx",
      "args": [
        "--yes",
        "github:Tsutomu-miku/cdp-browser-mcp",
        "mcp",
        "--agent",
        "agent-a",
        "--headers",
        "{\"x-lane\":\"blue\"}"
      ]
    },
    "green": {
      "command": "npx",
      "args": [
        "--yes",
        "github:Tsutomu-miku/cdp-browser-mcp",
        "mcp",
        "--agent",
        "agent-b",
        "--headers",
        "{\"x-lane\":\"green\"}"
      ]
    }
  }
}
```

For reusable presets, use [`--config` and `--lane`](docs/configuration.md#header-presets). No configuration file is needed for the default setup.

## Tools

| Tool                                   | Purpose                                         |
| -------------------------------------- | ----------------------------------------------- |
| `browser_navigate`                     | Open a URL and return an accessibility snapshot |
| `browser_click` / `browser_type`       | Interact using snapshot refs or CSS selectors   |
| `browser_snapshot` / `browser_extract` | Read the current page                           |
| `browser_tabs` / `browser_close`       | Manage this agent's tabs                        |
| `browser_downloads`                    | List this agent's downloads                     |
| `browser_lease`                        | Extend the current tab's lease                  |

Tool names follow Playwright MCP conventions. This project provides a subset, with tab ownership and shared-session behavior added.

## Limits

**SharedWorker is disabled and ServiceWorker requests are blocked.** Those workers belong to an origin, so their background traffic cannot safely inherit a single tab's headers. Sites that require offline caches, push, or other ServiceWorker features may not work.

Cookies and same-origin storage are shared intentionally: logging out affects every agent. Tab ownership prevents accidental interference between trusted agents; it is not a security sandbox. Custom headers also accompany cross-origin HTTP requests, so open trusted sites only. WebSocket and WebTransport traffic is outside the header isolation guarantee.

## Documentation

- [Configuration, CLI commands, and MCP clients](docs/configuration.md)
- [Linux, SSH, and login state migration](docs/deployment.md)
- [Architecture and isolation model](docs/architecture.md)
- [Tests and validation records](docs/testing.md)
- [Development](CONTRIBUTING.md)

License: MIT

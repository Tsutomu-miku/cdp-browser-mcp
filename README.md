# CDP Browser MCP

A shared Chrome browser for multiple AI agents. Log in once, give each agent its own tabs, and attach different request headers to each tab.

- **Shared login:** cookies and browser storage persist in a dedicated Chrome profile.
- **Independent tabs:** each agent owns its tabs, actions, leases, and downloads.
- **Per-tab headers:** use custom headers or named presets without changing another agent's requests.
- **Standard MCP tools:** navigate, click, type, snapshot, extract, and manage tabs through official Chrome DevTools MCP.

Requires **Node.js 22.12+** and **Google Chrome current Stable or newer**, including Linux `headless=new`. This follows the [official Chrome DevTools MCP requirements](https://github.com/ChromeDevTools/chrome-devtools-mcp#requirements). Other Chromium-based browsers and older Chrome versions are outside the supported baseline.

Official diagnostics use recent CDP commands, including Lighthouse's `Network.emulateNetworkConditionsByRule`. Chrome 136/146 can pass basic browser operations yet fail those diagnostics; they are not a compatibility target for 0.2.0-dev. Linux CI installs Google's current Stable channel and prints the actual version on every run.

**Historical Linux download fix:** v0.1.0 incorrectly supplied a page target's `browserContextId` to default-context download commands, which can reject startup. v0.1.1 omits that parameter for every platform and preserves per-agent download isolation. The 0.2.0-dev browser baseline is current Stable or newer as stated above. [Platform validation and CI](docs/testing.md) distinguish measured results from deployment guidance.

**0.2.0-dev:** depends on [chrome-devtools-mcp 1.13.0](https://github.com/ChromeDevTools/chrome-devtools-mcp) (Apache-2.0). We spawn its MCP executable with `--browserUrl` pointing at our loopback Chrome; the official server does not launch or choose a profile. This project's orchestration remains MIT; see [NOTICE](NOTICE) and the [upstream license](third_party/chrome-devtools-mcp-LICENSE).

The orchestration layer owns Chrome/profile lifecycle, agent↔tab/pageId leases, domain-filtered lane headers, and downloads. Playwright is now a test-only dependency. The [extension backend PoC](https://github.com/Tsutomu-miku/cdp-browser-mcp/pull/1) remains a separate draft: daily-browser, explicitly selected tabs, single lane, no CDP port. It is not included in this branch or enabled by a configuration option. See [architecture](docs/architecture.md).

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

Set headers for all tabs opened by an MCP client, with an explicit hostname allowlist:

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
        "--header-domains",
        "[\"example.com\",\"*.example.com\"]",
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
        "--header-domains",
        "[\"example.com\",\"*.example.com\"]",
        "--headers",
        "{\"x-lane\":\"green\"}"
      ]
    }
  }
}
```

For reusable presets, use [`--config` and `--lane`](docs/configuration.md#header-presets). No configuration file is needed for the default setup. Headers require `headerDomains` or `--header-domains`; requests to other hosts carry none of the configured lane keys.

## Tools

| Tool                                   | Purpose                                                   |
| -------------------------------------- | --------------------------------------------------------- |
| `browser_navigate`                     | Open a URL and return an accessibility snapshot           |
| `browser_click` / `browser_type`       | Interact using snapshot refs or CSS selectors             |
| `browser_snapshot` / `browser_extract` | Read the current page                                     |
| `browser_tabs` / `browser_close`       | Manage this agent's tabs                                  |
| `browser_downloads`                    | List this agent's downloads                               |
| `browser_devtools`                     | Owned-page screenshot, network/console, Lighthouse, trace |
| `browser_lease`                        | Extend the current tab's lease                            |

Tool names follow Playwright MCP conventions. This project provides a subset, with tab ownership and shared-session behavior added.

## Limits

**SharedWorker is disabled and ServiceWorker registration is rejected before document scripts run.** Those workers belong to an origin, so their background traffic cannot safely inherit a single tab's headers. Sites that require offline caches, push, or other ServiceWorker features may not work.

Cookies and same-origin storage are shared intentionally: logging out affects every agent. Tab ownership prevents accidental interference between trusted agents; it is not a security sandbox. Custom headers accompany HTTP(S) requests only to the explicitly allowlisted hostnames; validate that list before sending sensitive values. WebSocket and WebTransport traffic is outside the header isolation guarantee.

## Documentation

- [Configuration, CLI commands, and MCP clients](docs/configuration.md)
- [Linux, SSH, and login state migration](docs/deployment.md)
- [Architecture and isolation model](docs/architecture.md)
- [Tests and validation records](docs/testing.md)
- [Development](CONTRIBUTING.md)

License: MIT

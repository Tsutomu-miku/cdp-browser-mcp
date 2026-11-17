# CDP Browser MCP

Use a dedicated shared Chrome for multiple AI agents, or attach to your daily Chrome with its existing login. The default remains **isolated**. The following ownership/header guarantees apply to isolated mode.

- **Shared login:** cookies and browser storage persist in a dedicated Chrome profile.
- **Independent tabs:** each agent owns its tabs, actions, leases, and downloads.
- **Per-tab headers:** use custom headers or named presets without changing another agent's requests.
- **Standard MCP tools:** navigate, click, type, snapshot, extract, and manage tabs through official Chrome DevTools MCP.

Requires **Node.js 22.12+** and **Google Chrome current Stable or newer**, including Linux `headless=new`. This follows the [official Chrome DevTools MCP requirements](https://github.com/ChromeDevTools/chrome-devtools-mcp#requirements). Other Chromium-based browsers and older Chrome versions are outside the supported baseline.

Official diagnostics use recent CDP commands, including Lighthouse's `Network.emulateNetworkConditionsByRule`. Chrome 136/146 can pass basic browser operations yet fail those diagnostics; they are not a compatibility target for isolated mode. Linux CI installs Google's current Stable channel and prints the actual version on every run.

**Historical Linux download fix:** v0.1.0 incorrectly supplied a page target's `browserContextId` to default-context download commands, which can reject startup. v0.1.1 omits that parameter for every platform and preserves per-agent download isolation. The 0.2.0 browser baseline is current Stable or newer as stated above. [Platform validation and CI](docs/testing.md) distinguish measured results from deployment guidance.

**0.3.0:** depends on [chrome-devtools-mcp 1.13.0](https://github.com/ChromeDevTools/chrome-devtools-mcp) (Apache-2.0). Isolated mode spawns its MCP executable with `--browserUrl` pointing at our loopback Chrome. Attach mode uses `--autoConnect --channel stable` to connect to Chrome started by you. This project's orchestration remains MIT; see [NOTICE](NOTICE) and the [upstream license](third_party/chrome-devtools-mcp-LICENSE).

The isolated orchestration layer owns Chrome/profile lifecycle, agent↔tab/pageId leases, domain-filtered lane headers, and downloads. Playwright is a test-only dependency. Per [ADR 0001](docs/adr/0001-reject-self-built-extension-use-official-autoconnect.md), the extension PoC was closed and remains historical; daily Chrome uses only the official autoConnect path.

## Two modes

The packaged [agent skill](skills/cdp-browser-mcp/SKILL.md#选择模式isolated-vs-attach) covers both modes and their selection criteria.

|                      | `isolated` (default)                                | `attach` (new in 0.3.0)                                                                         |
| -------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Best for             | Multiple lanes/agents, CI                           | Daily tabs, existing login, human inspection                                                    |
| Chrome/profile       | We launch a dedicated profile                       | You start Chrome; official server chooses the channel's default profile, all windows            |
| Entry                | Existing CLI commands; `mcp --agent <execution-id>` | `mcp --mode attach [--channel stable]`                                                          |
| Tools                | `browser_*` with owned tabs                         | Official tools unchanged: `list_pages`, `navigate_page`, `take_snapshot`, network/console, etc. |
| Lane headers         | Explicit per-tab/domain policy                      | Unsupported; lane/header options are rejected                                                   |
| Tab/pageId ownership | Execution leases                                    | No leases or multi-agent isolation; official page IDs are not ownership tokens                  |
| Downloads            | Dedicated profile and agent/tab directories         | Official behavior in your daily profile; no independent profile/download isolation              |
| Shutdown             | CLI `stop` closes our Chrome                        | EOF/Ctrl+C stops the MCP connection/subprocess; your Chrome stays open                          |

### Attach to daily Chrome

After installing/building this version:

1. **You** start Google Chrome **144+** in the desired channel. Check/update its version at `chrome://settings/help`. For the complete official diagnostic toolset, use current Stable or newer as required above.
2. Open `chrome://inspect/#remote-debugging` and enable **Remote Debugging**. Only the human user should change this setting.
3. Start the attach server in one command (from a clone, substitute `node dist/cli.js`):

   ```zsh
   cdp-browser-mcp mcp --mode attach
   ```

4. **You** click **Allow / 允许** in Chrome's connection approval dialog. An agent must not click it for you. Chrome may request approval on each connection. No permanent/unattended approval is promised.

For an MCP client, use:

```json
{
  "mcpServers": {
    "daily-chrome": {
      "command": "cdp-browser-mcp",
      "args": ["mcp", "--mode", "attach", "--channel", "stable"]
    }
  }
}
```

`--channel` accepts `stable` (default), `beta`, `dev`, or `canary`. Match the Chrome you started. Set the client's startup timeout above the approval budget (for example, Codex `startup_timeout_sec = 60`). `--attach-timeout-ms 30000` is the default timeout for each upstream initialization/connection request; supported values are 1000–120000. After successful initialization, a `list_pages` probe must succeed before this adapter accepts MCP requests. Stderr reports `waiting-for-authorization` (connecting, **not yet authorized**), then `connected` only after the probe. This is a stdio MCP server: configure it in your client to operate pages, rather than typing CLI page commands into its terminal.

If it fails, the error preserves the official reason and tells you to start/update Chrome, enable remote debugging at `chrome://inspect/#remote-debugging`, and allow the connection dialog, then retry. A timeout can mean approval is pending; it does not establish rejection. The official server can return the same error for stopped Chrome, old Chrome, disabled debugging, or refused approval, so this adapter does not invent a more precise diagnosis. There is no automatic retry or fallback browser. Version 1.13.0 has no `--autoConnectPort` flag; none is passed.

Attach exposes the official tool schemas/results directly, including screenshots, snapshots, page actions, network and console tools. Use `list_pages` and the official `pageId` parameters to choose daily tabs. There is no second page-action backend. Attach rejects `--agent`, `--tab`, `--lane`, `--headers`, `--header-domains`, `--config`, `--state-dir`, `--executable-path`, `--headed` and `--headless` instead of implying isolated guarantees or launching settings. `launch`, `status`, `stop` and other CLI commands with `--mode attach` are rejected: the MCP client owns this foreground connection. Omitting `--mode` always selects isolated.

**Trust boundary:** daily profile access includes its login state and all windows. It is not a tenant boundary. Official page-wide emulation headers, if used directly, have official semantics and no lane/domain policy. The adapter installs no header interception, worker policy, tab lease map, download routing or dedicated workspace/profile. Run one trusted operator; use isolated mode for cooperating agents and separate profiles/instances for different tenants. Native official tools can modify pages and write files with the user's permissions.

The daily-browser authorization/UI flow remains a [manual acceptance item](docs/testing.md#attach-manual-acceptance); automated contract tests never approve dialogs or claim real-profile E2E coverage.

## Quick start

### 1. Release installer (recommended)

Install Node.js 22.12+, npm and curl first. Download the installer and run it in one line:

```sh
curl -fsSL https://raw.githubusercontent.com/Tsutomu-miku/cdp-browser-mcp/main/scripts/install.sh -o install.sh && sh install.sh
```

The default is the latest GitHub Release. Pin a published tag and choose a no-root prefix:

```sh
curl -fsSL https://raw.githubusercontent.com/Tsutomu-miku/cdp-browser-mcp/main/scripts/install.sh -o install.sh && VERSION=v0.2.0 NPM_CONFIG_PREFIX="$HOME/.local" sh install.sh
export PATH="$HOME/.local/bin:$PATH"
cdp-browser-mcp --version
```

`v0.2.0` is an example: choose a published tag that contains `cdp-browser-mcp-<version>.tgz`. The installer downloads that prebuilt archive, uses npm as a local installer for its three runtime dependencies and bin link, checks `--version`, and prints MCP configuration. It never runs sudo. Missing Release assets fail explicitly and do not trigger a source build. See [installer options and permissions](docs/deployment.md#installation).

**This project does not publish to npmjs. The public npm package with the same name is unrelated.** Do not install this project by registry name (`npm install -g cdp-browser-mcp` or `npx cdp-browser-mcp`). Runtime dependencies are still fetched from your configured npm registry.

### 2. Build from a clone

```sh
git clone https://github.com/Tsutomu-miku/cdp-browser-mcp.git
cd cdp-browser-mcp
npm ci
npm run build
node dist/cli.js --version
```

See [development](CONTRIBUTING.md) to install your own built archive as a command.

## Connect your agent (isolated)

### Skill with terminal access

Import [`skills/cdp-browser-mcp`](skills/cdp-browser-mcp/SKILL.md) into your agent's skill library. The skill uses the CLI directly, so an agent with terminal access does not need an MCP configuration or browser extension. Each execution uses a unique agent ID, shares the dedicated browser's login, and releases only its own tabs when finished.

```sh
cdp-browser-mcp open --agent task-123 --json
cdp-browser-mcp navigate https://example.com --agent task-123 --tab <tab-id>
cdp-browser-mcp reclaim --agent task-123
```

Use the returned `tabId` from `open`. Browser actions print snapshots or visible text; `--json` returns structured results. Execution output stays in the agent's existing terminal/tool log. The skill does not add a UI panel or install software by itself.

### MCP tools

Add this to your client's MCP configuration:

```json
{
  "mcpServers": {
    "browser": {
      "command": "cdp-browser-mcp",
      "args": ["mcp", "--agent", "agent-a"]
    }
  }
}
```

The MCP server starts the shared browser automatically. Give each client a different `--agent` ID; clients using the same data directory share one browser and login session.

For Codex, add to `~/.codex/config.toml`:

```toml
[mcp_servers.browser]
command = "cdp-browser-mcp"
args = ["mcp", "--agent", "codex"]
```

Node.js and the prefix's `bin` directory must be on the MCP client's `PATH`. If the client does not inherit your shell PATH, use the installed command's absolute path. See [client configuration](docs/configuration.md#mcp-clients).

## Log in once (isolated)

```sh
cdp-browser-mcp open https://example.com
```

Log in in the dedicated Chrome window. Other agents share that session. macOS opens a visible browser by default; Linux defaults to headless. To use a visible browser on Linux, start it with `launch --headed` in a graphical session.

The browser stays running when an MCP client exits. Its login state is stored in `~/.local/state/cdp-browser-mcp`, independently of your everyday Chrome profile.

```sh
cdp-browser-mcp status
cdp-browser-mcp stop
```

## Per-tab headers (isolated)

Set headers for all tabs opened by an MCP client, with an explicit hostname allowlist:

```json
{
  "mcpServers": {
    "blue": {
      "command": "cdp-browser-mcp",
      "args": [
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
      "command": "cdp-browser-mcp",
      "args": [
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

## Tools (isolated)

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

## Limits (isolated)

**SharedWorker is disabled and ServiceWorker registration is rejected before document scripts run.** Those workers belong to an origin, so their background traffic cannot safely inherit a single tab's headers. Sites that require offline caches, push, or other ServiceWorker features may not work.

Cookies and same-origin storage are shared intentionally: logging out affects every agent. Tab ownership prevents accidental interference between trusted agents; it is not a security sandbox. Custom headers accompany HTTP(S) requests only to the explicitly allowlisted hostnames; validate that list before sending sensitive values. WebSocket and WebTransport traffic is outside the header isolation guarantee.

## Documentation

- [Configuration, CLI commands, and MCP clients](docs/configuration.md)
- [Linux, SSH, and login state migration](docs/deployment.md)
- [Architecture and isolation model](docs/architecture.md)
- [Tests and validation records](docs/testing.md)
- [Development](CONTRIBUTING.md)

License: MIT

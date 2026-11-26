# CDP Browser MCP

Coordinate multiple AI coding agents on one shared Chrome profile with per-agent tab, header, and download isolation — or reuse your everyday signed-in Chrome tabs through a browser extension or attended remote debugging.

- **Three explicit modes:** `isolated` (default), `extension` (daily Chrome without per-session approval), and `attach` (attended `--autoConnect`).
- **Isolated multi-agent safety:** shared persistent login with per-agent tab leases, domain-filtered request headers, and per-agent downloads.
- **Official DevTools backend:** built on pinned, unmodified [chrome-devtools-mcp 1.13.0](https://github.com/ChromeDevTools/chrome-devtools-mcp) (Apache-2.0; this project's orchestration is MIT, see [NOTICE](NOTICE)).

**Requirements:** **Node.js 22.12+** and **Google Chrome current Stable or newer** on macOS or Linux (including Linux `headless=new`), matching the [official requirements](https://github.com/ChromeDevTools/chrome-devtools-mcp#requirements). Other Chromium-based browsers and older Chrome releases are outside the supported baseline.

## Choose a mode

Omitting `--mode` always selects `isolated`. The packaged [agent skill](skills/cdp-browser-mcp/SKILL.md) also covers mode selection.

| Mode                 | Best for                                     | Command                                                  | Guarantees & limits                                                                                 |
| -------------------- | -------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `isolated` (default) | Parallel tasks, lane headers, CI, unattended | `cdp-browser-mcp mcp --agent <id>`                       | Dedicated Chrome profile, shared login, per-agent tab leases, domain-filtered headers and downloads |
| `extension`          | Routine work in signed-in daily Chrome tabs  | `cdp-browser-mcp mcp --mode extension --state-dir <dir>` | One-time extension + scope consent, shared backend, per-client page claims; no per-session Allow    |
| `attach`             | One-off attended sessions in everyday Chrome | `cdp-browser-mcp mcp --mode attach --channel stable`     | Human enables remote debugging and clicks Allow per connection; no leases or isolation              |

## Install

> **Not published on npmjs.** The public `cdp-browser-mcp` package on npmjs is unrelated — do **not** run `npm install -g cdp-browser-mcp` or `npx cdp-browser-mcp`.

### 1. Release installer (recommended)

Requires `node` (22.12+), `npm`, and `curl`. Installs the latest GitHub Release archive without `sudo`:

```sh
curl -fsSL https://raw.githubusercontent.com/Tsutomu-miku/cdp-browser-mcp/main/scripts/install.sh -o install.sh && sh install.sh
```

Pin a specific release tag and install under a user-writable prefix:

```sh
curl -fsSL https://raw.githubusercontent.com/Tsutomu-miku/cdp-browser-mcp/main/scripts/install.sh -o install.sh && VERSION=v0.4.0 NPM_CONFIG_PREFIX="$HOME/.local" sh install.sh
export PATH="$HOME/.local/bin:$PATH"
cdp-browser-mcp --version
```

The installer downloads `cdp-browser-mcp-<version>.tgz` from GitHub Releases, installs its runtime dependencies locally via `npm`, verifies `--version`, and prints a ready-to-use MCP config. Missing release assets fail explicitly without attempting a source build. See [installer options and permissions](docs/deployment.md#installation).

### 2. Build from source

```sh
git clone https://github.com/Tsutomu-miku/cdp-browser-mcp.git
cd cdp-browser-mcp
npm ci
npm run build
node dist/cli.js --version
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to pack and install a local build as a global command.

## Isolated mode (default)

Starts or reuses a dedicated Chrome process with persistent state in `~/.local/state/cdp-browser-mcp`, independent of your daily Chrome profile. macOS opens a visible window by default; Linux defaults to `headless=new` (use `launch --headed` in a graphical session).

### Connect via MCP

Give each concurrent client a unique `--agent` ID; clients pointing at the same state directory share one browser and login session.

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

For Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.browser]
command = "cdp-browser-mcp"
args = ["mcp", "--agent", "codex"]
```

Ensure `node` and your install prefix's `bin` directory are on the MCP client's `PATH`, or use the absolute path to `cdp-browser-mcp`. See [client configuration](docs/configuration.md#mcp-clients).

### Connect via CLI / Agent Skill

Import [`skills/cdp-browser-mcp`](skills/cdp-browser-mcp/SKILL.md) into your agent's skill library to drive the shared browser directly from the terminal without MCP config or a browser extension:

```sh
cdp-browser-mcp open --agent task-123 --json
cdp-browser-mcp navigate https://example.com --agent task-123 --tab <tab-id>
cdp-browser-mcp reclaim --agent task-123
```

### Log in once & manage lifecycle

```sh
cdp-browser-mcp open https://example.com   # sign in once; other agents reuse the session
cdp-browser-mcp status                     # inspect browser health, agents, tabs, downloads
cdp-browser-mcp stop                       # stop the dedicated browser, retaining login state
```

### Per-tab lane headers

Attach custom HTTP(S) headers per agent with an explicit hostname allowlist (`--header-domains` is required; non-matching hosts receive no lane headers):

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

For reusable named presets, see [`--config` and `--lane`](docs/configuration.md#header-presets).

### Isolated MCP tools

| Tool                                   | Purpose                                                   |
| -------------------------------------- | --------------------------------------------------------- |
| `browser_navigate`                     | Open a URL and return an accessibility snapshot           |
| `browser_click` / `browser_type`       | Interact using snapshot refs or CSS selectors             |
| `browser_snapshot` / `browser_extract` | Read the current page                                     |
| `browser_tabs` / `browser_close`       | Manage this agent's tabs                                  |
| `browser_downloads`                    | List this agent's downloads                               |
| `browser_devtools`                     | Owned-page screenshot, network/console, Lighthouse, trace |
| `browser_lease`                        | Extend the current tab's lease                            |

## Daily Chrome via extension

Reuse your everyday signed-in Chrome tabs across MCP sessions without enabling Chrome remote debugging or clicking **Allow** on every session. See [docs/extension.md](docs/extension.md) for the complete installation and security guide (and [ADR 0002](docs/adr/0002-extension-daily-chrome.md)).

### Quick setup (macOS and Linux)

1. **Prepare the extension directory** (keep the path stable so the extension ID does not change):

   ```zsh
   cdp-browser-mcp-extension-setup prepare --output "$HOME/.local/share/cdp-browser-mcp-extension"
   ```

2. **Load unpacked in Chrome:** open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select that directory, and copy its Extension ID.
3. **Register the user-level Native Messaging host** (point `--browser-user-data-dir` at the Chrome root, not `Default`):

   ```zsh
   cdp-browser-mcp-extension-setup install-native \
     --extension-id '<extension-id>' \
     --state-dir "$HOME/.local/state/cdp-browser-mcp-extension" \
     --browser-user-data-dir "$HOME/Library/Application Support/Google/Chrome"
   ```

   _(On Linux, typically `$HOME/.config/google-chrome`.)_

4. **Grant website access in the popup:** click the **CDP Browser MCP** toolbar icon, choose **Approved websites** (exact `http(s)` origins) or **Allow all websites**, optionally list **Sensitive origins to hide**, and click **Save and enable access**. Use **Pause all access** anytime to disconnect immediately.
5. **Configure your MCP client** (no installer edits client config automatically):

   ```json
   {
     "mcpServers": {
       "daily-chrome": {
         "command": "cdp-browser-mcp",
         "args": [
           "mcp",
           "--mode",
           "extension",
           "--state-dir",
           "/absolute/path/to/extension-state"
         ]
       }
     }
   }
   ```

### Extension behavior & limits

- **Shared backend & page claims:** MCP initialization never touches Chrome. Clients share one native host and official backend; call `list_pages`, pass explicit `pageId`, and call `extension_release_page` (or disconnect) to release a tab without closing it.
- **Core page toolset:** exposes page selection, snapshots, screenshots, clicks/drag/hover/fill/keys, evaluation, navigation, dialogs, and page-scoped network/console tools — not tab creation/closing, cookie export, file uploads, downloads, emulation, or browser-wide tracing/Lighthouse.
- **Browser UI & human consent:** Chrome's debugger infobar may still appear; there is no silent flag or policy override. Only the local extension popup changes consent.

## Daily Chrome via attended attach

For one-off attended sessions using official `chrome-devtools-mcp --autoConnect` without installing an extension:

1. Start Google Chrome **144+** (current Stable or newer for the full diagnostic toolset).
2. Open `chrome://inspect/#remote-debugging` and enable **Remote Debugging**.
3. Configure your MCP client (or run `cdp-browser-mcp mcp --mode attach`):

   ```json
   {
     "mcpServers": {
       "daily-chrome-attach": {
         "command": "cdp-browser-mcp",
         "args": ["mcp", "--mode", "attach", "--channel", "stable"]
       }
     }
   }
   ```

4. Click **Allow** in Chrome's connection approval dialog when prompted. Chrome may request approval on each new connection.

- **Options:** `--channel` accepts `stable` (default), `beta`, `dev`, or `canary`. `--attach-timeout-ms` defaults to `30000` (range `1000`–`120000`); set your MCP client's startup timeout above that budget (e.g., Codex `startup_timeout_sec = 60`).
- **Status & errors:** stderr logs `waiting-for-authorization` before `list_pages` succeeds, then `connected`. Failures preserve the upstream error without automatic retry or fallback.
- **Unsupported flags:** `launch`/`status`/`stop` and isolated flags (`--agent`, `--tab`, `--lane`, `--headers`, `--header-domains`, `--config`, `--state-dir`, `--executable-path`, `--headed`, `--headless`) are rejected explicitly.
- Daily-profile approval remains a [manual acceptance step](docs/testing.md#attach-manual-acceptance).

## Security & isolation boundaries

- **Isolated mode:** cookies and same-origin storage are intentionally shared across agents; tab ownership prevents accidental interference among trusted agents rather than acting as an adversarial sandbox. **SharedWorker is disabled and ServiceWorker registration is rejected** before page scripts run so background traffic cannot bypass per-tab headers; sites requiring offline caches or push workers may not work. Lane headers apply only to HTTP(S) requests matching `headerDomains` (WebSocket and WebTransport traffic are outside this guarantee).
- **Daily Chrome (`extension` and `attach`):** exposes your signed-in daily profile and provides no account/tenant boundary, lane headers, or download isolation. Origin filtering in extension mode helps coordinate trusted local agents, not act as a network firewall or security sandbox; native tools run with the user's permissions and return page content to the calling MCP client.

## Documentation

- [Daily Chrome extension guide](docs/extension.md) — setup, consent, concurrency, security, and uninstall
- [Configuration, CLI & MCP clients](docs/configuration.md) — options, header presets, CLI reference, and migration
- [Deployment](docs/deployment.md) — installer options, Linux headless, SSH, and login state
- [Architecture](docs/architecture.md) — isolation model, CDP routing, and ADRs ([0001](docs/adr/0001-reject-self-built-extension-use-official-autoconnect.md), [0002](docs/adr/0002-extension-daily-chrome.md))
- [Testing & validation records](docs/testing.md) — automated suites, platform checks, and manual acceptance
- [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Chrome Web Store draft](CHROMEWEBSTORE.md)

License: MIT · Upstream attribution: [NOTICE](NOTICE) · [chrome-devtools-mcp license](third_party/chrome-devtools-mcp-LICENSE)

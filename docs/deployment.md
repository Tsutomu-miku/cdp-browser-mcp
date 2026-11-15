# Deployment

## Installation

### 1. Release installer (recommended)

Requires Node.js 22.12+, npm and curl on macOS or Linux; Google Chrome current Stable or newer is needed for browser actions. The installer is POSIX sh and does not compile source or install system dependencies.

```sh
curl -fsSL https://raw.githubusercontent.com/Tsutomu-miku/cdp-browser-mcp/main/scripts/install.sh -o install.sh && sh install.sh
```

| Environment variable | Default                 | Contract                                                                                 |
| -------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| `VERSION`            | `latest`                | Published GitHub Release tag, for example `v0.2.0`; asset is `cdp-browser-mcp-0.2.0.tgz` |
| `NPM_CONFIG_PREFIX`  | `npm config get prefix` | Absolute npm global prefix; command is linked at `<prefix>/bin/cdp-browser-mcp`          |
| `TMPDIR`             | `/tmp`                  | Temporary download directory, removed on exit                                            |

For a reproducible selection, set `VERSION` to a published tag with a tgz asset. `v0.2.0` below is an example, not a claim that this Release exists. To pin the installer source too, replace `main` in its download URL with that tag once the tag includes the installer.

```sh
curl -fsSL https://raw.githubusercontent.com/Tsutomu-miku/cdp-browser-mcp/main/scripts/install.sh -o install.sh && VERSION=v0.2.0 NPM_CONFIG_PREFIX="$HOME/.local" sh install.sh
export PATH="$HOME/.local/bin:$PATH"
cdp-browser-mcp --version
```

The installer never invokes sudo. An unwritable prefix fails with this no-root alternative; npm errors are retained. Include `<prefix>/bin` and Node.js on the MCP client's PATH too, or configure the command's absolute path. The final installer output includes `command: cdp-browser-mcp` and `args: ["mcp", "--agent", "agent-a"]`; choose a different agent ID per client.

The installer resolves latest through GitHub Releases, downloads only `releases/download/<tag>/cdp-browser-mcp-<version>.tgz`, then runs `npm install --global --omit=dev <local-tgz>`. npm installs the three declared runtime dependencies (`@modelcontextprotocol/sdk`, `chrome-devtools-mcp`, `zod`) and their transitive dependencies; development dependencies are omitted. The archive already contains `dist/`, skills, examples, docs and license notices. Missing Releases/tgz files fail with an explicit suggestion to clone and build; there is no automatic Git fallback or temporary compilation.

**This project does not publish to npmjs. The public npm package with the same name is unrelated.** npm is a local archive installer here and still uses your configured registry for dependencies. Never substitute a registry-name install for the local archive.

### 2. Build from a clone

```sh
git clone https://github.com/Tsutomu-miku/cdp-browser-mcp.git
cd cdp-browser-mcp
npm ci
npm run build
node dist/cli.js --version
```

Run `node /absolute/path/cdp-browser-mcp/dist/cli.js ...` directly, or follow [development](../CONTRIBUTING.md) to pack and install your own build. Release maintainers should follow the [tag artifact process](../CONTRIBUTING.md#release-artifacts).

## Linux

Install the command using one of the methods above before following these examples.

Install Node.js 22.12+ and Google Chrome current Stable or newer using your system's package manager. This minimum also applies to Linux headless=new and follows the [official chrome-devtools-mcp requirements](https://github.com/ChromeDevTools/chrome-devtools-mcp#requirements). Older Chrome and other Chromium browsers are not supported for the full diagnostic toolset. The tool does not install browsers or system dependencies. Linux uses `--headless=new` by default:

```sh
cdp-browser-mcp launch --headless --state-dir /srv/browser-data
cdp-browser-mcp status --state-dir /srv/browser-data
cdp-browser-mcp stop --state-dir /srv/browser-data
```

Run Chrome as a non-root user with its sandbox enabled. Set `--executable-path` if Chrome is installed outside the detected system paths.

For a graphical session or manual login, use `--headed`. If Xvfb is already installed, keep the service in the foreground so its display stays alive:

```sh
xvfb-run -a cdp-browser-mcp serve --headed --state-dir /srv/browser-data
```

Xvfb provides a display, not an interactive desktop; use an authenticated remote desktop/VNC session when a person needs to log in. Fonts, graphics, and site behavior may differ from a local macOS session.

## Remote MCP over SSH

Keep the MCP process on the browser host and forward its stdio over authenticated SSH:

```json
{
  "mcpServers": {
    "browser": {
      "command": "ssh",
      "args": [
        "-T",
        "browser-host",
        "cdp-browser-mcp",
        "mcp",
        "--agent",
        "agent-a",
        "--state-dir",
        "/srv/browser-data"
      ]
    }
  }
}
```

Use an absolute executable path if the remote non-interactive `PATH` does not include your npm bin directory. Downloads stay on the browser host and can be retrieved with SFTP/SCP.

CDP is restricted to loopback; the control plane has no TCP listener. If an administrator needs direct CDP debugging, use an SSH tunnel to a fixed `cdpPort` configured for that instance:

```sh
ssh -N -L 127.0.0.1:19229:127.0.0.1:9229 browser-host
```

CDP has no built-in user authentication. Never expose its port publicly or give raw CDP access to clients that should only own their tabs.

## Login state

The simplest approach is to log in once on the destination's dedicated profile. Stop the instance before changing the display mode.

Browser profiles contain host-bound encrypted data. Copying a macOS profile to Linux generally does not preserve usable cookies. Do not copy your everyday profile into this tool.

For a site that permits portable login state, an administrator can export Playwright `context.storageState()` from the dedicated default context and transfer it with SSH. Import cookies with `context.addCookies()` in the destination instance; localStorage must be restored on a managed tab at each matching origin. There is no built-in state import/export command. IndexedDB, sessionStorage, passkeys, client certificates, and device-bound logins may require separate handling or a new login. Do not migrate ServiceWorker registrations or CacheStorage.

Treat exports as credentials: keep them outside the repository, restrict permissions, and delete them when no longer needed.

## Data and logs

The data directory contains the persistent profile, completed downloads, protected control files, and rotating `events.jsonl` logs. `stop` cleans sockets and processes while preserving user data. To remove it permanently, stop the instance first and review the directory before deleting it.

Startup settings are recorded in `launch-config.json` after acquiring the service lock. Header values in configuration files and login data are sensitive even though request event logs omit their values.

## Remote browser providers

Connecting to an externally managed CDP service is not implemented. A future adapter must provide a shared default context, persistent profile, authenticated CDP, startup worker policy, disconnection shutdown, frame ownership, and authenticated download retrieval by context/download GUID. Local download paths cannot be used directly for a remote browser.

See [testing](testing.md) for the platforms and workflows currently validated.

## Official server lifecycle (0.2.0-dev)

The supervisor owns both Chrome and the official MCP subprocess. The subprocess uses the installed, pinned `chrome-devtools-mcp@1.13.0` executable with `--browserUrl http://127.0.0.1:<allocated-port>`, `--pageIdRouting`, and structured results; usage statistics and CrUX URL submission are disabled. No runtime `npx` resolution or upstream Chrome launch occurs. Keep Node and the installed command on the service PATH. The Release installer installs runtime dependencies; source checkouts use `npm ci`.

Normal stop uses `Browser.close` and waits for Chrome to finish writing its profile. Persistent cookies and localStorage survive a service restart. Session cookies additionally have an in-memory snapshot for connection recovery; that snapshot does not survive a service restart. Actual SSO policy may require reauthentication. A lost CDP connection or official subprocess restarts only this dedicated Chrome and invalidates old leases; actions are never replayed. Use an independent `stateDir` and port (`cdpPort: 0` by default) for each independent service or test run.

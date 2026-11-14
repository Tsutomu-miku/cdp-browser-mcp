# Configuration

The default setup needs no configuration file. CLI options override the optional JSON configuration:

```sh
cdp-browser-mcp mcp --agent agent-a --headless
cdp-browser-mcp mcp --agent agent-b --state-dir /path/to/browser-data
cdp-browser-mcp launch --executable-path /path/to/chrome
```

All clients must use the same `stateDir` to share a browser. Browser startup settings are chosen by the first client that starts the service. Later clients reuse it; to change the display mode, Chrome path, or header presets, stop the service and start it with the new configuration.

For example:

```sh
cdp-browser-mcp stop
cdp-browser-mcp launch --headless
```

## Header presets

Save a configuration file, for example `browser.json`:

```json
{
  "lanes": {
    "default": {},
    "blue": { "x-lane": "blue" },
    "green": { "x-lane": "green" }
  }
}
```

```sh
cdp-browser-mcp mcp --config ./browser.json --agent agent-a --lane blue
cdp-browser-mcp mcp --config ./browser.json --agent agent-b --lane green
```

`--headers '{"x-custom":"value"}'` adds or overrides headers for that client's tabs. `browser_tabs(action="new", headers={...})` can override them on an individual tab. Precedence is: preset, client headers, new-tab headers. Header names are case insensitive.

Only custom request headers are supported. `Cookie`, `Authorization`, `Host`, and connection-level headers are rejected. The browser manages cookies itself. Headers apply to a tab's HTTP(S) requests, including redirects, iframes, dedicated and nested workers, fetch, XHR, beacon, and downloads. They also apply across origins. SharedWorker and ServiceWorker are blocked; see [isolation](architecture.md#worker-policy).

## Options

| JSON key           | Default                          | Description                                        |
| ------------------ | -------------------------------- | -------------------------------------------------- |
| `stateDir`         | `~/.local/state/cdp-browser-mcp` | Dedicated profile, downloads, and runtime files    |
| `executablePath`   | Auto-detected                    | Chrome/Chromium executable                         |
| `cdpPort`          | `0`                              | Loopback debug port; `0` selects an available port |
| `headless`         | Linux: `true`; macOS: `false`    | Uses Chrome's `headless=new` mode                  |
| `leaseMs`          | `300000`                         | Idle tab timeout, in milliseconds                  |
| `maxTabs`          | `20`                             | Maximum managed tabs                               |
| `minFreeBytes`     | `536870912`                      | Minimum free disk space                            |
| `maxDownloadBytes` | `1073741824`                     | Download storage soft limit                        |
| `maxLogBytes`      | `5242880`                        | Log rotation threshold per file                    |
| `actionTimeoutMs`  | `15000`                          | Browser action timeout                             |
| `lanes`            | `{ "default": {} }`              | Named header presets                               |

Unknown keys are rejected. Relative `stateDir` values are resolved against the configuration file's directory. Use an absolute path for `executablePath`. Paths are literal; `~` is not expanded inside JSON. Keep the full Unix socket path (`stateDir/control.sock`) within 100 bytes.

## CLI reference

```text
cdp-browser-mcp mcp --agent <id>        Start MCP; start/reuse the shared browser
cdp-browser-mcp open [url]              Open a tab (default agent: manual)
cdp-browser-mcp launch                  Start the browser in the background
cdp-browser-mcp serve                   Run the browser service in the foreground
cdp-browser-mcp status                  Display health, agents, tabs and downloads
cdp-browser-mcp close --agent <id> --tab <id>
cdp-browser-mcp renew --agent <id> --tab <id>
cdp-browser-mcp reclaim --agent <id>     Close all tabs and revoke the agent session
cdp-browser-mcp reconnect               Restart Chrome, releasing existing leases
cdp-browser-mcp stop                    Stop browser/service; retain user data
```

Common options: `--config`, `--state-dir`, `--executable-path`, `--headed`, `--headless`, `--json`, `--version`, `--help`. `mcp` and `open` also accept `--lane` and `--headers`; `open` accepts `--agent` and `--url` as an alternative to the positional URL. Management commands print readable output by default; `--json` returns structured results for scripts. MCP stdout is reserved for protocol traffic.

Each successful browser action renews the tab lease. Manual login tabs expire too: use `renew` with the ID printed by `open`, or configure a longer `leaseMs`. Closing a tab, expiry, or a clean MCP disconnect releases ownership and cancels its unfinished downloads. A force-killed MCP client loses its idle tabs on expiry; if its agent ID remains registered, `reclaim` releases the registration.

`stop` affects only the dedicated browser service. It preserves profiles and finished downloads. If it was started with a custom data directory, use the same `--state-dir` or `--config` when stopping it.

## MCP clients

Use a different `--agent` ID per concurrent MCP process. The MCP server lazily creates its first tab. The background browser is shared and remains running until `stop`; disconnecting one client does not stop other clients.

For a client that cannot find the globally installed binary, use `npx`:

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": [
        "--yes",
        "--package=git+https://github.com/Tsutomu-miku/cdp-browser-mcp.git",
        "cdp-browser-mcp",
        "mcp",
        "--agent",
        "agent-a"
      ]
    }
  }
}
```

Git installations run the package's `prepare` build. If your package manager blocks lifecycle scripts, follow [source installation](../CONTRIBUTING.md) and configure the resulting executable path instead. Do not disable your global script policy just to install this tool.

Codex supports the same command and args in [`config.toml`](https://learn.chatgpt.com/docs/extend/mcp?surface=cli):

```toml
[mcp_servers.browser]
command = "cdp-browser-mcp"
args = ["mcp", "--agent", "codex"]
```

After a browser restart, refs and leases from previous tabs are invalid. Use `browser_tabs` to list or create tabs before continuing.

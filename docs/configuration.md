# Configuration

Requires Google Chrome current Stable or newer on macOS or Linux, including headless=new. The default setup needs no configuration file. Examples below use the installed `cdp-browser-mcp` command. For a source checkout, replace it with `node /absolute/path/cdp-browser-mcp/dist/cli.js` after building. CLI options override the optional JSON configuration:

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
  "headerDomains": ["example.com", "*.example.com"],
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

Only custom request headers are supported. `Cookie`, `Authorization`, `Host`, and connection-level headers are rejected. The browser manages cookies itself. Headers apply to a tab's HTTP(S) requests, including redirects, iframes, dedicated and nested workers, fetch, XHR, beacon, and downloads. They apply across origins only when the destination hostname matches `headerDomains`. Exact names match only themselves; `*.example.com` matches subdomains but excludes the apex. There is no implicit all-host entry. An empty list injects no headers; opening a tab with nonempty headers and an empty list is rejected. URL schemes, paths, ports and partial wildcards are not valid domain entries. Domain matching is case insensitive; Unicode names must be supplied in ASCII/punycode form. SharedWorker is disabled and ServiceWorker registration is rejected; see [isolation](architecture.md#worker-policy).

## Options

| JSON key           | Default                          | Description                                                          |
| ------------------ | -------------------------------- | -------------------------------------------------------------------- |
| `headerDomains`    | `[]`                             | Exact hostnames or `*.example.com` permitted to receive lane headers |
| `stateDir`         | `~/.local/state/cdp-browser-mcp` | Dedicated profile, downloads, and runtime files                      |
| `executablePath`   | Auto-detected                    | Chrome current Stable or newer executable                            |
| `cdpPort`          | `0`                              | Loopback debug port; `0` selects an available port                   |
| `headless`         | Linux: `true`; macOS: `false`    | Uses Chrome's `headless=new` mode                                    |
| `leaseMs`          | `300000`                         | Idle tab timeout, in milliseconds                                    |
| `maxTabs`          | `20`                             | Maximum managed tabs                                                 |
| `minFreeBytes`     | `536870912`                      | Minimum free disk space                                              |
| `maxDownloadBytes` | `1073741824`                     | Download storage soft limit                                          |
| `maxLogBytes`      | `5242880`                        | Log rotation threshold per file                                      |
| `actionTimeoutMs`  | `15000`                          | Official MCP page-operation request timeout                          |
| `lanes`            | `{ "default": {} }`              | Named header presets                                                 |

Unknown keys are rejected. Relative `stateDir` values are resolved against the configuration file's directory. Use an absolute path for `executablePath`. Paths are literal; `~` is not expanded inside JSON. Keep the full Unix socket path (`stateDir/control.sock`) within 100 bytes.

## CLI reference

```text
cdp-browser-mcp mcp --agent <id>        Start MCP; start/reuse the shared browser
cdp-browser-mcp open [url]              Open a tab (default agent: manual)
cdp-browser-mcp navigate <url> --agent <id> --tab <id>
cdp-browser-mcp snapshot --agent <id> --tab <id>
cdp-browser-mcp click --ref <ref> --agent <id> --tab <id>
cdp-browser-mcp type --ref <ref> --text <value> --agent <id> --tab <id>
cdp-browser-mcp extract --agent <id> --tab <id> [--selector <css>]
cdp-browser-mcp devtools --tool take_screenshot --arguments '{}' --agent <id> --tab <id> --json
cdp-browser-mcp tabs --agent <id>        List only this agent's tabs
cdp-browser-mcp downloads --agent <id>   List only this agent's downloads
cdp-browser-mcp launch                  Start the browser in the background
cdp-browser-mcp serve                   Run the browser service in the foreground
cdp-browser-mcp status                  Display health, agents, tabs and downloads
cdp-browser-mcp close --agent <id> --tab <id>
cdp-browser-mcp renew --agent <id> --tab <id>
cdp-browser-mcp reclaim --agent <id>     Close all tabs and revoke the agent session
cdp-browser-mcp reconnect               Restart Chrome, releasing existing leases
cdp-browser-mcp stop                    Stop browser/service; retain user data
```

Common options: `--config`, `--state-dir`, `--executable-path`, `--headed`, `--headless`, `--json`, `--version`, `--help`. `mcp` and `open` also accept `--lane`, `--headers` and `--header-domains`; `open` accepts `--agent` and `--url` as an alternative to the positional URL. Management commands print readable output by default; `--json` returns structured results for scripts. MCP stdout is reserved for protocol traffic.

CLI browser actions require explicit `--agent` and `--tab`; they reuse the same ownership checks, request headers, leases, and browser actions as MCP. `click` and `type` accept exactly one `--ref` or `--selector`. `type` requires `--text` (an empty string clears the field), with optional `--submit` or `--slowly`. Refs come from the latest snapshot (now official snapshot UIDs, carried in the existing `[ref=...]` output). CSS actions target accessible elements in the top-level snapshot; use a snapshot ref for iframe elements. `tabs` and `downloads` are scoped to the supplied agent; `status` is an administrative view of the whole shared service.

For terminal-based skills, choose a unique execution ID, use `open --agent <id> --json` once, retain its returned `tabId` across command invocations, and finish with `reclaim --agent <id>`. The CLI process can exit between actions while the tab remains leased. There is no automatic CLI disconnect cleanup: explicit reclaim or lease expiry releases those tabs. Do not call `stop` or `reconnect` as task cleanup; those affect every client.

Each successful browser action renews the tab lease. Manual login tabs expire too: use `renew` with the ID printed by `open`, or configure a longer `leaseMs`. Closing a tab, expiry, or a clean MCP disconnect releases ownership and cancels its unfinished downloads. A force-killed MCP client loses its idle tabs on expiry; if its agent ID remains registered, `reclaim` releases the registration.

`stop` affects only the dedicated browser service. It preserves profiles and finished downloads. If it was started with a custom data directory, use the same `--state-dir` or `--config` when stopping it.

## MCP clients

Use a different `--agent` ID per concurrent MCP process. The MCP server lazily creates its first tab. The background browser is shared and remains running until `stop`; disconnecting one client does not stop other clients.

Install with the [Release installer or clone/build method](deployment.md#installation), then use the installed command:

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

Node.js and `<prefix>/bin` must be on the MCP client's PATH. For a client that does not inherit your shell PATH, set `command` to the executable's absolute path, for example `/home/you/.local/bin/cdp-browser-mcp` (JSON does not expand `$HOME`). For a built source checkout, use `"command": "node"` with `"args": ["/absolute/path/cdp-browser-mcp/dist/cli.js", "mcp", "--agent", "agent-a"]`.

Codex supports the same command and args in [`config.toml`](https://learn.chatgpt.com/docs/extend/mcp?surface=cli):

```toml
[mcp_servers.browser]
command = "cdp-browser-mcp"
args = ["mcp", "--agent", "codex"]
```

After a browser restart, refs and leases from previous tabs are invalid. Use `browser_tabs` to list or create tabs before continuing.

## Migrating from 0.1.x

Existing MCP command/args and the original `browser_*` tools remain available. Add `headerDomains` to header configurations, or `--header-domains '["example.com","*.example.com"]'` to the first launch. All clients must agree on the service configuration; stop and relaunch to change the allowlist. Existing persistent dedicated profiles are retained. Snapshot refs change after upgrade: always take a fresh snapshot.

`browser_devtools({name,arguments})` and CLI `devtools --tool <name> --arguments '<json>'` call official page diagnostics: `take_screenshot`, `list_network_requests`, `get_network_request`, `list_console_messages`, `get_console_message`, `get_css_styles`, `lighthouse_audit`, `performance_start_trace`, `performance_analyze_insight`. The current owned tab supplies `pageId`; callers cannot override it. The MCP diagnostic returns the original MCP content, including inline images. Files must stay inside this service's `stateDir` (upstream workspace restriction).

Trace recording is browser-wide: only one recording/Lighthouse operation runs at a time. Traces use `autoStop=true` (the upstream default, roughly five seconds); manual open-ended recording is rejected. Only the tab that recorded the latest completed trace can request its insights. Raw traces can contain browser-wide events; use this with cooperating agents, not as tenant isolation. Diagnostic requests have an 80-second transport deadline; ordinary page operations use `actionTimeoutMs`. A failed or canceled mutation is never automatically replayed.

The official `emulate.extraHttpHeaders` option, global page selection/creation, and unrestricted tool forwarding are intentionally private. Header injection always belongs to the outer policy.

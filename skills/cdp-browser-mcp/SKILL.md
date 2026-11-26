---
name: cdp-browser-mcp
description: Use extension mode (--mode extension) for routine approved daily Chrome tabs without repeated remote-debugging approval. Run browser checks with shared login, execution-owned tabs and per-tab headers for parallel isolated tasks. Also attach to the human user's running Chrome current tabs (--mode attach), reusing their login for attended visual inspection and page operations.
---

# CDP Browser MCP

Choose the mode before operating a browser. The default isolated mode uses a dedicated Chrome through the terminal CLI or MCP. Extension mode reuses approved daily tabs through a persistent extension/native bridge; attended attach mode uses official autoConnect.

## 选择模式（isolated vs attach vs extension）

- **isolated (default):** use for parallel tasks/agents, CI and unattended checks. Each execution owns tabs, lane headers and downloads in the dedicated profile; login state is shared. Omitting `--mode` always selects isolated.
- **extension (0.4.0+):** use for routine daily Chrome tabs after human extension installation and website consent. It reuses a persistent official backend without per-session remote-debugging Allow; Chrome's debugging banner may remain.
- **attach:** use only when the task needs the human user's current daily Chrome tabs and existing login, with the user present for approval and visual inspection. The daily profile is not a tenant or account isolation boundary. It exposes all windows of the selected channel's default profile.

Node.js 22.12+ and the installed `cdp-browser-mcp` command are required for all modes. Check `cdp-browser-mcp --version` before use; attach requires 0.3.0+. If absent, follow the repository README installer; never install the unrelated npmjs namesake. The isolated instructions below do not apply to attach or extension.

## Attach to daily Chrome

1. Ask the user to start Google Chrome **144+** in the desired channel; check/update at `chrome://settings/help`. Use current Stable or newer for the complete official diagnostic toolset.
2. The user must open `chrome://inspect/#remote-debugging` and enable **Remote Debugging**.
3. Configure an MCP client with the installed command (use an absolute path if its PATH differs):

   ```json
   {
     "mcpServers": {
       "cdp-browser-attach": {
         "command": "cdp-browser-mcp",
         "args": ["mcp", "--mode", "attach", "--channel", "stable"]
       }
     }
   }
   ```

4. On connection, the user must click **Allow / 允许** in Chrome's approval dialog. An agent must never click it on their behalf. Chrome may request approval on each connection; no unattended approval is promised.
5. After connection, call `list_pages` and use the official `pageId` parameters to select the intended daily tab. Confirm the intended tab with the user; the MCP selected page is not proof of the human's active tab. Use `select_page` with `bringToFront: true` when an attended operation should be visible. Read its snapshot before acting, then verify the visible result. Attach directly exposes official page actions, snapshots, screenshots, network and console tools; it does not use isolated `browser_*` wrappers or CLI page commands.

`--channel` accepts `stable` (default), `beta`, `dev` or `canary`; match the user's running Chrome. Stderr `waiting-for-authorization` means not yet authorized; `connected` is reported only after a successful `list_pages` probe. The default upstream connection/approval request timeout is 30000 ms; `--attach-timeout-ms` accepts 1000–120000. Set the MCP client's startup timeout above the approval budget (for example, 60 seconds for the default budget).

If connection fails, preserve the official error and ask the user to check Chrome is running, its version, the remote-debugging switch and the approval dialog in that order. Stopped Chrome, an old version, disabled remote debugging and refused approval may produce the same upstream error. A timeout may mean approval is still pending rather than refused. Do not infer a more precise cause, automatically retry or fall back to another browser. If the error specifically reports `EPERM` reading Chrome's `DevToolsActivePort` on macOS, report that file-access failure and ask the user to check the agent host's privacy permissions; do not change permissions or restart its host automatically.

Attach supports only `mcp --mode attach`. `launch`, `status`, `stop` and all other CLI commands with `--mode attach` are rejected. It also rejects `--agent`, `--tab`, `--lane`, `--headers`, `--header-domains`, `--config`, `--state-dir`, `--executable-path`, `--headed` and `--headless`. There are no lane headers, tab/pageId leases or isolated downloads; official page IDs do not grant ownership. Do not run cooperating agents or different accounts/tenants as though the daily profile isolated them. Official tools can modify daily tabs and write files with the user's permissions.

On completion, disconnect the MCP client (stdin EOF/Ctrl+C); only the relay and official subprocess stop, and the user's Chrome stays open. Do not run isolated `reclaim` or `stop` for attach cleanup. Real daily-browser approval and visual inspection require the human user; automated contracts do not substitute for this acceptance.

## Daily Chrome extension (0.4.0)

For routine daily Chrome work without repeated remote-debugging Allow, prefer an explicitly user-selected `extension` MCP entry after its one-time installation. Follow [the installation guide](../../docs/extension.md); do not install/load extensions, approve sites, change policies or register MCP entries automatically. Example args: `["mcp", "--mode", "extension", "--state-dir", "/absolute/path/to/extension-state"]`. Use the exact state directory printed by the native host installer, separate from isolated state. MCP startup does not connect to Chrome or start a browser.

Call `list_pages`, then pass explicit `pageId` to the official page tools. The popup can grant exact origins or all HTTP(S) sites, with sensitive origins excluded in either case. The first operating MCP client claims a page; use `extension_release_page` or disconnect to release it, without closing the tab. On another client's claim error, do not bypass it with direct CDP. The popup's Pause and Chrome Cancel stop access; never automatically resume against the user's choice. Snapshot/screenshot, page actions, network and console are provided by one persistent official backend. Tab creation/closing, browser-wide diagnostics, cookie export, uploads, downloads and emulation are unavailable. No lane headers or account isolation is implied.

Remote Debugging need not be enabled, and no per-session autoConnect approval is used. Chrome's debugging banner can still appear. Installation/initial origin consent and actual daily-profile visible-operation acceptance require the human. Missing native host or relay is an actionable installation failure, never a reason to launch isolated or autoConnect as fallback. Transport loss/timeout does not justify replaying actions. Page content/evaluation has the power of the approved signed-in page; origin filtering is not a sandbox.

## Start an execution (isolated)

Check `node --version`, `npm --version`, and `command -v cdp-browser-mcp`; Node.js 22.12+ and Google Chrome current Stable or newer are required, including Linux headless=new. This matches official chrome-devtools-mcp requirements; older Chrome and other Chromium browsers are outside the supported baseline. Report a missing system dependency rather than installing it automatically. On macOS use the terminal's `/bin/zsh` shell.

Use the installed command. If it is absent, follow the Release installer or clone/build instructions in the repository README; do not install the unrelated npmjs namesake. The installer requires curl and supports `VERSION` and `NPM_CONFIG_PREFIX`.

Verify the installation with:

```zsh
cdp-browser-mcp --version
```

Choose one unique `--agent` ID for this execution and keep it across calls. Use the orchestrator's actual Run/execution ID when supplied; otherwise generate a UUID. IDs allow only letters, digits, `_`, and `-`, up to 64 characters. A fixed name such as `codex` is unsafe when that agent runs concurrent tasks. After resuming the same execution, list its tabs before creating more.

```zsh
cdp-browser-mcp open --agent <execution-id> --json
```

The command starts or reuses one detached local browser service. Retain the returned `tabId` and supply both `--agent` and `--tab` to subsequent actions. Do not pass angle-bracket placeholders literally. The service uses `~/.local/state/cdp-browser-mcp`, independently of everyday Chrome. macOS defaults to a visible window; Linux defaults to `headless=new`. Add `--headless` or `--headed` to `open` when starting a new service if the task requires it.

If the task specifies request headers, set them when opening its tab:

```zsh
cdp-browser-mcp open --agent <execution-id> --header-domains '["example.com","*.example.com"]' --headers '{"x-lane":"blue"}' --json
```

Replace the example allowlist with the task's explicit trusted hostnames; use the same `--config` when sharing a configured service. Header tabs are rejected when the service has no allowlist. Use the task's actual header values. Do not invent an environment or place credentials in headers. Header changes require opening a new tab; they do not mutate an existing tab. All calls that share a login must use the same state directory. If `--config` or `--state-dir` is supplied by the user, keep it on every call. Do not point this tool at a daily Chrome profile or read its internal identity/profile files.

## Interact and verify (isolated)

```zsh
cdp-browser-mcp navigate https://example.com --agent <execution-id> --tab <tab-id>
cdp-browser-mcp snapshot --agent <execution-id> --tab <tab-id>
cdp-browser-mcp type --ref <input-ref> --text 'sample' --agent <execution-id> --tab <tab-id>
cdp-browser-mcp click --ref <button-ref> --agent <execution-id> --tab <tab-id>
cdp-browser-mcp extract --agent <execution-id> --tab <tab-id>
```

Read the snapshot before acting. Use a `ref` from the latest snapshot, or a CSS `--selector` grounded in the observed page; do not guess element refs. `type` fills a field; `--text ''` clears it, `--submit` presses Enter, and `--slowly` types sequentially. After an action, inspect its returned snapshot or use `extract` to verify the visible result. A successful command alone does not prove a business assertion. Use `--json` when machine-readable results are useful.

Run actions sequentially within one tab. Different execution IDs/tabs may operate concurrently. To inspect only this execution:

```zsh
cdp-browser-mcp tabs --agent <execution-id> --json
cdp-browser-mcp downloads --agent <execution-id> --json
```

Execution output is already captured by the calling agent's terminal/tool log. Report the observed assertion and any blocker in that conversation; no UI plugin is required. `downloads` lists completed files attributed to this execution. Do not inspect another task's downloads or global runtime logs for routine verification.

## Finish and handle failures (isolated)

Always attempt this execution's cleanup, including after a failed assertion:

```zsh
cdp-browser-mcp reclaim --agent <execution-id>
```

This closes only its tabs and revokes its session. Do not use global `stop` or `reconnect` as task cleanup: they interrupt other tasks. CLI actions renew a tab's idle lease (five minutes by default); use `renew --agent <execution-id> --tab <tab-id>` for a longer manual inspection. If the process is interrupted before cleanup, idle leases eventually reclaim its tabs.

If a tab expires or the browser restarts, its old ID and refs are invalid. List owned tabs and deliberately create a replacement before resuming. Do not silently repeat a click, submission, or other operation with an uncertain result; inspect the current state first. Missing login requires the user to log in once in the dedicated window, not copying credentials from another browser.

## Isolation boundaries (isolated)

- Cookies and same-origin storage are shared deliberately. Logging out affects all tasks. This is tab ownership for cooperating agents, not an adversarial security sandbox.
- Per-tab headers cover HTTP(S), including iframes, dedicated/nested workers, fetch, XHR, beacon, and downloads. Only destinations in `headerDomains` receive lane headers, including redirects and worker requests. Other hostnames receive none of the configured lane keys.
- SharedWorker is disabled and ServiceWorker registration is rejected before document scripts run. Do not claim those features passed; report a dependency on them as a limitation. WebSocket and WebTransport header isolation is outside the guarantee.
- Keep the browser/CDP endpoint on loopback. Remote operation requires a user-configured authenticated tunnel; do not expose a debugging port publicly.

## Official diagnostics (isolated)

The browser service attaches a controlled official `chrome-devtools-mcp@1.13.0` subprocess to its own Chrome. Use `devtools --tool take_screenshot --arguments '{}' --agent <execution-id> --tab <tab-id> --json` for screenshots, or the page-scoped diagnostic names documented in `docs/configuration.md`. `browser_devtools` provides the same entry in MCP. Never connect a second agent-facing official server directly to this dedicated isolated browser: it bypasses leases and header policy. The separate attach mode above targets the human-owned daily Chrome and provides none of these guarantees. Snapshots retain `[ref=...]` syntax but refs are upstream UIDs; refresh them after navigation or an upgrade.

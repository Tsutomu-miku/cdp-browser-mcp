---
name: cdp-browser-mcp
description: Run browser end-to-end checks from a terminal using shared login state, execution-owned tabs, and per-tab request headers. Use for parallel agent browser tasks without a browser extension or preconfigured MCP server.
---

# CDP Browser MCP

Use the terminal CLI to navigate, inspect, fill, click, and extract from a dedicated Chrome browser. Multiple tasks share cookies and same-origin storage while owning separate tabs, headers, leases, and downloads.

## Start an execution

Check `node --version`, `npm --version`, and `command -v npx`; Node.js 22+ and an installed Chrome/Chromium are required. Report a missing system dependency rather than installing it automatically. On macOS use the terminal's `/bin/zsh` shell.

Run the Git package with:

```zsh
npx --yes github:Tsutomu-miku/cdp-browser-mcp --help
```

Choose one unique `--agent` ID for this execution and keep it across calls. Use the orchestrator's actual Run/execution ID when supplied; otherwise generate a UUID. IDs allow only letters, digits, `_`, and `-`, up to 64 characters. A fixed name such as `codex` is unsafe when that agent runs concurrent tasks. After resuming the same execution, list its tabs before creating more.

```zsh
npx --yes github:Tsutomu-miku/cdp-browser-mcp open --agent <execution-id> --json
```

The command starts or reuses one detached local browser service. Retain the returned `tabId` and supply both `--agent` and `--tab` to subsequent actions. Do not pass angle-bracket placeholders literally. The service uses `~/.local/state/cdp-browser-mcp`, independently of everyday Chrome. macOS defaults to a visible window; Linux defaults to `headless=new`. Add `--headless` or `--headed` to `open` when starting a new service if the task requires it.

If the task specifies request headers, set them when opening its tab:

```zsh
npx --yes github:Tsutomu-miku/cdp-browser-mcp open --agent <execution-id> --headers '{"x-lane":"blue"}' --json
```

Use the task's actual header values. Do not invent an environment or place credentials in headers. Header changes require opening a new tab; they do not mutate an existing tab. All calls that share a login must use the same state directory. If `--config` or `--state-dir` is supplied by the user, keep it on every call. Do not point this tool at a daily Chrome profile or read its internal identity/profile files.

## Interact and verify

```zsh
npx --yes github:Tsutomu-miku/cdp-browser-mcp navigate https://example.com --agent <execution-id> --tab <tab-id>
npx --yes github:Tsutomu-miku/cdp-browser-mcp snapshot --agent <execution-id> --tab <tab-id>
npx --yes github:Tsutomu-miku/cdp-browser-mcp type --ref <input-ref> --text 'sample' --agent <execution-id> --tab <tab-id>
npx --yes github:Tsutomu-miku/cdp-browser-mcp click --ref <button-ref> --agent <execution-id> --tab <tab-id>
npx --yes github:Tsutomu-miku/cdp-browser-mcp extract --agent <execution-id> --tab <tab-id>
```

Read the snapshot before acting. Use a `ref` from the latest snapshot, or a CSS `--selector` grounded in the observed page; do not guess element refs. `type` fills a field; `--text ''` clears it, `--submit` presses Enter, and `--slowly` types sequentially. After an action, inspect its returned snapshot or use `extract` to verify the visible result. A successful command alone does not prove a business assertion. Use `--json` when machine-readable results are useful.

Run actions sequentially within one tab. Different execution IDs/tabs may operate concurrently. To inspect only this execution:

```zsh
npx --yes github:Tsutomu-miku/cdp-browser-mcp tabs --agent <execution-id> --json
npx --yes github:Tsutomu-miku/cdp-browser-mcp downloads --agent <execution-id> --json
```

Execution output is already captured by the calling agent's terminal/tool log. Report the observed assertion and any blocker in that conversation; no UI plugin is required. `downloads` lists completed files attributed to this execution. Do not inspect another task's downloads or global runtime logs for routine verification.

## Finish and handle failures

Always attempt this execution's cleanup, including after a failed assertion:

```zsh
npx --yes github:Tsutomu-miku/cdp-browser-mcp reclaim --agent <execution-id>
```

This closes only its tabs and revokes its session. Do not use global `stop` or `reconnect` as task cleanup: they interrupt other tasks. CLI actions renew a tab's idle lease (five minutes by default); use `renew --agent <execution-id> --tab <tab-id>` for a longer manual inspection. If the process is interrupted before cleanup, idle leases eventually reclaim its tabs.

If a tab expires or the browser restarts, its old ID and refs are invalid. List owned tabs and deliberately create a replacement before resuming. Do not silently repeat a click, submission, or other operation with an uncertain result; inspect the current state first. Missing login requires the user to log in once in the dedicated window, not copying credentials from another browser.

## Isolation boundaries

- Cookies and same-origin storage are shared deliberately. Logging out affects all tasks. This is tab ownership for cooperating agents, not an adversarial security sandbox.
- Per-tab headers cover HTTP(S), including iframes, dedicated/nested workers, fetch, XHR, beacon, and downloads. Headers also follow cross-origin requests, so navigate only to trusted task destinations.
- SharedWorker is disabled and ServiceWorker requests are blocked. Do not claim those features passed; report a dependency on them as a limitation. WebSocket and WebTransport header isolation is outside the guarantee.
- Keep the browser/CDP endpoint on loopback. Remote operation requires a user-configured authenticated tunnel; do not expose a debugging port publicly.

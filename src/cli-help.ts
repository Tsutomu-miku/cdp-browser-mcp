export const help = `cdp-browser-mcp — shared browser sessions for multiple agents

Usage: cdp-browser-mcp <command> [options]

Commands:
  mcp --agent <id>       Start an MCP stdio server; start/reuse the shared browser
  open [url]            Open an owned tab (default agent: manual)
  navigate <url>        Navigate an owned tab; return snapshot and refs
  click                 Click --ref <ref> or --selector <css>
  type                  Fill --ref/--selector with --text <value>
  snapshot              Read an owned tab's accessibility snapshot and refs
  extract               Read visible text (optional --selector <css>)
  devtools --tool <name> --arguments <json>  Run an owned-page official diagnostic
  tabs --agent <id>     List only this agent's tabs
  downloads --agent <id>  List only this agent's completed downloads
  launch                Start the shared browser in the background
  status                Show browser health, tabs, agents and downloads
  stop                  Stop the shared browser; keep login state and downloads
  close --agent <id> --tab <id>   Close an agent's tab
  renew --agent <id> --tab <id>   Extend a tab lease
  reclaim --agent <id>   Close an agent's tabs and revoke its session
  reconnect             Restart Chrome and invalidate existing tab leases
  serve                 Run the browser service in the foreground

Options:
  --mode <mode>        isolated (default), or attach for mcp only
  --channel <channel>  attach: stable (default), beta, dev or canary
  --attach-timeout-ms <ms>  Connection/approval timeout (default: 30000)
  --headers <json>      Per-tab request headers, e.g. '{"x-lane":"blue"}'
  --header-domains <json>  Explicit hostname allowlist for lane headers
  --agent <id>          Unique execution/session ID (not a shared agent name)
  --tab <id>            Explicit owned tab ID for browser actions
  --ref / --selector    Element ref from snapshot, or a CSS selector
  --text <value>        Text to fill; --submit presses Enter; --slowly types keys
  --lane <name>         Header template from config (default: default)
  --config <file>       Optional JSON configuration
  --state-dir <path>    Dedicated browser data directory
  --executable-path <path>  Chrome executable (otherwise auto-detected)
  --headed / --headless Choose the display mode when starting a new browser
  --json                Print command results as JSON
  -V, --version         Print version
  -h, --help            Show this help

Examples:
  cdp-browser-mcp mcp --mode attach --channel stable
  cdp-browser-mcp mcp --agent codex
  cdp-browser-mcp open https://example.com
  cdp-browser-mcp snapshot --agent task-123 --tab <tab-id>
  cdp-browser-mcp status
  cdp-browser-mcp stop`;

# Official DevTools migration evidence

Version `0.2.0-dev`, official `chrome-devtools-mcp@1.13.0`. Synthetic loopback sites only; no real accounts or everyday profile used.

macOS arm64 / Node 22.17.0 / Chrome 157.0.8103.51: full suite **7/7 headed and 7/7 headless=new**. The full run includes official screenshot, Lighthouse snapshot and automatic performance trace; persistent cookies/localStorage across a service restart; official process SIGKILL and independent CDP disconnect recovery; all original CLI/MCP/terminal-skill and download checks. Additional iframe ServiceWorker registration assertions passed with zero worker script/background requests received.

- `macos-{headed,headless}.json`: test and diagnostic summary.
- `macos-allowlist-*.json`: request-level records for allowlisted and external domains, redirects, fetch/XHR/beacon, iframes and classic/module/nested workers. Every tagged request is checked at the receiving server, including worker startup scripts and external importScripts. Header mismatches: **0**.
- `macos-concurrent-*.json`: two MCP clients with shared session cookies, independent official page actions, per-agent download contents/directories, native close/lease cleanup, disk guards and CDP recovery. CDP calls retain the default-context download contract.
- `macos-persistence-*.json`: persistent login/storage and official-process recovery, exactly one login request.
- `production-install.json`: packed tarball installed with production dependencies only; no Playwright installed; CLI open/snapshot/official screenshot and cleanup passed. MIT/NOTICE/Apache license files are present in the tarball.

The initial Linux Chrome 136/146 run failed only the official diagnostic test ([historical failure](https://github.com/Tsutomu-miku/cdp-browser-mcp/actions/runs/43690432173)). Those old versions lack the newer CDP command used by official Lighthouse and are outside the current-Stable-or-newer requirement. Linux CI now installs Google's current Stable channel on Ubuntu 22.04, prints the actual browser version, and runs all seven tests without altering deadlines or assertions. Request logs and `chrome-version.txt` are uploaded by that workflow; this directory's macOS records are not Linux measurements.

Not exercised: real SSO, daily Chrome, the separate extension PoC, Windows, Linux headed/Xvfb, cross-host login transfer, WebSocket/WebTransport headers. Browser-wide raw traces are not tenant-isolated; traces use automatic stop. No tag, release or registry publication is part of this migration.

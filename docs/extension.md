# Daily Chrome through an extension

`mcp --mode extension` lets local coding agents reuse your everyday Chrome tabs and their signed-in state through a Manifest V3 extension and a user-level Native Messaging host.

- **No remote-debugging setup:** does not use `--autoConnect`, read `DevToolsActivePort`, open a remote-debugging port, launch Chrome, or ask for a fresh Chrome **Allow** dialog on every MCP session.
- **Explicit human consent:** you install the extension and manage website access from its toolbar popup.
- **Browser UI unchanged:** **Chrome's debugging banner can still appear.** There is no silent flag, enterprise-policy override, or promise to suppress browser security UI.
- **Existing modes preserved:** `isolated` remains the default, and explicit `attach` remains available for attended autoConnect. Nothing automatically edits MCP registrations or enables extension access.

## One-time installation (macOS and Linux)

**Prerequisites:** Node.js 22.12+, current Google Chrome Stable or newer, and an installed GitHub Release tarball or built source checkout (the public npmjs package with the same name is unrelated). The extension uses Chrome 125+ flattened debugger sessions; that API minimum does not expand the browser support baseline. Windows installation is not supported.

### 1. Prepare a stable extension directory

From an installed package (from a source checkout, substitute `node dist/extension/setup.js`):

```zsh
cdp-browser-mcp-extension-setup prepare --output "$HOME/.local/share/cdp-browser-mcp-extension"
```

- Refuses to overwrite an existing directory.
- Keep this directory at the same path so the unpacked extension ID stays stable.
- To upgrade later, pause or disable the extension first; this installer does not auto-update.

### 2. Load the extension in Chrome

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the directory from Step 1.
3. Copy the resulting **Extension ID**.

Enterprise policies may block unpacked extensions; consult your administrator rather than bypassing policy. Chrome Web Store publication and managed deployment are separate, uncompleted steps.

### 3. Register the Native Messaging host

Point `--browser-user-data-dir` at the Chrome user-data **root** (not a profile subdirectory like `Default` or `Profile 1`):

```zsh
cdp-browser-mcp-extension-setup install-native \
  --extension-id '<ID from chrome://extensions>' \
  --state-dir "$HOME/.local/state/cdp-browser-mcp-extension" \
  --browser-user-data-dir "$HOME/Library/Application Support/Google/Chrome"
```

- **Linux:** typically `$HOME/.config/google-chrome`. For Chrome for Testing, specify its explicit test root.
- **Files written:** `<root>/NativeMessagingHosts/io.github.tsutomu_miku.cdp_browser_mcp.json` and a launcher inside `--state-dir`. Existing manifests and launchers are never overwritten.
- **Permissions & path pinning:** normally requires no `sudo`, though OS/enterprise controls may prompt. The launcher pins the current absolute Node and package paths; moving or uninstalling either requires deliberate reinstallation.

### 4. Grant website access in the popup

Click the **CDP Browser MCP** icon in Chrome's toolbar:

1. Under **Website access**, choose **Approved websites** (and list exact `http(s)` origins, one per line) or **Allow all websites**.
2. Optionally list **Sensitive origins to hide** — these are excluded in both modes.
3. Click **Save and enable access**.

- Access starts **paused** with no origins approved. Switching to **Allow all websites** preserves your saved approved list for when you switch back.
- Only this local popup can change consent; the native host and MCP protocol cannot approve sites or resume access.
- If host installation finished after the extension loaded, reconnection can take up to 30 seconds; any errors appear in the popup.

### 5. Configure an MCP client (optional)

No installer edits client config automatically. Add an explicit entry when ready:

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

For Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.daily-chrome]
command = "cdp-browser-mcp"
args = ["mcp", "--mode", "extension", "--state-dir", "/absolute/path/to/extension-state"]
```

MCP initialization does not touch Chrome. Tool discovery connects to the running native host without probing tabs; the first actual page tool call initializes browser access. Chrome must already be running with the extension installed in the target profile — no isolated browser is launched as a fallback.

## Tools and concurrency

- **Page workflow:** call `list_pages`, then pass an explicit `pageId` to every page tool. Available official tools come from pinned unmodified `chrome-devtools-mcp@1.13.0` (`--pageIdRouting`): page selection (including `bringToFront`), snapshot/screenshot, click/drag/hover, fill/fill_form, key press, wait, evaluate, navigation, dialog handling, and page-scoped network/console listing and details. Call `extension_release_page` to release a tab without closing it.
- **Shared backend & page claims:** one native host owns one official subprocess and one extension CDP connection, reused by all MCP clients. Each page is claimed by its first operating client; another client receives an explicit error until release or disconnect. Different pages can be used concurrently by cooperating clients (the official backend serializes context work). Flattened iframe/worker session IDs are namespaced by Chrome tab ID, and MCP clients never receive the internal CDP credential. This coordinates trusted local agents — it is not a tenant or account boundary.
- **Intentionally unavailable:** tab creation/closing, file upload, browser-wide tracing/Lighthouse, emulation, download management, and cookie export tools are not exposed. `Browser`, `Storage`, `SystemInfo`, and `Extensions` CDP domains plus browser-wide cookie/cache methods, `Browser.close`, and `Page.close` are refused.
- **Supported CLI surface:** only `mcp --mode extension --state-dir <installation-state>` is supported. `launch`/`status`/`stop`, `--agent`, `--tab`, lane/header options, Chrome launch flags, `--channel`, and `--attach-timeout-ms` are rejected. Keep `--state-dir` separate from isolated state and the Chrome profile.

## Stop, recovery and security

- **Immediate revocation:** **Pause all access** and any consent change immediately disconnect MCP peers and invalidate cached browser data — even while a page command is waiting for a response — then detach the debugger from managed tabs. Canceling Chrome's debugger banner also pauses access. After re-enabling, reconnect the MCP session once the native host restarts (up to 30 seconds). An already dispatched action may have completed; inspect page state before retrying.
- **Session lifecycle:** ending one MCP client releases its page claims while keeping the shared backend and user tabs open. Closing Chrome stops the native host and rejects pending requests. Transport recovery starts a fresh generation; mutations are never replayed.
- **Local transport security:** WebSockets bind only to `127.0.0.1`, reject browser `Origin` headers and unexpected `Host` headers, and require random bearer tokens (separate for MCP peers and the official CDP connection). State directories use `0700`; discovery credentials, native manifest, and audit files use `0600`. Same-user processes remain trusted: the official subprocess receives its CDP credential via `--wsHeaders` (never in URLs or audit logs), which can be visible to same-user process inspection.
- **Consent scope vs. sandbox:** website consent filters discovery, attachment, and navigation, and hides tabs that leave the approved scope. **Allow all websites** covers signed-in tabs on any HTTP(S) origin while **Sensitive origins to hide** still take precedence. Incognito tabs, browser-internal pages, and targets Chrome refuses to debug stay unavailable. **These controls are not a network firewall or security sandbox:** approved pages can load cross-origin resources, scripts can navigate, and evaluation can access page data. There is no universal automatic classifier for sensitive sites.
- **Data flow & audit:** page content, screenshots, network, and console results return to the local MCP client (which may send them to its model/provider). The extension itself has no outbound network access or telemetry. `audit.jsonl` (with one rotated file at 1 MiB) in the state directory records timestamps, tool names, random client IDs, page IDs, and outcomes — never raw arguments, URLs, headers, cookies, snapshots, or response bodies. Audit the source before installing, as `debugger` grants substantial power over the profile.

### Uninstall

1. Pause or disable the extension in Chrome.
2. Delete only the native manifest and launcher paths printed by `install-native`.
3. Remove the extension from `chrome://extensions`.

Your Chrome profile and open tabs remain untouched. Do not remove another product's native host or alter enterprise policy.

## Verification and remaining human acceptance

- `npm run check` runs browser-free framing, authentication, installation, and mode contract tests.
- `npm run test:extension:e2e` requires `EXTENSION_CHROME_PATH` pointing at an extension-capable Chrome for Testing binary; it uses a disposable profile and synthetic login, never your daily profile. CI runs it separately from the Stable isolated suite.
- Before calling daily use accepted on a machine, verify on your real Stable profile: unpacked load and consent, an already signed-in tab, an innocuous visible drag, multiple fresh MCP sessions without repeated remote-debugging Allow, navigation/Chrome restart, and stopping access via popup Pause and Chrome Cancel.

See [ADR 0002](adr/0002-extension-daily-chrome.md).

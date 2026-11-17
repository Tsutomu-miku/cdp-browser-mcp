# Daily Chrome through an extension

Version 0.4.0 adds `mcp --mode extension`. It reuses tabs and their signed-in state through a Manifest V3 extension and user-level native host. It does not use `--autoConnect`, read `DevToolsActivePort`, open a remote-debugging port, start Chrome, or require a new Chrome remote-debugging **Allow** for each MCP session. The user installs the extension and approves exact website origins once. **Chrome's debugging banner can still appear.** There is no silent flag, enterprise-policy override, or promise to suppress browser security UI.

`isolated` remains the default. Existing explicit `attach` remains available for attended autoConnect. Nothing automatically edits MCP registrations or enables extension access.

## One-time installation (macOS and Linux)

Install this project's GitHub tarball or build its checkout first; the npmjs namesake is unrelated. Node.js 22.12+ and current Chrome Stable or newer are the supported baseline. The extension uses Chrome 125+ flattened debugger sessions; that API minimum does not expand the browser support promise.

1. Prepare a stable extension directory. From an installed package:

   ```zsh
   cdp-browser-mcp-extension-setup prepare --output "$HOME/.local/share/cdp-browser-mcp-extension"
   ```

   From a checkout, substitute `node dist/extension/setup.js`. This refuses to overwrite an existing directory. Keep this directory at the same path so the unpacked extension ID remains stable. Upgrade its contents only after pausing/disabling the extension; this initial installer does not perform automatic updates.

2. **The user** opens `chrome://extensions`, enables Developer mode, chooses **Load unpacked**, and selects that directory. Copy its extension ID. Enterprise restrictions may block this; consult your administrator rather than bypassing policy. Store publication and managed deployment are separate, uncompleted distribution steps.

3. Register the native host for the intended Chrome user-data root, not a profile subdirectory such as `Default` or `Profile 1`:

   ```zsh
   cdp-browser-mcp-extension-setup install-native \
     --extension-id '<ID from chrome://extensions>' \
     --state-dir "$HOME/.local/state/cdp-browser-mcp-extension" \
     --browser-user-data-dir "$HOME/Library/Application Support/Google/Chrome"
   ```

   Linux Chrome normally uses `$HOME/.config/google-chrome` for the last argument. Chrome for Testing has a separate registration location; specify its explicit test root. Windows installation is not supported. The user-level native manifest is `<root>/NativeMessagingHosts/io.github.tsutomu_miku.cdp_browser_mcp.json`; its launcher is in the extension state directory. No sudo/password is normally required, but OS/enterprise controls can require user or IT approval. Existing manifests/launchers are never overwritten. The launcher pins the current absolute Node and package paths: moving/uninstalling either requires deliberate reinstallation, not a second hidden package copy.

4. Open the extension popup, enter approved exact `http(s)` origins, optionally list sensitive origins to hide, and click **Save and enable access**. Access starts **paused**, with no origins approved. If host installation finished after the extension started, reconnection can take up to 30 seconds; errors appear in the popup. Only this local extension UI changes consent. The native/MCP protocol cannot approve sites or resume access.

5. Configure an explicit MCP entry **only if desired** (no installer changes client config):

   ```json
   {
     "command": "cdp-browser-mcp",
     "args": [
       "mcp",
       "--mode",
       "extension",
       "--state-dir",
       "/absolute/path/to/extension-state"
     ]
   }
   ```

   MCP initialization does not touch Chrome. Tool discovery connects to the already running native host and discovers the official tools, without probing browser pages. The first actual page call initializes browser access. Chrome must already be running with the extension installed in the intended profile. No isolated browser is started as a fallback.

## Tools and concurrency

Call `list_pages`, then pass an explicit `pageId`. Available official tools are page selection (including explicit bring-to-front for attended tasks), snapshot/screenshot, click/drag/hover, fill/fill_form, key press, wait, evaluate, navigation, dialog handling, and page-scoped network/console listing/details. Their implementation and schemas come from the pinned unmodified `chrome-devtools-mcp@1.13.0`, with `--pageIdRouting`. `extension_release_page` releases a claim without closing the daily tab.

One native host owns one official subprocess and one extension CDP connection. New MCP clients reuse it. Each page is claimed by its first operating MCP client; another client gets an explicit error until release or disconnect. Different pages can be used by cooperating clients. The official backend serializes its context work. Flattened iframe/worker session IDs are namespaced by Chrome tab ID; agent clients never receive the internal CDP credential. This is coordination for trusted local agents, not a tenant/account boundary.

No tab creation/closing, file upload, browser-wide tracing/Lighthouse, emulation, download management, or cookie export tools are exposed. Browser/Storage/SystemInfo/Extensions CDP domains and browser-wide cookie/cache methods are refused. `Browser.close` and `Page.close` are never forwarded. `launch/status/stop`, `--agent`, `--tab`, lane/header settings, Chrome launch flags, channel and attach-timeout settings are not extension-mode options; only `mcp --mode extension --state-dir <installation-state>` is supported. The extension state must be separate from isolated state and the Chrome profile.

## Stop, recovery and security

- **Pause all access** in the popup detaches approved tabs. Consent changes invalidate the official collector and disconnect MCP peers, including cached data. Reconnect the MCP session after the native host restarts (up to 30 seconds). Canceling Chrome's debugger warning also latches access paused; agents cannot automatically take it back. An action already dispatched may have completed: never replay it automatically.
- Ending one MCP session releases its claims, keeps the shared backend available, and never closes user tabs or Chrome. Closing Chrome ends the native host and rejects outstanding requests. Extension/native transport recovery establishes a fresh generation; mutations are not replayed.
- Local WebSockets bind only `127.0.0.1`, reject browser Origin headers and unexpected Host headers, and require random bearer credentials. The official CDP credential is separate from the MCP credential. State is 0700; discovery credentials, native manifest, and audit files are 0600. Same-user processes with filesystem/process access remain trusted; the official executable receives its CDP credential through supported `--wsHeaders`, so it can also be visible to same-user process inspection. It is never placed in URLs or audit records.
- Exact-origin consent filters discovery, attachment and navigation commands, and hides tabs that leave the approved set. Blocklist entries take precedence. These controls **are not a network firewall or a sandbox**: approved pages can contain cross-origin resources, scripts can navigate, and page evaluation can access data available to that page. Do not approve banking, account administration or sensitive applications unless required and understood. There is no universal automatic classifier for sensitive sites.
- Page content, screenshots, network and console results are returned to the local MCP client, which may send them to its model/provider. The extension itself has no outbound network access or telemetry. High debugger permission still gives the installed extension/native code substantial power over the profile; audit the code and update source before installation.
- `audit.jsonl` and one rotated file in the dedicated state directory record timestamps, tool names, random client IDs, page IDs and outcomes. Each rotates at 1 MiB; no raw arguments, URLs, headers, cookies, snapshots or response bodies are written there. Upstream tool results and the calling client's transcript have their own data retention.

To uninstall, pause/disable the extension, remove only the manifest and launcher printed by `install-native`, then remove the extension in Chrome. Keep the Chrome profile and user tabs. Do not remove another product's native host or alter enterprise policy. No daemon/Chrome restart is performed automatically.

## Verification and remaining human acceptance

`npm run check` includes browser-free framing, authentication, installation and mode contracts. `npm run test:extension:e2e` requires explicit `EXTENSION_CHROME_PATH` pointing at extension-capable Chrome for Testing; it uses only a disposable profile and synthetic login, never the daily profile. CI runs that test independently from the unchanged Stable isolated suite.

Before calling daily use accepted, the human must install/approve on their actual Stable profile, verify the intended already signed-in tab, see an innocuous drag, open several fresh MCP sessions without repeated remote-debugging Allow, navigate/restart Chrome, and verify popup Pause and Chrome Cancel stop access. Headless test success cannot prove the visual banner/modal behavior on that machine. Managed-machine extension permission and distribution approval remain installation prerequisites, not something the agent silently changes.

See [ADR 0002](adr/0002-extension-daily-chrome.md).

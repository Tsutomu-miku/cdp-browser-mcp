# ADR 0002: daily Chrome through an extension and a persistent local bridge

- Date: 2026-11-17
- Status: proposed implementation; supersedes ADR 0001's rejection of extension access, pending independent review and real-profile human acceptance.
- Context: issue #70. Repeated Chrome remote-debugging approval is unacceptable for ordinary daily use. Registering the autoConnect process in an auto-starting MCP client made new coding sessions prompt even without a browser task. This is a product requirement change, not a claim that official autoConnect failed its documented contract.

## Decision

Add explicit `mcp --mode extension`, keeping `isolated` the default and existing attended `attach` unchanged. Use MV3 `chrome.debugger` plus Native Messaging. The human installs the extension and approves a website scope once, with exact origins as the default and an explicit option for all HTTP(S) sites. No per-MCP remote-debugging approval is used. Chrome's debugger infobar remains possible. Do not add `--silent-debugger-extension-api`, alter managed policy, or promise invisible debugging.

The native host owns an authenticated loopback relay and one long-lived unmodified official Chrome DevTools MCP subprocess. Agent-facing foreground MCP sessions share that backend, use explicit page IDs, and claim pages until release/disconnect. One extension CDP connection owns all actual debugger sessions; virtual tab containers adapt Chrome's tab debugger API to Puppeteer's Target/session transport. Real page/iframe commands go to Chrome, not a parallel DOM action implementation. Browser-wide unsupported commands fail instead of returning fabricated metadata/success.

The old PR #1 remains historical. Its standard native framing, exact caller-origin validation, private files, no-overwrite installation and no-mutation-replay design inform this implementation. Its scripting/DNR DOM backend and old Steward/lease implementation are not revived.

## Ownership and limits

- Extension consent/target state lives in Chrome storage. Only its popup grants/resumes access; Chrome Cancel pauses it. Native ports and the event serialization promise are ephemeral runtime handles, not persistent authorization/session state.
- The native host owns its private endpoint/credentials, official subprocess, bounded audit and one-host reservation. A dead PID permits reclaiming a stale reservation; a live owner is never killed or overwritten.
- `ExtensionTools` owns one page-claim map across MCP peers. There is no second isolated broker, Chrome lifecycle owner, download pipeline or lane-header backend.
- Core official page tools only; no create/close tabs, cookie export, upload, browser-wide diagnostics or download/emulation toolset. Unsupported domains remain unavailable. Sensitive-origin exclusions apply in both scopes. Website controls aid trusted-agent coordination, not adversarial origin isolation; evaluation and approved-page subresources still have profile-level implications.
- Standard user-level Native Messaging installation is explicit and does not normally need sudo. Unpacked installation and enterprise approval are human steps. Web Store publication is not part of this PR. A fixed installation path preserves an unpacked ID; store signing/update identity needs a separate distribution decision.

## Evidence and acceptance

- [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger): debugger permission, supported domain subset and Chrome 125 flattened sessions.
- [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging): exact allowed extension origins, user-level manifests and native-endian length framing, 1 MiB host-to-extension/64 MiB extension-to-host limits. This implementation caps inbound frames at 32 MiB.
- [MV3 lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle): no assumption that global worker variables survive restart.
- [Unpacked installation](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked): explicit human installation.

Tests must prove the pinned official backend works through the actual MV3/native bridge for snapshots, screenshots, drag, network and console; mock framing alone is insufficient. Keep isolated/autoConnect regression tests. Actual daily-profile installation, no-repeat-approval and visible operation remain human acceptance; do not infer those from a synthetic headless profile.

# Chrome Web Store Listing — CDP Browser MCP

Last updated: 2026-11-17. **Draft only; not submitted or published.**

## Store listing

- Name: CDP Browser MCP
- Short description: Let local coding agents work in approved daily Chrome tabs without repeated remote-debugging approvals.
- Category: Developer Tools. Language: English.
- Single purpose: Let trusted local coding agents inspect and operate user-approved signed-in web pages.
- Detailed description: Approve specific websites or explicitly allow all websites, with the option to hide sensitive origins. Local agents can reuse eligible open tabs and their sign-in state across coding sessions. Read page snapshots, take screenshots and perform visible page actions. Pause access from the toolbar popup at any time. Chrome may display its debugging notice. Requires a separately installed local companion; no browser settings or enterprise policies are changed.

## Permissions justification

| Permission      | Reason                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| debugger        | Inspect approved pages, take screenshots and perform page actions through the local agent. High privilege disclosed during installation. |
| nativeMessaging | Communicate with the user's separately installed local companion.                                                                        |
| tabs            | Match existing tabs against the user's chosen website scope and sensitive-origin exclusions.                                             |
| storage         | Remember the user's website scope, approved/blocked origins and paused state; retain session routing across worker events.               |
| alarms          | Reconnect the local companion after a transport interruption without replaying page actions.                                             |

No content scripts, host permissions, remote executable code, inline script or direct network requests are declared. Site consent does not reduce the underlying debugger permission into a browser security sandbox.

## Privacy and data use

Website content, URLs, screenshots, page activity, network and console data are processed locally and returned to the requesting local MCP client. That client can transmit results to its model/provider. The extension has no telemetry or direct off-device data destination. The local audit contains metadata only; cookies, arguments and page bodies are excluded. No history/bookmark/exported-cookie feature is provided. Data is not sold, used for unrelated purposes or credit decisions. Developer Dashboard disclosures must describe page/content processing and the companion dependency accurately before submission.

## Publication prerequisites

Publisher/contact, stable store signing/extension ID and update workflow, live privacy-policy URL, 128×128 icon and 1280×800 or 640×400 screenshots are **not prepared**. Distribution/regions are undecided. The unpacked development package omits icons instead of referencing missing assets. The debugger permission and native companion require reviewer instructions and a security review. Enterprise deployment needs administrator approval.

## Version history

| Version | Change                                                         | Status |
| ------- | -------------------------------------------------------------- | ------ |
| 0.4.0   | Approved-origin daily Chrome access, local companion and Pause | Draft  |

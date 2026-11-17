# Repository contract

Read this file before every change. This repository coordinates trusted agents on
one owned Chrome profile with separate tab leases, headers and downloads in the
default isolated mode. Attach mode is a thin official MCP relay into a human-owned
daily Chrome; it provides none of those isolation guarantees (see ADR 0001).

## Cohesion and size

Each module owns one business responsibility and its invariants. Production files
must be at most **300 physical lines**, including comments and blanks. Split by
state ownership, side effects and reasons to change; never compress statements or
create forwarding helpers to satisfy the counter.

- Good: `session/owned-tabs.ts` owns the lease map, capacity, expiry and actions;
  `adapters/chrome/cookie-snapshot.ts` owns CDP cookie projection.
- Bad: one module mixes CLI parsing, Chrome discovery, leases and downloads, or
  splits into `helpers1.ts` and `helpers2.ts` sharing a mutable context bag.

Existing size debt is explicit: `cli.ts` (395), `broker.ts` (320), `runtime.ts`
(307). These files warn above 300 and fail on any growth beyond those caps.
Their responsibility splits belong in separate PRs. Every other production file
fails above 300. No inline disables; justify central policy changes in the PR.

## Failures and frozen protocols

Prefer an early, observable error over fabricated success. Fix the producer or
contract at the first incorrect boundary. Empty catches (even with comments),
empty Promise catch callbacks, arbitrary empty fallbacks and invented defaults
for required internal data are forbidden. Logging and returning success is also
forbidden. Cleanup belongs in `finally`; error mapping belongs at an entry point.

```ts
// Bad: hides malformed JSON, permissions and every other error.
try {
  return JSON.parse(await readFile(file, "utf8"));
} catch {
  return {};
}

// Good: an optional file's documented absence is the only default.
try {
  return JSON.parse(await readFile(file, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  throw error;
}
```

Keep schemas, authorization, tab ownership, path checks, known external failure
handling and cleanup. A contract that allows absence is different from a missing
required value. Explain the contract for every new fallback; rethrow other errors.

Use one implementation on current Google Chrome Stable or newer. Never add
platform/version protocol alternatives, old/new field aliases, or “try old API
after new API fails.” The persistent default-context download protocol is frozen:

```ts
// Good: default context is selected by omitting browserContextId.
await cdp.send("Browser.setDownloadBehavior", {
  behavior: "allowAndName",
  downloadPath,
  eventsEnabled: true,
});
await cdp.send("Browser.cancelDownload", { guid });
// Bad: passing target.browserContextId, calling Page.setDownloadBehavior,
// spreading hidden parameters, or retrying setDownloadBehavior in catch.
```

Platform discovery/defaults are allowed only in `src/runtime.ts` (Chrome executable
discovery) and `src/config.ts` (display default). Do not add platform branches to
leases, downloads, headers or browser actions. Move any future platform boundary
with its reviewed allowlist entry; do not expand the allowlist to silence a rule.

## Ownership and dependency direction

One lifecycle/resource has one owner:

| Owner              | Responsibility                                                             |
| ------------------ | -------------------------------------------------------------------------- |
| `Steward`          | Readiness, connect/recover/stop, health timer and adapter assembly         |
| `OwnedTabs`        | One tab map, reservations, lease expiry, busy and trace ownership          |
| `CookieSnapshot`   | One recovery snapshot; no parallel snapshot in Steward                     |
| `attach/server.ts` | Foreground attach relay and official subprocess; never owns Chrome/profile |
| Existing adapters  | Chrome process, CDP connection, upstream process, interception, downloads  |

Good: disconnect calls the existing recovery owner, invalidates leases and never
replays failed actions. Bad: CLI and MCP each launch a recovery timer or retain a
second mutable tab map. `Steward.tabs` is the same map exposed by `OwnedTabs`.

- `domain/` is pure: imports only domain code, no Node/SDK/filesystem/network I/O.
- `session/` may use domain rules and injected services; it must not construct or
  import concrete adapters, transports or entry points at runtime. Narrow
  type-only `Pick` contracts over existing adapter APIs are allowed during this
  focused split; they instantiate nothing.
- Adapters implement I/O. Entry points compose them. The existing `steward.ts` is
  the composition/lifecycle facade, not a domain/session module.
- No cycles, unresolved imports, production imports from tests/examples/spike,
  production dev dependencies, or inward imports of entry points.

Good: session calls an injected disk guard. Bad: session imports `node:fs` or
`ChromeProcess` to discover/start Chrome itself. The dependency gate includes
legacy flat adapter paths, not just the future `adapters/` directory.

## Checks and review

Confirm Node, npm and npx availability before repository commands. On macOS use
`/bin/zsh`, non-login by default. Install with the lockfile (`npm ci`).

Run `npm run hooks:install` once per checkout, then `npm run check` and `npm test`.
`check` builds, typechecks, lints, checks dependencies, runs policy fixtures and
the 12 evaluation probes, and checks formatting. The pre-push hook runs `check`.
CI runs these gates plus the unchanged browser suite on Google Chrome Stable:
Linux headless and macOS headless/headed. Failures must fail the job.

Keep quality tests in root `test/`, configuration at the root and rule helpers in
`tools/`. Their relative paths resolve there. Build only `src/` into `dist/`;
do not put test configuration in production output or change package exports.

Static gates recognize explicit syntax/dependency patterns, not all semantic
fallbacks, hidden protocol dispatch or lifecycle errors. Review cohesion, error
propagation and single ownership independently. Preserve public CLI/MCP/Skill
contracts and existing test semantics. Pure moves use the public regression
suite; do not duplicate private implementation tests.

Use the public Tsutomu identity and noreply email. Keep private information,
credentials, profiles and runtime artifacts out of commits. Do not publish or
merge without the task's explicit authorization. Bind independent review to the
exact head commit; a pending or stale review is not a pass.

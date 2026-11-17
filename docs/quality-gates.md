# Quality gate pilot

Base: `8731760` (official chrome-devtools-mcp 1.13.0). This pilot adds repository
contracts and deterministic checks, then splits only the Steward implementation.
CLI, broker, runtime, MCP, Skill and the seven browser regression tests retain
their source and semantics.

## Configuration and execution

| Group           | Location                                      | Enforced boundary                                                                                                                   |
| --------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Failures        | `eslint.config.mjs`, `tools/policy-rules.mjs` | Empty/comment-only catch, empty Promise catch, unguarded empty-result catch                                                         |
| Frozen protocol | Same ESLint plugin                            | Default-context download commands have explicit parameters, no context ID/spread/dynamic key, no catch retry or legacy Page command |
| Platform        | Root ESLint config                            | `process.platform`, computed/destructured reads and named platform imports outside `config.ts`/`runtime.ts` fail                    |
| Dependencies    | Root `dependency-cruiser.cjs`                 | Pure domain; session cannot wire adapters or concrete I/O; no cycles/unresolved imports/dev or test dependencies in production      |
| Size            | Root ESLint config/plugin                     | 300 physical lines; three named legacy files warn and cannot grow                                                                   |

Tool versions are exact development dependencies: ESLint **10.15.0**,
typescript-eslint **8.72.2**, dependency-cruiser **18.7.2**. Use Node **22.13+** for
development checks (the production runtime keeps its existing 22.12+ contract).

```sh
npm ci
npm run hooks:install
npm run check
npm test
```

Individual scripts: `build`, `typecheck`, `lint`, `depcruise` (also `arch`),
`test:quality`, `test:install`, `test:attach`, `evals`, `format:check`. `check` requires all of these. The
executable `.githooks/pre-push` runs `check`; installation uses checkout-local
Git configuration, including worktree-specific configuration for linked trees.
Hooks are explicitly installed, not added to package preparation or consumers'
tarball installation. CI independently enforces the same gates and `npm test`.

The existing Browser Stable workflow retains Linux headless on
`google-chrome-stable` and serialized macOS headless/headed. Each gate and browser
test subprocess uses `check=True`; any failure fails its job. All PR changes run
the workflow. This change does not modify repository branch-protection settings.

Tests are rooted at `test/policy-rules.test.mjs`,
`test/dependency-policy.test.mjs`, `test/gate-config.test.mjs`. Root-relative
configuration, tools and node_modules paths are preserved. They run separately
from the unchanged `test/*.test.ts` browser suite and stay outside `src/`,
`dist/` and the package file allowlist. `tsconfig.json` and package exports are
unchanged. A tarball inventory check confirms no quality fixtures/configuration
are shipped as runtime modules.

## Baseline and structural split

The first gate run against unchanged production code failed on Steward's 458
physical lines and warned on the three deferred files. No catch, download,
platform or dependency violation was reported. Counting includes blanks and
comments; it does not imply cohesion by itself.

| File                                     | Before | After | Owner                                                                          |
| ---------------------------------------- | -----: | ----: | ------------------------------------------------------------------------------ |
| `src/steward.ts`                         |    458 |   275 | Connection, health, recovery, shutdown, composition and existing public facade |
| `src/session/owned-tabs.ts`              |      — |   219 | Lease map, opening reservations, expiry, actions and trace ownership           |
| `src/adapters/chrome/cookie-snapshot.ts` |      — |    51 | CDP snapshot projection and restore, known closed-connection failure           |
| `src/cli.ts`                             |    395 |   395 | Deferred; warning above 300, hard growth cap 395                               |
| `src/broker.ts`                          |    320 |   320 | Deferred; warning above 300, hard growth cap 320                               |
| `src/runtime.ts`                         |    307 |   307 | Deferred; warning above 300, hard growth cap 307                               |

`Steward.tabs` exposes the same map held by `OwnedTabs`, not a copy. Services are
read through the existing Steward so recovery replaces connections without a
stale snapshot. Session receives disk/readiness/cookie callbacks and type-only
narrow adapter API contracts; it constructs no I/O adapter. Recovery still clears
leases and trace state in the original order. Chrome stop, CDP/policy teardown,
download abandonment and reconnect ordering remain in Steward. Cookie field
projection and the `CdpClosedError` handling are moved without changing policy.

The sum of file sizes grows because imports, narrow contracts and the public
facade are explicit. The purpose is distinct owners, not fewer total lines.

## Twelve evaluation probes

`quality/evals.jsonl` preserves the supplied 12-task corpus. `quality/eval-probes.mjs`
provides paired bad/legal syntax and dependency fixtures. `npm run evals` executes
the real ESLint configuration and dependency-cruiser CLI, checks every expectation
and writes `test-results/quality-evals.json`, uploaded with CI artifacts. It also
lints and counts the actual three split modules.

These are deterministic probes, **not** repeated coding-agent experiments or a
claim of improved model success rate. Six tasks have a machine-detected component;
six remain semantic-only. All 12 legal probes must pass without errors/warnings.
Passing a probe does not complete the separate semantic review in its last column.

| Eval | Machine result                                                    | Remaining semantic review                                                         |
| ---- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| E01  | Reject context ID; accept default-context command                 | Download attribution and behavior; browser suite covers the real path             |
| E02  | No hit for invented duration default                              | Verify all producers and persistence, not just field syntax                       |
| E03  | Reject empty Promise catch; accept finally cleanup                | Queue identity, serialization, propagation and no replay                          |
| E04  | No hit                                                            | Response evidence versus server-window drift; mitigation is not root-cause repair |
| E05  | No hit; legitimate DOM ref accepted                               | Independent operation state and cancellation ownership                            |
| E06  | Reject 450 physical lines and dependency cycle; real split passes | Coherent owners, complete lifecycle and pure structural diff                      |
| E07  | No hit for arbitrary IDL aliases                                  | Single frozen field, transport parsing and business bytes boundary                |
| E08  | Reject arbitrary empty catch result; accept ENOENT plus rethrow   | Damaged JSON/EACCES propagate, rather than deleting legitimate absence handling   |
| E09  | No hit for invented media; required input validation accepted     | Parser guarantees and audio-track validity                                        |
| E10  | No hit for logging then success; error mapping accepted           | Caller must observe failure; logging alone does not prove this                    |
| E11  | Reject production import from example fixture                     | Inline resource constants versus legitimate protocol enums                        |
| E12  | Reject session wiring manager adapter; accept injected reader     | Public API ownership, auth/filtering and retained management write behavior       |

The original 16 AST and six dependency fixtures pass. Additional fixtures cover
empty fallbacks, legacy/Promise protocol retries, platform boundaries, physical
size debt, domain I/O, legacy flat adapters and legal type-only ports.

## Limits, independent review and rollback

Syntactic gates do not prove an arbitrary fallback is legitimate. A conditional
throw may evade the narrow empty-fallback rule; indirect or dynamically selected
protocol commands, namespace/aliased platform access and semantic duplicate state
need review. These omissions are explicit instead of broad heuristics that reject
legitimate error mapping or ENOENT handling. Dependency names encode ownership
boundaries, not the full meaning of each API.

The independent reviewer must bind findings to the PR head SHA, inspect the
structural diff and gate coverage/false positives, and independently reproduce
Linux checks. That approval remains pending when this PR is opened. Do not merge,
tag, publish or release as part of the pilot.

Public-registry `npm audit` reports seven moderate entries in the pinned
development-tool minimatch dependency chain; `npm audit --omit=dev` reports zero.
The requested tool versions remain exact; no audit-driven version change or
override is included in this structural pilot.

Rollback is a revert of this pilot commit. No persistent format, CLI, MCP, Skill,
dependency runtime version or protocol is migrated; quality tools are dev-only.
The separate extension PR is outside the diff.

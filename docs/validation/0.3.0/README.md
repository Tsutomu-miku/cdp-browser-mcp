# 0.3.0 attach validation

Local validation on 2026-11-17, based on main `33ada877e99d3e0333e5f8da47c680d4917c641d`:

- macOS 27.2; Node.js 22.17.0; npm 11.17.0.
- Google Chrome 157.0.8103.79; pinned official chrome-devtools-mcp 1.13.0.
- Fresh `npm ci` with empty user/global npm configurations, a new cache and `https://registry.npmjs.org`: passed. Dependency versions and public registry URLs are unchanged.
- `npm run check`: passed build, typecheck, lint, dependency checks, 40 quality tests, 6 installer tests, 11 Chrome-free attach contracts, 12 paired evaluation probes and formatting.
- New production modules lint with `--max-warnings 0`: passed. Only the three frozen legacy size warnings remain; CLI shrinks from 395 to 355 physical lines. Broker/runtime and all seven existing browser test contracts are unchanged.
- `npm test`: 18/18 passed (7 isolated browser tests plus 11 attach contracts), no skips.
- `npm run test:headed`: final full run 18/18 passed, no skips. An initial headed run was 17/18: the existing supervisor-kill/orphan-recovery test returned `fetch failed`. Five targeted repetitions on unchanged main passed, as did the full branch rerun with network diagnostics. The initial cause was not reproduced or established. No existing test assertions, deadlines or isolated runtime logic were changed to obtain a pass.

Attach contracts exercise the real SDK stdio/subprocess boundary with a fixture official peer. They cover autoConnect/channel arguments, rejection of isolated-only capabilities, prerequisite failure guidance, pending authorization deadlines, official schemas/results/tool errors, EOF, signals and upstream death. They do not connect to the daily Chrome profile. Older-browser/denial errors are simulated and retain the upstream cause; ambiguous official errors receive a prerequisite checklist rather than an invented diagnosis.

## Pending human gate

Daily Chrome attach E2E is **not performed / awaiting the maintainer's authorization**. A human must enable remote debugging at `chrome://inspect/#remote-debugging` and click Allow in Chrome's connection dialog. The agent must not perform either action. Follow the [manual acceptance checklist](../../testing.md#attach-manual-acceptance) and record the exact reviewed PR head with the results.

The version is 0.3.0 in package metadata, with no tag, Release or npm publication created. Independent review remains required before merging or releasing.

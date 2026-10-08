# Task 10 evidence — Capability-based account gate with TTL

Todo: `.omo/plans/project-ide.md` todo 10. Branch: `alwork-ide-wave1`,
worktree `I:/migration/Alwork-wt/wave1` only. Never touched:
`I:/migration/Alwork` (sibling checkout; read-only fixture source),
LICENSE/NOTICE, pairing crypto, dependencies. No merge, no push.
This file lives at `<worktree>/.omo/evidence/task-10-project-ide.md` so the
whole todo stays on the worktree branch.

## Step 0 receipt — worktree verification (before edits)

- Branch: `alwork-ide-wave1` (expected).
- `git status --porcelain=v1`: clean (empty) before edits; base HEAD
  `0ccd0dd199a2d258de6cb473e24a3be9d50d2804`
  (`0ccd0dd feat(workspace): multi-repo roots with per-repo context`).
- Prior work on the branch is the prescribed wave-1 set
  (`36dd5fc` auth seam, `df075b2` slot, `373319d` adapter bridge,
  `0ccd0dd` workspace wiring): nothing unexpected, so no STOP was needed.

## What shipped (scope: worktree gate files + this evidence)

1. `packages/web/server/lib/ide-gate/ide-gate.js` — pure gate core:
   `createIdeGate({ secret, tokenPanel, now?, ttlMinutesFallback? })` with
   `mintAtLogin` (login -> WHO `{sub,sid}` -> customer tier string -> tier
   read -> HMAC capability), `checkInvocation` / `verifyLocally` (local
   only, zero TokenPanel calls by construction), `refresh` (async re-read),
   `resolveTierBody` (task-9 fallback), `chromeForCapability` (tier
   badge + locked features), plus `loadTierMatrixFixture` and `IdeGateError`
   (`IDE_GATE_DENIED` / `IDE_GATE_UNAVAILABLE` / `IDE_FIXTURE_MALFORMED` /
   `IDE_GATE_MISCONFIGURED`).
2. `packages/web/server/lib/ide-gate/ide-tier-matrix.fixture.json` —
   vendored copy of `I:/migration/Alwork/config/ide-tier-matrix.json`
   (free-tier allow/basic-ide, pending-payment deny/empty, paid
   allow/full-access, every tier TTL 15). The test asserts tier-for-tier
   equality with the source.
3. `packages/web/server/lib/ide-gate/ide-gate.test.js` — 13 fixture-stub
   tests (bun:test, manual clock seam, call-count assertions; no sleeps,
   no servers).
4. `packages/web/server/lib/ide-gate/DOCUMENTATION.md` — owning-module docs
   (change-discipline completion standard).
5. This evidence file.

TokenPanel is the API of record (`.omo/evidence/task-9-project-ide.md`):
the injected `tokenPanel.getGate(tier)` answers the documented
`GET /gate?tier=` body shape; fallback mirrors the record (transient serves
last-known within one TTL of grace with `stale:true`, past grace throws
`IDE_GATE_UNAVAILABLE` for a 503 deny-closed mapping, unknown tier /
non-transient failure throws `IDE_GATE_DENIED`, never serves stale).
Surfaces (ui-api-decoupling): web + Electron desktop enforce in the same
server invocation path; VS Code / hosted-mobile / Capacitor-mobile pane
rendering is explicitly unsupported (plan excludes those pane hosts); the
server gate answers identically wherever it runs. Capability signing is
gate-local HMAC; pairing crypto untouched.

## Read FIRST (AGENTS.md rules)

- `packages/web/server/lib/ui-auth/ui-auth.js` + `ui-auth.test.js`
  (login seam, Alcore session shape) before designing the WHO input.
- `packages/web/server/lib/opencode/omo-bridge-runtime.js` head (invocation
  path the gate guards; kept decoupled — no bridge edits).
- `.agents/skills/openchamber-change-discipline/SKILL.md` and
  `.agents/skills/ui-api-decoupling/SKILL.md` (both triggers matched).
- Nearest `DOCUMENTATION.md` (`ui-auth/DOCUMENTATION.md`) + web
  `package.json` (test runner: bun:test files via `bun test`).

## Manual-QA: literal invocations with captured outputs

`bun -e` against the worktree module (bounded, single-shot, no servers):

```
MINT {"tier":"paid","allowed":true,"features":["full-access"],"ttlMs":900000,"calls":1}
INVOKE {"allowed":true,"reason":"ok","calls":1}
FLIP {"features":["full-access","wave2-probe"],"stale":false}
CHROME {"badge":"IDE · paid","allowed":true,"tier":"paid","features":["full-access","wave2-probe"],"locked":["basic-ide"],"reason":"ok"}
TAMPER {"allowed":false,"reason":"tampered"}
```

Reading: fixture login mints a capability with TTL 900000 ms (15 min);
per-invocation check passes with the stub call count still 1 (zero
additional TokenPanel calls); an operator tier flip (`paid` gains
`wave2-probe`) reflects via `refresh` in-process with no rebuild; pane
chrome shows the tier badge; a tampered capability denies.

Outage / adversarial invocations (same harness, clock seam):

```
OUTAGE-INSIDE-GRACE {"stale":true,"source":"cache","features":["full-access"]}
OUTAGE-PAST-GRACE IDE_GATE_UNAVAILABLE
HARD-INVALID IDE_GATE_DENIED
BAD-TIER IDE_GATE_DENIED
```

Reading: transient outage inside grace serves cached with `stale:true`;
past grace denies closed (`IDE_GATE_UNAVAILABLE` -> 503); hard-invalid
denies; unknown tier denies at login.

## Adversarial probes

| Probe | Input | Output (verbatim) | Verdict |
|---|---|---|---|
| malformed input (bad tier) | `mintAtLogin({whoSession:{sub:'u',sid:'s'},customerTier:'evil-tier'})` | `IDE_GATE_DENIED` | denied, nothing minted |
| malformed input (tampered capability) | `{...capability, sig:'00'}` / flipped features | `{allowed:false, reason:'tampered'}` | denied, zero TokenPanel calls |
| expired tier | clock `+= 15min + 1ms`, then `checkInvocation` | `{allowed:false, reason:'expired'}` | denied locally |
| TokenPanel outage | `mode='transient'`, `+5min` then `+60min` | `stale:true` / `IDE_GATE_UNAVAILABLE` | fallback then deny-closed |
| pending-payment | login with `customerTier:'pending-payment'` | capability `allowed:false`, `checkInvocation {allowed:false}` | deny at invocation |
| stale_state (SHAs recorded) | `git rev-parse HEAD` | `0ccd0dd199a2d258de6cb473e24a3be9d50d2804` pre-edit | pins reproducible |
| dirty_worktree (only intended files) | `git status --porcelain=v1` | `?? packages/web/server/lib/ide-gate/DOCUMENTATION.md`, `?? .../ide-gate.js`, `?? .../ide-gate.test.js`, `?? .../ide-tier-matrix.fixture.json` (+ this evidence file) | no drift |
| misleading_success_output (assert bodies) | every QA line above asserts response bodies / reasons / call counts, not exit codes | `calls:1` after invoke; `stale:true` body; `reason:'tampered'` | bodies asserted |
| hung_commands (bounded) | all probes single-shot `bun -e` / `bun test`, no watchers/polls/servers | longest under 1s; clock is a manual seam, zero sleeps in tests | no hangs |

## Validation summary (honest)

- Focused gate tests: `bun test packages/web/server/lib/ide-gate/ide-gate.test.js`
  **13 pass / 0 fail** (40 expects). One iteration: initial chrome
  expectation for `paid` said `locked:[]`; the true contract is
  locked = ALL minus granted (`['basic-ide']`) — fixed in the test, not
  the code.
- `bunx oxlint` on both gate JS files: clean after renaming two `shape`
  locals to `decoded`/`decodedRefresh` (`no-shape-in-symbol-names`).
- Neighbors: `bun test packages/web/server/lib/ui-auth/ui-auth.test.js`
  **12 pass / 0 fail** — login seam untouched and green.
- Full suites NOT run (out of scope for this todo; todo 16 owns
  full-suite-green; AGENTS.md prescribes the narrowest validation for a
  new isolated module).
- No servers started, no PIDs, no temp files remain; nothing to kill.

## STOP condition

Fixture login mints a TTL capability + per-invocation local pass with zero
TokenPanel calls + tier flip within TTL with no rebuild + evidence
recorded. Met.

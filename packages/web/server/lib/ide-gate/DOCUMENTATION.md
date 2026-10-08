# IDE Gate Module Documentation

## Purpose

Capability-based account gate for the IDE (project-ide todo 10). Check
order: login -> WHO (auth-service session `{ sub, sid }`) -> customer lookup
(tier string) -> tier (TokenPanel read API, task-9 contract) -> gate. Login
mints a short-lived HMAC capability (TTL from the tier matrix fixture,
default 15 minutes); each engine invocation verifies it locally with zero
TokenPanel calls; an async refresh re-reads the tier so flips land within
one TTL without a rebuild. Pane chrome derives a tier badge and locked
features from the same capability.

## Entrypoints and structure

- `packages/web/server/lib/ide-gate/ide-gate.js`: pure gate core
  (`createIdeGate`, `loadTierMatrixFixture`, `ttlMsForMinutes`,
  `IdeGateError`). The TokenPanel reader is injected as
  `tokenPanel.getGate(tier)` answering the task-9 `GET /gate` body shape, so
  this module never imports TokenPanel code.
- `packages/web/server/lib/ide-gate/ide-tier-matrix.fixture.json`: vendored
  copy of `I:/migration/Alwork/config/ide-tier-matrix.json` (free-tier
  allow/basic-ide, pending-payment deny/empty, paid allow/full-access, all
  TTL 15). The test asserts byte-level tier equality with the source.
- `packages/web/server/lib/ide-gate/ide-gate.test.js`: fixture-stub tests
  (bun:test, manual clock seam, call-count assertions, no sleeps/servers).

## Public exports (ide-gate.js)

- `createIdeGate({ secret, tokenPanel, now?, ttlMinutesFallback? })`:
  - `mintAtLogin({ whoSession, customerTier })` -> `{ capability, gateBody, stale }`
  - `checkInvocation(capability)` -> `{ allowed, reason }` (local only)
  - `verifyLocally(capability)` -> `{ ok, capability? , reason? }` (local only)
  - `refresh(capability)` -> `{ capability, gateBody, stale }` (async re-read)
  - `resolveTierBody(tier)` -> `{ body, stale }` (task-9 fallback inside)
  - `chromeForCapability(capability)` -> `{ badge, allowed, tier, features, locked, reason }`
- `loadTierMatrixFixture(jsonText)` validates the todo-3 fixture shape.
- `IdeGateError` codes: `IDE_GATE_DENIED` (malformed/bad-tier/tampered/
  hard-invalid -> deny), `IDE_GATE_UNAVAILABLE` (past-grace outage -> 503
  deny-closed), `IDE_FIXTURE_MALFORMED`, `IDE_GATE_MISCONFIGURED`.

## Fallback contract (task-9 of record)

Transient `TOKENPANEL_TRANSIENT` failures serve the last-known body within
two TTLs of fetch time (TTL cache + one TTL grace) with `stale:true`;
past grace throws `IDE_GATE_UNAVAILABLE`; unknown tiers, invalid bodies,
and non-transient failures throw `IDE_GATE_DENIED` and never serve stale.

## Surfaces

Web + Electron desktop: enforced in the server invocation path (same
server). VS Code / hosted-mobile / Capacitor-mobile pane rendering:
explicitly unsupported (plan excludes those pane hosts); the server gate
answers identically wherever it runs.

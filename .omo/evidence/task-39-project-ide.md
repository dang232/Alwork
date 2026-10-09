# Task 39 evidence — IDE OS-keychain token storage + user-Bearer quota

Branch: `ide-usertoken` (off `alwork-ide-wave1`), worktree
`I:/migration/Alwork-wt/wave1` only. Never touched: `I:/migration/Alwork`
(sibling checkout), auth semantics (no issuance/validation logic — only
storage/presentation), push/merge/sign. This file lives at
`<worktree>/.omo/evidence/task-39-project-ide.md`.

## Step 0 receipt — worktree verification (before edits)

- Base branch: `alwork-ide-wave1`, HEAD `06537da1e13c930d099f396bd89fe44da51b008d`
  (`06537da feat(ui): profile, tier badge and quota in account panel`).
- `git status --short` before edits: the prescribed uncommitted task-36
  set (`M desktop-auth.{js,test.js,DOCUMENTATION.md}`,
  `M feature-routes-runtime.js`, `M ui-auth.{js,test.js,DOCUMENTATION.md}`,
  `?? lib/tokenpanel/`, `?? .omo/evidence/task-36-*`) — preserved,
  built on top, no drift.
- New branch `ide-usertoken` created off that HEAD; uncommitted files
  carried over untouched.

## What shipped (scope: IDE only)

1. `packages/web/server/lib/user-tokens/user-token-store.js` (new) —
   keychain store for the login-captured pair (access JWT + opaque
   rotating refresh). Ciphertext persists to
   `<dataDir>/user-tokens.json` (mode 0o600) when Electron safeStorage is
   available; process memory only otherwise. Seam mirrors safeStorage's
   shape exactly (`isEncryptionAvailable/encryptString/decryptString`)
   plus a `{readAll, writeAll}` persist seam. Owns the auth-service
   rotation (`POST {authBase}/auth/token/refresh`, base from the Alcore
   issuer origin) with named errors (`USER_TOKEN_NO_REFRESH` /
   `USER_TOKEN_REFRESH_TRANSIENT` / `USER_TOKEN_REFRESH_REJECTED`).
   Nothing here logs tokens; decrypt failure drops the entry.
2. `packages/web/server/lib/desktop-auth/desktop-auth.js` — capture at
   loopback completion: after a 200 issuance the proven pair is saved
   keyed by the verified subject (JWT `sub` decode on the local-verify
   path — keying only, trust from the issuance; live-confirmed `sub` on
   the introspection path). The Google refresh token rides the
   server-held pending entry from callback into `google-complete`. A
   failing store never fails the login. Opaque/unkeyable tokens log in
   with no save.
3. `packages/web/server/lib/ui-auth/ui-auth.js` — additive read-only
   `resolveRequestAlcoreSub(req)` (Bearer verify → sub; cookie session →
   issuance-bound sub; else `''`). Mirrors `GET /auth/session`; never
   consulted by validation; issuance/cookies/TTLs untouched.
4. `packages/web/server/lib/tokenpanel/tokenpanel-quota.js` (rework) —
   forwards the CALLER's Bearer (no service key anywhere on this path),
   enforces self-only (`authUserId === sub`, else 403 without touching
   tokens/network), refreshes ONCE on upstream 401 and retries; refused
   refresh / missing refresh / second 401 clears the pair and answers 401
   `tokenpanel_session_expired`; transient refresh failures keep
   stale-in-grace. Every `TOKENPANEL_MGMT_KEY` reference deleted from
   user-facing code and docs.
5. Wiring: `core-routes.js` passes `sharedUserTokenStore()` to desktop
   auth; `feature-routes-runtime.js` passes the same singleton +
   `resolveSubject` (from `uiAuthController`) to the quota proxy;
   `server/index.js` threads `uiAuthController` into feature-route deps.
6. Renderer: `signOutToGate.ts` (new, owns the shared reset + desktop
   credential clear + reload sequence, once-guarded with a sessionStorage
   marker that a later healthy read clears); `accountQuota.ts` signs out
   once on `tokenpanel_session_expired` then reads `unavailable`;
   `AccountProfile.tsx` reuses `signOutToGate` (behavior preserved).
   No new UI copy (no i18n keys), no styling (`theme-system` +
   `locale-ui-patterns` read, no-op recorded).
7. Tests: store 12, desktop-auth +6 capture (40 total), ui-auth +3
   subject seam (24), tokenpanel rewritten 16, quota hook +5 chain (9),
   signOutToGate 4 (new). Docs: tokenpanel rewritten, desktop-auth +
   ui-auth sections added.

Surfaces (ui-api-decoupling): web + Electron desktop share the server
path (capture on desktop login; cookie/Bearer subject resolution);
VS Code has no such server (surface hidden, unchanged); hosted/Capacitor
inherit shared-UI behavior wherever this server runs. Enterprise
boundary: no new crossing (tokens stay on this machine; the quota proxy
is the pre-existing TokenPanel read, now caller-authenticated) —
`enterprise-boundary` read, no gate change needed.

## Where secrets rest (DoneClaim ledger)

- Loopback completion: pair in process memory → safeStorage-encrypted;
  ciphertext to `user-tokens.json` (0o600) on desktop, memory-only
  without Electron. Plaintext never on disk, never localStorage, never
  logs (one warn line names only the failure step).
- Proxy read: decrypted in memory per request; Bearer sent server→
  TokenPanel over TLS, never URL/browser/logs; upstream cookies never
  forwarded.
- Refresh: `refresh_token` in POST body server→auth-service over TLS
  only; rotated pair re-saved, old value overwritten.
- Expiry: pair cleared from memory AND ciphertext; renderer holds no
  token at any step (it only sees the `tokenpanel_session_expired`
  code, then the gate).

## Read FIRST (AGENTS.md rules)

- `desktop-auth.js` + test (completion flow, harness precedent),
  `ui-auth.js` (issuance/binding/status shapes), `tokenpanel-quota.js` +
  test + DOCUMENTATION (route contract), `accountQuota.ts`,
  `accountSession.ts`, `AccountProfile.tsx` (subject + sign-out flow),
  `runtime-auth-expiry.ts` (401-classifier non-interference),
  `runtime-fetch.ts` (global-fetch seam for tests).
- Skills: `openchamber-change-discipline`, `ui-api-decoupling` (+
  `references/implementation-map.md`), `desktop-shell`,
  `enterprise-boundary`, `theme-system`, `locale-ui-patterns`.
- Nearest docs: `desktop-auth/DOCUMENTATION.md`,
  `ui-auth/DOCUMENTATION.md`; runners from package scripts.

## Manual-QA: literal invocations with captured outputs

Real-module composition over real HTTP (`bun qa-server.mjs` in a temp
dir OUTSIDE the repo: real `createUiAuth` + real desktop-auth + real
quota runtime + shared keychain singleton + real subject resolver; only
the tunnel classifier is local). External services are fixture-shaped
local stub HTTP servers (disclosed): stub auth-service (login pair,
`/auth/token/refresh` rotation, `/auth/me`) and stub TokenPanel (Bearer
`sub == authUserId` enforcement, live/deny-once/denied modes). Login JWTs
are HS256 tokens minted with a LOCAL-ONLY test secret; no real
credentials exist or were used. Plain Node has no Electron, so the store
ran memory-only here (keychain/file paths proven by unit tests).

```
quota no-session        -> 401 {"error":"UI authentication required","locked":true}
email login             -> 200 {"authenticated":true,"alcore":{"sub":"user-qa","sid":"qa-sess"}}
quota live              -> 200 {...,"source":"live","stale":false}   (stub asserted Bearer sub == user-qa)
quota someone-else      -> 403 {"error":"tokenpanel_forbidden"}
quota missing authUserId-> 400 {"error":"invalid_request"}
deny-once then quota    -> 200 live   (stub log: ONE refresh POST {"refresh_token":"qa-refresh-1"}, retry live)
deny + refuse then quota-> 401 {"error":"tokenpanel_session_expired"} (stub log: retried refresh {"refresh_token":"qa-refresh-2"} refused)
quota after clear       -> 503 {"error":"tokenpanel_not_configured"}
POST /api/auth/reset    -> 200 {"cleared":true,"clearedPasskeys":0,"signedOutEverywhere":true}
```

Key hygiene: no response body above carries a JWT or refresh value
(tokens travel only in `Authorization` headers and the refresh POST
body, server→stub over loopback). No `TOKENPANEL_MGMT_KEY` in any
user-facing code or doc (only this file's history note + the frozen
task-36 evidence mention it).

Screenshots: NONE — no browser binary exists on this machine (`where
msedge/chrome/chromium` all absent) and the fixed callback port 57123 is
held by a foreign live Electron (PID 32420, never touched), so no UI
could be captured; HTTP-level proof above stands in, disclosed.

## Adversarial probes

| Probe | Input | Output (verbatim) | Verdict |
|---|---|---|---|
| malformed input (quota) | missing / empty / 129-char / array `authUserId` | `400 {"error":"invalid_request"}` ×4, zero upstream AND zero store reads (unit); missing-param `400` live | rejected before token use |
| malformed input (pair) | refresh-only / empty access / numeric refresh | `502`, zero sessions, zero saves | fail closed |
| hostile input (subject) | `authUserId=user-2` as `user-1` | `403 {"error":"tokenpanel_forbidden"}`, zero upstream | self-only holds |
| hostile input (token sub) | JWT `sub` disagrees with `/auth/me` | stored under confirmed `sub` | introspection wins |
| stale_state (SHAs) | `git rev-parse HEAD` pre-edit | `06537da1e13c930d099f396bd89fe44da51b008d` | pins reproducible |
| dirty_worktree | `git status --short` at close | only intended files (15 M + task-36 set + 4 new paths) | no drift |
| hung_commands | single-shot `bun test` / `curl -m 10` / bounded probes | longest suite < 3 s; QA curls ≤ 10 s budgets | no hangs; scratch servers killed, ports free, temp dirs removed (see receipt) |
| key hygiene | grep responses/logs/code for token + mgmt-key shapes | tokens only in auth headers/refresh body; zero mgmt refs in user paths | holds |
| failing store | `savePair` throws at login | `200` + session issued | storage never breaks login |
| locked keychain | `isEncryptionAvailable() === false` | memory-only, no file written, restart reads empty | fail-safe to re-login |

## Validation summary (honest)

- Focused (bun): store 12, desktop-auth 40, callback-listener 7,
  ui-auth 24, tokenpanel 16, accountQuota 9, accountSession 16,
  signOutToGate 4 — **128 pass / 0 fail**.
- Canonical runners: web `vitest` on the 4 server suites **92/92**;
  `core-routes` **34/34** (base note said 33/34 with a shim failure —
  green here); UI isolated runner on layout dir **13/13 files**.
- `tsc --noEmit` (packages/ui): clean. `bunx oxlint` on every
  created/edited file: **zero new findings** (tracked files diffed
  against a `git stash` baseline; remaining hits are the known
  backlog; new files clean). `bun run dead-code`: inspected — three
  new exports un-exported after the report (`USER_TOKEN_FILE_NAME`,
  `defaultAuthServiceBase`, `TOKENPANEL_SESSION_EXPIRED`, all used
  in-module); the flagged account types are pre-existing.
- Full suites NOT run (narrowest validation per AGENTS.md).
- Live-stack QA above (real modules + real HTTP, fixture-shaped
  externals, disclosed). Renderer sign-out executes against the real
  `/api/auth/reset` route (200 above); the reload-into-gate step is
  unit-proven (reset POST + reload observed), not browser-observed.

## STOP condition

Tests prove keychain-store → attach → refresh-retry → sign-out. Met —
see DoneClaim.

## DoneClaim (explicit real-vs-fixture verdict): FULL (with stated bounds)

- REAL (proven on the live local chain): gate 401; email login 200 with
  `alcore.sub`; quota 200 live through the captured pair (stub enforced
  Bearer-sub match); 403 self-only; 400 malformed; deny-once →
  single-refresh → 200 live (rotation persisted: the next refresh sent
  the rotated value); deny+refuse → 401 `tokenpanel_session_expired`;
  cleared pair → 503; reset → 200 `signedOutEverywhere`. Renderer
  401-expired → reset POST + reload is unit-proven through the real
  `runtimeFetch`.
- FIXTURE (unit-level only, disclosed): safeStorage itself — no Electron
  runtime exists on this machine, so the OS-keychain path ran against
  seam fakes shaped exactly like safeStorage (encrypt/decrypt round-trip,
  lockout, foreign-key failure), with ciphertext file round-trip through
  a real temp file. The auth-service refresh endpoint shape
  (`POST /auth/token/refresh` with `{refresh_token}`, `{access_token,
  refresh_token?}` answer) is the contract assumption both tracks share;
  the stub implements it verbatim.
- NOT demonstrated: a packaged-desktop run with a real OS keychain, a
  live Google loopback completion with a service-issued refresh token,
  and the browser-observed reload into the gate. What stands in the way
  is environment, not code: no Electron/browsers/credentials on this
  machine and no sign/provision authority.

## Cleanup receipt

- QA stack (API :38971 + stubs :38972, one `bun` process): killed;
  `netstat` shows no listeners on either port (TIME_WAIT only, kernel).
- Scratch dirs (`ide39-qa/`, `ide39-qa2/` incl. server file, cookie
  jars, logs, temp data dir): removed.
- Earlier QA attempts that exited between probes: same process family,
  all dead; no stray `bun`/`curl` work besides this session's eval
  kernel.
- Foreign Electron (PID 32420, holds 57123): never touched.
- `git status --short` at close: only intended files (see adversarial
  table); `git branch --show-current` → `ide-usertoken`.

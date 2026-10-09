# Task 36 evidence — IDE account panel wired to real data

Branch: `alwork-ide-wave1`, worktree `I:/migration/Alwork-wt/wave1` only.
Never touched: `I:/migration/Alwork` (sibling checkout), LICENSE/NOTICE,
auth semantics (no token/cookie/issuance change), pairing crypto,
dependencies. No push, merge, deploy, or signing.
This file lives at `<worktree>/.omo/evidence/task-36-project-ide.md`.

## Step 0 receipt — worktree verification (before edits)

- Branch: `alwork-ide-wave1` (expected).
- Base HEAD: `06537da1e13c930d099f396bd89fe44da51b008d`
  (`06537da feat(ui): profile, tier badge and quota in account panel`).
- `git status --porcelain=v1` before edits: clean.
- Prior work on the branch is the prescribed wave-1 set (auth seam,
  slot, adapter bridge, workspace wiring, gate, pane, desktop login
  fixes, panel UI): nothing unexpected, so no STOP was needed.

## What shipped (scope: worktree IDE files + this evidence)

1. `packages/web/server/lib/tokenpanel/tokenpanel-quota.js` (new) —
   `GET /api/tokenpanel/quota?authUserId=` proxy. Service auth reuses the
   deployment's existing TokenPanel contract (`TOKENPANEL_API_URL`,
   default `https://alcore.io.vn`; `TOKENPANEL_MGMT_KEY` as
   `Authorization: Bearer`, server-side only, never logged/forwarded).
   Read discipline mirrors the ide-gate fallback: live wins; transient
   outage serves last-known within one TTL of grace (60 s) with
   `stale:true`; past grace / cold cache fails closed (503); hard-invalid
   (401/403/404, malformed body) never serves stale (502); unconfigured
   answers 503 without calling upstream. Every failure maps to the hook's
   `unavailable` — never a fabricated quota.
2. `packages/web/server/lib/tokenpanel/tokenpanel-quota.test.js` (new) —
   8 serviceFetch-stub tests, manual clock seam, no servers, no sleeps.
3. `packages/web/server/lib/tokenpanel/DOCUMENTATION.md` (new) —
   owning-module docs.
4. `packages/web/server/lib/opencode/feature-routes-runtime.js` —
   registers the proxy beside the other explicit routes: behind the
   existing `/api` session gate, before the generic OpenCode proxy.
5. `packages/web/server/lib/desktop-auth/desktop-auth.js` — captures the
   service-verified Google profile (`profile: { name?, picture? }` from
   the `POST /auth/google/desktop-code` answer, which the service persists
   nowhere) onto the pending login at the loopback callback; threads it
   server-side through `google-complete` into the session body; email from
   the pair user view (Email/OTP, zero extra calls) or best-effort
   `GET /auth/me` with the fresh pair (Google; fail-open). Client poll
   bodies cannot mint profile fields. Issuance, cookies, validation,
   rate limits untouched.
6. `packages/web/server/lib/ui-auth/ui-auth.js` — TTL-bounded in-memory
   session→profile map (2000 keys max, swept on write, expires with the
   owning session, cleared on global sign-out/dispose, never consulted by
   validation). Bound at issuance (cookie token + desktop client id);
   read on `GET /auth/session` for cookie and client sessions as
   `alcore: { sub, name?, picture?, email? }` — the exact shape the panel
   parser already handles. Absent/malformed profile answers the old shape
   byte-for-byte. No JWT/cookie/validation change.
7. Tests extended: `desktop-auth.test.js` (+5: capture, malformed drop,
   email-fail-open, pair-email without extra read, hostile-input ignore),
   `ui-auth.test.js` (+6: cookie/client enrichment, old-shape preserved,
   malformed ignored, partial field-wise, unbound client shape).
8. Docs updated: `desktop-auth/DOCUMENTATION.md`,
   `ui-auth/DOCUMENTATION.md` (read-through contract).
9. This evidence file + `task-36-shot-locked.png` +
   `task-36-shot-panel.png`.

No UI files changed: the shipped parser/hook already handled the enriched
shapes, so no i18n keys and no theme tokens were touched
(`theme-system` + `locale-ui-patterns` read, no-op recorded).

Surfaces (ui-api-decoupling): web + Electron desktop share the server
path (profile capture on desktop login; cookie/client status enriched);
VS Code hides the panel (unchanged, explicitly unsupported server-side —
no VS Code server implements these routes); hosted/Capacitor mobile
inherit shared-UI behavior wherever this server runs.

## Honest deviations from the brief (verified, not assumed)

- The brief names "the EXACT service-auth pattern the existing ide-gate
  uses for its TokenPanel reads". `ide-gate.js` was read first: it is
  pure/injected (`tokenPanel.getGate(tier)`) and contains NO credential
  handling at all. The proxy instead reuses the repo's actual
  TokenPanel service-auth precedent — `Authorization: Bearer tp_mgmt_*`
  against `TOKENPANEL_API_URL`/`TOKENPANEL_MGMT_KEY`, the exact env
  contract the Libre backend's `tokenpanelBridgeService.ts` uses — plus
  the desktop-auth service-call shape (15 s timeout, own JSON answers,
  upstream `Set-Cookie` never forwarded) and the ide-gate read
  discipline (live → stale-in-grace → fail-closed). No new credentials
  were invented.
- The brief asserts live `GET /admin/ide/quota` "exists and answers 401".
  Probed: it 401s `{"error":"unauthorized"}` — but so does the
  definitely-bogus `/admin/ide/definitely-not-here-xyz`. The 401 comes
  from TokenPanel's uniform management-gate middleware (verified in
  AlRepo `management-auth.ts`: uniform 401, Bearer `tp_mgmt_*` scheme),
  which runs before routing — so the 401 proves auth-gating, NOT that
  the route exists. No `/ide/` route exists in any local checkout
  (AlRepo, shared-identity snapshot, auth-service). The proxy targets the
  documented path, validates any 200 against the hook's contract, and
  fails closed otherwise.
- Tier: the panel badge renders only when the session carries a tier.
  The IDE server has no customer-tier read (WHO → customer lookup does
  not exist here), and the live quota shape is unverifiable without a
  management key, so a fresh real login shows NO tier. Reported as-is;
  no tier was fabricated.

## Read FIRST (AGENTS.md rules)

- `packages/web/server/lib/ide-gate/ide-gate.js` (service-auth pattern
  check — found pure/injected, see above).
- `packages/web/server/lib/ui-auth/ui-auth.js` + `ui-auth.test.js`
  (login seam, session shapes) before designing the profile binding.
- `packages/web/server/lib/desktop-auth/desktop-auth.js` +
  `desktop-auth.test.js` (completion flow, harness precedent).
- `packages/ui/src/components/layout/AccountProfile.tsx`,
  `accountQuota.ts`, `accountSession.ts` (+ tests): established the exact
  expected wire shapes — no UI change needed.
- Auth-service `src/routes/auth.ts` (`/auth/me` = `{id,email,
  emailVerified}` only; `desktop-code` returns `{access_token,
  profile?}` with the "products own profiles" contract) and
  `src/lib/google.ts` (profile bounds mirrored for validation).
- Skills: `ui-api-decoupling` (+ `references/implementation-map.md`),
  `theme-system`, `locale-ui-patterns`,
  `openchamber-change-discipline`.
- Nearest docs: `desktop-auth/DOCUMENTATION.md`,
  `ui-auth/DOCUMENTATION.md`; test runner from package scripts
  (`bun test`).

## Manual-QA: literal invocations with captured outputs

Full-stack composition of REAL product modules over real HTTP
(`bun qa-server.mjs` in a temp dir OUTSIDE the repo: real `createUiAuth`
+ real `registerRoutes` + real quota runtime + real prebuilt `dist/`
UI; only the tunnel classifier is local and no service was stubbed —
deleted after the run). A second full product server could not start:
the fixed desktop callback port 57123 is held by a live Electron desktop
app (PID 32420, this worktree's electron build) — by design there is no
fallback, and the foreign process was not touched. Login JWTs below are
HS256 tokens minted with a LOCAL-ONLY test secret (`ALCORE_JWT_SECRET`
pointed at the scratch server); no real credentials exist or were used.

```
quota no-session       -> 401 {"error":"UI authentication required","locked":true}
login                  -> 200 (port-scoped cookie oc_ui_session_3941=...)
status plain           -> 200 {"authenticated":true}
quota unconfigured     -> 503 {"error":"tokenpanel_not_configured"}
quota bad "" / "=" / x129 / dup -> 400 {"error":"invalid_request"} (x4)
login+profile          -> 200
status enriched        -> 200 {"authenticated":true,"alcore":{"sub":"user-9","email":"ada@example.test","name":"Ada Lovelace"}}
desktop config (live)  -> 200 {"googleConfigured":false}
callback unknown-state -> 410 named page (data-auth-error="invalid_state")
```

Live upstream probes (`curl`, bounded):

```
GET https://alcore.io.vn/admin/ide/quota                -> 401 {"error":"unauthorized"}
GET https://alcore.io.vn/admin/ide/quota?authUserId=x    -> 401 {"error":"unauthorized"}
GET https://alcore.io.vn/admin/ide/definitely-not-here-xyz -> 401 {"error":"unauthorized"} (control: 401 proves gating, not existence)
GET https://auth.alcore.io.vn/auth/me                    -> 401 {"error":"unauthorized"}
```

Reading: the gate, the old shape, the fail-closed unconfigured quota,
strict input validation, and the end-to-end profile binding all hold on
the real stack. The live chain answers (auth-gated) where the brief
said it would, with the existence caveat above.

## Screenshots (real)

- `task-36-shot-locked.png` — real product UI, signed-out: the
  SessionAuthGate ("Sign in to OpenChamber / Continue with your Alcore
  account"), captured headless-Edge via CDP from the composition above.
- `task-36-shot-panel.png` — real product UI, signed-in: header trigger
  with initial avatar + "Ada Lovelace"; open dropdown with "Ada
  Lovelace", "ada@example.test", "Quota unavailable" chip, sign-out.
  The name/email arrived through the REAL login→status binding (same
  body path the desktop completion uses); the quota chip is the REAL
  unconfigured-server state (no management key on this machine).

Composition disclosures (no fake payloads anywhere): every byte came
from real product code and the prebuilt `dist/` bundle. Two
composition-only measures were needed and are stated so the shots are
read correctly: (1) the full product server could not boot (fixed port
held, see above), so the API surface is the real-module composition;
(2) the app's boot overlay (`div.fixed.inset-0.z-[9999]`) never clears
on the scratch surface (it lacks boot endpoints like the session list —
hence the genuine "Could not refresh sessions" notice in the shot), so
it was hidden to expose the already-rendered panel beneath. No stub
served any payload; the verdict on live quota/avatars stays partial
(see DoneClaim).

## Adversarial probes

| Probe | Input | Output (verbatim) | Verdict |
|---|---|---|---|
| malformed input (quota route) | missing / empty / 129-char / array `authUserId` | `400 {"error":"invalid_request"}` ×4, zero upstream calls (unit + live-stack) | rejected before auth/key use |
| malformed input (exchange profile) | over-long name, `http://` picture, unknown keys | login 200s, session binds `{email}` only | field-wise drop, never forged |
| hostile input (client-asserted profile) | `profile: {name:'Mallory',...}` in `google-complete` poll body | session binds service email only | server-held capture wins |
| malformed input (login bodies) | `{}/{requestId:'short'}` etc. | `400`, zero sessions, zero service calls | existing guards hold |
| tampered/unknown OAuth state | `state=b*32` on loopback callback | `410` named page `callback · invalid_state` | fail closed, named |
| stale_state (SHAs recorded) | `git rev-parse HEAD` pre-edit | `06537da1e13c930d099f396bd89fe44da51b008d` | pins reproducible |
| dirty_worktree (only intended files) | `git status --porcelain=v1` post-work | `M desktop-auth.{js,test.js,DOCUMENTATION.md}`, `M feature-routes-runtime.js`, `M ui-auth.{js,test.js,DOCUMENTATION.md}`, `?? lib/tokenpanel/`, `?? .omo/evidence/task-36-*` | no drift |
| hung_commands (bounded) | every run single-shot `bun test` / curl -m / CDP polls with caps | longest suite < 2 s; live probes ≤ 15 s budgets | no hangs; scratch server + Edge killed, temp dir removed (see receipt) |
| key hygiene | grep of responses/logs for the mgmt key shape | key only in `Authorization` header server→upstream; never in URLs, bodies, or logs | holds (unit-asserted) |

## Validation summary (honest)

- New/affected suites: tokenpanel 8/8, desktop-auth 34/34 (29 prior +
  5 new), ui-auth 21/21 (15 prior + 6 new) — **63 pass / 0 fail**
  (630+122+41 expects across the runs).
- Neighbors: UI `accountQuota` + `accountSession` 20/20; `core-routes`
  33/34 — the 1 failure is PRE-EXISTING on the clean base
  (`vi.setSystemTime is not a function`, bun-vs-vitest shim gap in a
  pairing rate-limit test; verified via `git stash`, untouched by this
  todo).
- `bunx oxlint` on every created/edited JS file: zero NEW findings
  (each file diffed against its `git stash` baseline; remaining hits
  are the known backlog).
- `bun run dead-code`: inspected; the new module's exports are all
  test-referenced (no new entries); the flagged UI account types are
  pre-existing.
- Full suites NOT run (todo 16 owns full-suite-green; AGENTS.md
  prescribes narrowest validation for this scope).
- No UI type-check impact (zero UI files changed); server is JS.
- Runtime proof: live-stack QA + screenshots above; unit fixtures
  match the documented service shapes (auth-service
  `googleCompletionProfile`, hook quota contract).

## STOP condition

Real data renders with proof. Met in part — see DoneClaim.

## DoneClaim (explicit real-vs-fixture verdict): PARTIAL

- REAL (proven on the live local chain, not fixtures): `GET
  /api/tokenpanel/quota` exists, sits behind the real session gate
  (401), validates strictly (400s), and fails closed unconfigured
  (503 → panel "Quota unavailable"); `GET /auth/session` carries
  `alcore.{sub,name,email,picture}` bound at real login issuance for
  cookie AND desktop-client sessions, old shape preserved otherwise;
  the desktop completion captures the service's exchange profile and
  the account email end to end (unit + live-stack). Screenshots show
  the real UI rendering the real bound name/email and the real
  unavailable-quota state.
- FIXTURE (unit-level only, disclosed): exchange/upstream bodies in
  tests are stubs matching the documented service shapes (the repo's
  blessed fixture pattern); the live TokenPanel quota body and a live
  Google avatar were NOT observed — no management key and no OAuth
  credential exist on this machine, and none were provisioned (out of
  scope: no signing/provisioning).
- NOT demonstrated: a fresh Google login showing avatar + LIVE quota +
  tier. What stands in its way is credentials, not code: (1) Google
  OAuth interaction, (2) a `TOKENPANEL_MGMT_KEY` for the proxy, (3) a
  customer-tier read that does not exist in the IDE server (tier stays
  blank by design, never fabricated). With (1)+(2), the shipped path
  completes without further code changes; (3) needs a follow-up todo.

## Cleanup receipt

- Scratch API server (PID 32776, `C:/Users/dangq/AppData/Local/Temp/ide-qa-scratch/qa-server.mjs`): killed.
- Headless Edge CDP instance (remote-debugging port 9333, fresh temp
  profile): killed.
- Scratch dir `ide-qa-scratch/` (server file, logs, temp data dir,
  edge profile, intermediate PNGs): removed after staging the two
  evidence shots.
- First QA server attempt (PID 25652): already exited on its own
  (EADDRINUSE on the fixed callback port — evidence for the port
  conflict, not a leak).
- Foreign Electron desktop app (PID 32420, holds 57123): never touched.
- `git status --porcelain=v1` at close: only the intended files above.

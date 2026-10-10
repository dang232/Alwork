# Task 51 — Personal API key provisioning for IDE login (IDE side)

Branch: `ui-personal-key` (new, off `ui-alcore-signin` at `7e11759`).
Repo: `I:/migration/Alwork-wt/wave1`. Only own files touched
(pre-existing untracked `.omo` evidence left alone).

## Shared contract (both repos)

- `POST /admin/ide/personal-key` (user Bearer) → `201 { keyId, key, prefix, name }`.
  Full secret exactly once; never logged, never stored plaintext.
- `DELETE /admin/ide/personal-key` (user Bearer, optional `{ keyId }`) →
  `200 { ok: true, revoked: [...] }`.
- Fail-closed identity: 0 → 404, multi → 403, inactive → 403, bad credential → 401.
- One live key per user (server rotates-with-revoke-old on every mint).

## What changed here

- NEW `packages/web/server/lib/alcore-provider/personal-key.js` —
  `createPersonalKeyRuntime({ serviceBase, serviceFetch, userTokenStore,
  keyIdStore, env })` with `mintPersonalKey(sub)` / `revokePersonalKey(sub,
  keyId?)` / `readKeyId(sub)`, plus `createFileKeyIdStore` (restart-safe
  `{ sub: { keyId, updatedAt } }` JSON, mode 0o600; secret never on disk)
  and `memoryKeyIdStore` (test seam). Same TokenPanel origin as the quota
  proxy/catalog sync; caller Bearer only; one auth-service refresh + retry
  on 401; mint/revoke never mutate the token store (a provisioning failure
  can never break the login or sign the user out).
- `alcore-provider.js` — login mints via `personalKeys` AFTER the provider
  block write; ambient `ALCORE_USER_TOKEN` + OpenCode credential =
  minted key (login-token storage removed). Mint failure → block written,
  no secret stored, stale ambient dropped → card reads "Not signed in",
  login stands. Sign-out revokes the recorded id FIRST (else revoke-all),
  then the existing removal (ambient, OpenCode creds, pair, config entry).
  Enterprise check stays first: no mint while the mode is on; removal
  (incl. revoke) always runs.
- `bootstrap-runtime.js` — builds the runtime (shared keychain +
  `<dataDir>/alcore-personal-keys.json`) and passes it in.
- `alcore-provider/DOCUMENTATION.md` — new file, new flow truth, new options.
- Surfaces: web + Electron desktop share the server path (mint on login,
  revoke on `/api/auth/reset`); VS Code runs no such server (unchanged);
  hosted/Capacitor mobile inherit wherever this server runs.
- Enterprise class: provider entry (existing gate, unchanged admin contract —
  no new crossing: same TokenPanel origin as catalog/quota, no conversation
  content, no listeners).

## Tests

- NEW `personal-key.test.js` — 24 tests (mint/revoke/refresh/401/404/
  transient/malformed/no-pair/secret-never-logged/key-id file round-trip +
  corruption tolerance).
- `alcore-provider.test.js` — updated to the personal-key contract + 8 new
  flow tests (mint-failure Not-signed-in, unwired block-only, relogin
  re-mint, no-pair-no-key, revoke-by-id, revoke-all fallback, refused-revoke
  still resolves, enterprise sign-out still revokes).

## Gates (all green, this worktree)

- `bunx vitest run server/lib/alcore-provider server/lib/desktop-auth server/lib/user-tokens server/lib/tokenpanel server/lib/ui-auth server/lib/ide-gate server/lib/opencode/core-routes.test.js server/lib/opencode/startup-pipeline-runtime.test.js server/lib/opencode/feature-routes-runtime.test.js`
  — 11 files, 223 pass.
- `bunx oxlint` on all 5 changed/new JS files — clean.
- `bun run type-check` (packages/web) — ok. `bun run lint` (packages/web) — ok.
- `bun run dead-code` (root) — ok, no new flags.
- Full `packages/web` suite: 52 files fail on Windows-environment causes
  (path separators, 0o600 modes, missing `sleep`/`mkfifo`/`ssh-keygen`,
  EPERM symlinks, launchd) with ZERO import edges to the changed modules
  and zero failed files in the touched areas — pre-existing, unrelated.

## Manual-QA literal commands (run from `I:/migration/Alwork-wt/wave1`)

```bat
bunx vitest run server/lib/alcore-provider --cwd packages/web
bunx vitest run server/lib/alcore-provider server/lib/desktop-auth server/lib/user-tokens server/lib/tokenpanel server/lib/ui-auth server/lib/ide-gate server/lib/opencode/core-routes.test.js server/lib/opencode/startup-pipeline-runtime.test.js server/lib/opencode/feature-routes-runtime.test.js --cwd packages/web
bunx oxlint server/lib/alcore-provider/personal-key.js server/lib/alcore-provider/personal-key.test.js server/lib/alcore-provider/alcore-provider.js server/lib/alcore-provider/alcore-provider.test.js server/lib/opencode/bootstrap-runtime.js --cwd packages/web
bun run type-check --cwd packages/web
git diff --stat
```

Live end-to-end proof lives on the TokenPanel side
(`live: minted key completes billed-once, revoke kills it` — real Hono app
+ real runtime + real Mongo, locally-minted JWTs).

## File diffs

```text
packages/web/server/lib/alcore-provider/personal-key.js       | NEW (runtime + stores)
packages/web/server/lib/alcore-provider/personal-key.test.js  | NEW (24 tests)
packages/web/server/lib/alcore-provider/alcore-provider.js   | +credential switch
packages/web/server/lib/alcore-provider/alcore-provider.test.js | +contract + flows
packages/web/server/lib/alcore-provider/DOCUMENTATION.md      | +new truth
packages/web/server/lib/opencode/bootstrap-runtime.js         | +wiring
```

No push. Restart-safe: key id on disk, secret in keychain/memory only.

# Alcore Provider Sync Documentation

## Purpose

Owns the `alcore` OpenCode provider entry behind the Settings > Providers
card that appears after an Alcore login. On login it registers the
provider with the platform's live model catalog; on global sign-out it
removes the entry and clears every credential it created.

## Files

- `packages/web/server/lib/alcore-provider/alcore-provider.js`: the
  runtime (`createAlcoreProviderRuntime`), plus the `resolveAlcoreBase`
  and `buildAlcoreProviderConfig` seams and `AlcoreProviderError`.
- `packages/web/server/lib/alcore-provider/personal-key.js`: the
  personal-key provisioning client (`createPersonalKeyRuntime`), the
  restart-safe key-id refs (`createFileKeyIdStore`, `memoryKeyIdStore`),
  `resolvePersonalKeyBase`, `PERSONAL_KEY_MINT_PATH`, and
  `PersonalKeyError`.
- `packages/web/server/lib/alcore-provider/alcore-provider.test.js`:
  serviceFetch-stub tests (no servers, no live platform).
- `packages/web/server/lib/alcore-provider/personal-key.test.js`:
  mint/revoke/key-id unit tests (stub fetch, memory + temp-file stores).
- Wiring: `desktop-auth` calls the injected `onLoginTokens(subject)`
  after each loopback completion; `core-routes` builds the runtime in
  `bootstrap-runtime` and passes it as `alcoreProvider` (login hook +
  `POST /api/auth/reset` teardown). `ui-auth` issuance is untouched.

## Badge contract (task 48 — read, never guessed)

`getProviderCardStatus` in
`packages/ui/src/components/sections/providers/providerAuth.ts` is the only
badge authority. It returns `signInNeeded` ("Not signed in") when the
`alcore` integration exists with zero credential/env connections, and
`connected` once exactly one `type: 'credential'` connection exists. The
integration list (`GET /api/integration`) and OpenCode's credential store
(`GET /api/credential`, owned by OpenCode since 2.0.20) decide — there is
no `auth.json` anymore. A custom provider registers its key method only
once its block is in config, so the key follows the config write with the
same not-found retry the Settings form uses
(`storeKeyAfterConfigWrite` in `custom-provider-form.ts`).

## Flows

Login sync (`syncOnLogin`, fire-and-forget, never rejects): skips in
enterprise mode (before any network or mint call, so no key is ever
minted while the mode is on); reads the caller's keychained pair; fetches
`GET {base}/v1/models` with the caller's Bearer (one auth-service
refresh and retry on a 401); sanitizes the OpenAI-shaped answer through
the shared discovery normalizer; writes the provider block into the
OpenCode **user** config via `upsertProviderConfig` (the same registry
the Settings form uses); mints ONE personal API key for the caller's own
link (`POST {origin}/admin/ide/personal-key` with the caller's Bearer via
`personal-key.js`); holds the MINTED key in process memory as
`ALCORE_USER_TOKEN` for the `env` credential the block references; then
stores that SAME minted key as the OpenCode `alcore` integration
credential (`POST /api/integration/alcore/connect/key` — the exact path
the Settings API-key save uses), sweeping stale entries first so one
login never accumulates accounts. The credential is a real customer API
key, never the rotating login token: login-token rotation/expiry cannot
touch it. An empty or malformed catalog skips the write — never an empty
model list. A refused or unreachable mint still keeps the block write but
stores no secret, so the card reads "Not signed in" while the proven
login stands (and any stale ambient value is dropped) — and every failure
(including a credential-sync failure) resolves `{ ok: false, reason }` or
keeps the `{ ok: true }` block write while the proven login stands. The
minted key id persists per subject in `alcore-personal-keys.json` (row
reference only, never the secret) so a restart still knows which row to
revoke. No interactive
per-provider OAuth dance is involved: `alcore` is a key-method custom
provider, so the credential is fully provisionable server-side.

Sign-out teardown (`clearOnSignOut`, never rejects): revokes the minted
personal key id FIRST (the caller's Bearer is still keychained at that
point; without a recorded id the server revokes every active personal row
for the caller), then deletes the ambient
`ALCORE_USER_TOKEN`, removes every OpenCode `alcore` credential (no
orphans), clears the keychain pair, and removes the user config entry.
Runs even in enterprise mode (removal only narrows access) and even for
an unknown subject (ambient + OpenCode credentials are still dropped).

## Caller auth (user Bearer, no service keys)

The catalog fetch presents the CALLER's own access Bearer as
`Authorization: Bearer` against the derived base. No management key is
read on this path. The config block carries no secret (only the
variable name); the value lives in process memory, never disk, logs, or
the browser. Base and pair resolve per sync, so rotation applies
without a restart.

## Public exports (alcore-provider.js)

- `createAlcoreProviderRuntime({ userTokenStore, upsertProviderConfig,
  removeProviderConfig, serviceFetch, env, isEnterprise,
  openCodeCredentials, personalKeys, credentialWait,
  credentialRetryDelaysMs })`:
  `{ resolveBase, fetchAlcoreCatalog, syncOnLogin, clearOnSignOut }`.
  Every option is injectable; production passes the shared keychain
  singleton, the real provider registry, the real `@opencode/client`
  credential calls (global client, no directory — the Settings save path),
  the personal-key runtime (shared keychain + file-backed key-id refs),
  and the default enterprise check. `openCodeCredentials` is
  `{ listCredentialIDs, connectKey, removeCredential }` or null (null keeps
  the block-only behavior). `personalKeys` is
  `{ mintPersonalKey, revokePersonalKey, readKeyId }` or null (null keeps
  the block-only behavior: no mint, no stored secret — the card reads
  "Not signed in"). `syncOnLogin`/`clearOnSignOut` never
  reject.
- `resolveAlcoreBase(explicit?, env?)`: `{origin}/v1` from the
  TokenPanel base contract (`TOKENPANEL_API_URL` override else
  `TOKENPANEL_DEFAULT_BASE`); throws `ALCORE_MISCONFIGURED` on a bad
  base. `fetchAlcoreCatalog(sub)` throws `AlcoreProviderError`
  (`ALCORE_INVALID_REQUEST` / `ALCORE_NOT_CONFIGURED` /
  `ALCORE_MISCONFIGURED` / `ALCORE_TRANSIENT` / `ALCORE_REJECTED`).

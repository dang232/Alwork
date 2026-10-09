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
- `packages/web/server/lib/alcore-provider/alcore-provider.test.js`:
  serviceFetch-stub tests (no servers, no live platform).
- Wiring: `desktop-auth` calls the injected `onLoginTokens(subject)`
  after each loopback completion; `core-routes` builds the runtime in
  `bootstrap-runtime` and passes it as `alcoreProvider` (login hook +
  `POST /api/auth/reset` teardown). `ui-auth` issuance is untouched.

## Flows

Login sync (`syncOnLogin`, fire-and-forget, never rejects): skips in
enterprise mode; reads the caller's keychained pair; fetches
`GET {base}/v1/models` with the caller's Bearer (one auth-service
refresh and retry on a 401); sanitizes the OpenAI-shaped answer through
the shared discovery normalizer; writes the provider block into the
OpenCode **user** config via `upsertProviderConfig` (the same registry
the Settings form uses); holds the Bearer in process memory as
`ALCORE_USER_TOKEN` for the `env` credential the block references. An
empty or malformed catalog skips the write — never an empty model list —
and every failure resolves `{ ok: false, reason }` while the proven
login stands.

Sign-out teardown (`clearOnSignOut`, never rejects): deletes the ambient
`ALCORE_USER_TOKEN`, clears the keychain pair, and removes the user
config entry. Runs even in enterprise mode (removal only narrows
access) and even for an unknown subject (the ambient credential is
still dropped).

## Caller auth (user Bearer, no service keys)

The catalog fetch presents the CALLER's own access Bearer as
`Authorization: Bearer` against the derived base. No management key is
read on this path. The config block carries no secret (only the
variable name); the value lives in process memory, never disk, logs, or
the browser. Base and pair resolve per sync, so rotation applies
without a restart.

## Public exports (alcore-provider.js)

- `createAlcoreProviderRuntime({ userTokenStore, upsertProviderConfig,
  removeProviderConfig, serviceFetch, env, isEnterprise })`:
  `{ resolveBase, fetchAlcoreCatalog, syncOnLogin, clearOnSignOut }`.
  Every option is injectable; production passes the shared keychain
  singleton, the real provider registry, and the default enterprise
  check. `syncOnLogin`/`clearOnSignOut` never reject.
- `resolveAlcoreBase(explicit?, env?)`: `{origin}/v1` from the
  TokenPanel base contract (`TOKENPANEL_API_URL` override else
  `TOKENPANEL_DEFAULT_BASE`); throws `ALCORE_MISCONFIGURED` on a bad
  base. `fetchAlcoreCatalog(sub)` throws `AlcoreProviderError`
  (`ALCORE_INVALID_REQUEST` / `ALCORE_NOT_CONFIGURED` /
  `ALCORE_MISCONFIGURED` / `ALCORE_TRANSIENT` / `ALCORE_REJECTED`).

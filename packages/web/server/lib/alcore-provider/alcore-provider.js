// Alcore model provider sync (project-ide tasks 42, 48).
//
// What this owns: the `alcore` OpenCode provider entry that appears in
// Settings > Providers after an Alcore login, plus the OpenCode
// credential that flips its card from "Not signed in" to "Connected".
// On login it reads the CALLER's own keychained pair (see
// `packages/web/server/lib/user-tokens/user-token-store.js`), fetches the
// live model catalog from the platform with that Bearer, writes the
// provider block into the OpenCode user config through the same
// `upsertProviderConfig` registry the Settings form uses — no parallel
// provider system — then mints ONE personal API key for the caller's own
// link (`POST /admin/ide/personal-key`, see `./personal-key.js`) and stores
// that key as the integration credential
// (`POST /api/integration/alcore/connect/key`, the exact path
// the Settings custom-provider form uses after its config write). The
// credential is a real customer API key, never the rotating login token:
// login-token rotation/expiry cannot touch it, and a restart keeps it
// working (the secret lives in the OpenCode credential store, the row
// reference in `alcore-personal-keys.json`). When the mint fails the block
// is still written but no credential is stored, so the card reads
// "Not signed in" while the proven login stands. On global sign-out it
// revokes the minted key id, removes the OpenCode credential(s), the config
// entry, clears the pair, and drops the ambient credential, so nothing is
// orphaned.
//
// Badge contract (OpenCode-chat state, read — never guessed):
// `packages/ui/src/components/sections/providers/providerAuth.ts`
// `getProviderCardStatus` returns `signInNeeded` ("Not signed in") when
// the `alcore` integration exists with zero credential/env connections,
// and `connected` once exactly one `type: 'credential'` connection exists
// (or an inline `options.apiKey`). The integration list (`GET
// /api/integration`) and the credential store (`GET /api/credential`,
// owned by OpenCode since 2.0.20) are the only authority — there is no
// `auth.json` anymore. A custom provider registers its key method only
// once its block is in config, so the key follows the config write with
// the same not-found retry the Settings form uses.
//
// Base URL contract: derived from the TokenPanel base of record
// (`TOKENPANEL_DEFAULT_BASE`, honoring `TOKENPANEL_API_URL` exactly like
// the quota proxy) plus `/v1`. No second hardcoded Alcore URL lives here:
// the platform's OpenAI-compatible surface (`GET {base}/v1/models`,
// chat at `{base}/...`) is addressed through that one derived base.
// Model discovery reuses `discoverProviderModels` (OpenAI `{data:[...]}`
// shape, bounded body, no redirects), so catalog parsing never drifts
// from the Settings discovery flow.
//
// Caller auth: the catalog fetch presents the caller's own access Bearer
// (`Authorization: Bearer`, never a service/management key, never in a
// URL). A 401 refreshes ONCE through the store's auth-service rotation
// and retries; anything still failing skips the registration and leaves
// the login standing — a catalog outage must never break a proven login
// nor masquerade as an empty model list. The config block itself carries
// NO secret: auth travels via `env: [ALCORE_USER_TOKEN]`, whose value the
// server holds in process memory only (the MINTED personal key after a
// successful sync, deleted on sign-out or when the mint fails so no stale
// login Bearer can linger). Nothing here logs tokens, subs, or responses.
//
// Enterprise boundary (provider-entry class): registration is refused
// while enterprise mode is on — providers come from the administrator's
// OpenCode config there. Removal always runs: it only narrows access.
// Surfaces (ui-api-decoupling): web and Electron desktop share these
// server paths (desktop-login sync, reset cleanup); VS Code runs no such
// server (no Alcore card there); hosted/Capacitor mobile inherit the
// shared-UI behavior wherever this server runs.
import { z } from 'zod';

import { TOKENPANEL_DEFAULT_BASE } from '../tokenpanel/tokenpanel-quota.js';
import { discoverProviderModels } from '../opencode/model-discovery.js';
import { isEnterpriseMode } from '../enterprise-mode.js';

export const ALCORE_PROVIDER_ID = 'alcore';
export const ALCORE_PROVIDER_NAME = 'Alcore';
// Same spelling the Settings custom-provider form writes for OpenAI-chat
// endpoints; the server normalizes it to the `aisdk:` provider package.
export const ALCORE_PROVIDER_PACKAGE = 'aisdk:@ai-sdk/openai-compatible';
// Ambient credential name the provider block references. The VALUE lives
// in process memory only (never config, never disk, never logs).
export const ALCORE_ENV_CREDENTIAL = 'ALCORE_USER_TOKEN';
const ALCORE_CATALOG_TIMEOUT_MS = 15_000;
// Same retry the Settings custom-provider form uses after its config write
// (`storeKeyAfterConfigWrite`): OpenCode picks the block up from its file
// watcher, and until then it rejects the key with "Integration not found".
// Only that rejection is retried, briefly — anything else fails fast so a
// credential outage never holds a proven login hostage.
const ALCORE_CREDENTIAL_RETRY_DELAYS_MS = [250, 500, 1000, 2000];
// Mirrors the model-capability vocabulary the provider registry validates.
const ALCORE_KNOWN_CAPABILITIES = new Set(['text', 'image', 'audio', 'video', 'pdf']);

export class AlcoreProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AlcoreProviderError';
    this.code = code;
  }
}

const subSchema = z.string().trim().min(1).max(128);

// Same override semantics as the quota proxy: an explicit base wins, else
// `TOKENPANEL_API_URL`, else the base of record. The OpenAI-compatible
// surface hangs under `/v1`.
const readConfiguredApiBase = (explicit, env) => {
  const direct = z.string().min(1).optional().safeParse(explicit).data?.trim().replace(/\/+$/, '');
  if (direct) return direct;
  const fromEnv = z.string().optional().safeParse(env?.TOKENPANEL_API_URL).data?.trim().replace(/\/+$/, '');
  return fromEnv && fromEnv !== '' ? fromEnv : TOKENPANEL_DEFAULT_BASE;
};

export const resolveAlcoreBase = (explicit, env = process.env) => {
  const raw = readConfiguredApiBase(explicit, env);
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('bad protocol');
    return `${parsed.origin}/v1`;
  } catch {
    throw new AlcoreProviderError('ALCORE_MISCONFIGURED', 'Alcore base URL is misconfigured.');
  }
};

const isAuthRefusal = (error) => error?.statusCode === 401 || error?.code === 'provider_auth';

// Transient is narrow: raw transport failures and upstream 5xx
// (`provider_error`). A malformed/oversized/redirected answer is
// hard-invalid (REJECTED) — it must never read as a retryable outage.
const isTransientFailure = (error) => {
  if (error?.code === 'provider_error') return true;
  // Raw transport failures (DNS, reset, timeout) carry no status at all.
  if (error instanceof TypeError) return true;
  return error?.name === 'AbortError' || error?.name === 'TimeoutError';
};

// Catalog entries are parsed at this boundary: anything discovery hands
// over that is not a usable model is skipped, never carried as unknown
// shapes into the provider config.
const discoveredCatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  limit: z.object({ context: z.number().optional(), output: z.number().optional() }).optional(),
  capabilities: z.object({
    input: z.array(z.string()).optional(),
    output: z.array(z.string()).optional(),
    tools: z.boolean().optional(),
  }).optional(),
}).passthrough();

const sanitizeCatalogModels = (models) => {
  const kept = [];
  const seen = new Set();
  for (const raw of models ?? []) {
    const parsed = discoveredCatalogEntrySchema.safeParse(raw);
    if (!parsed.success) continue;
    const model = parsed.data;
    const id = model.id.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const entry = { modelID: id, name: model.name?.trim() ? model.name.trim() : id };
    const limit = {};
    if (Number.isSafeInteger(model.limit?.context) && model.limit.context > 0) {
      limit.context = model.limit.context;
    }
    if (Number.isSafeInteger(model.limit?.output) && model.limit.output > 0) {
      limit.output = model.limit.output;
    }
    if (Object.keys(limit).length > 0) entry.limit = limit;
    const input = model.capabilities?.input?.filter((value) => ALCORE_KNOWN_CAPABILITIES.has(value));
    const outCap = model.capabilities?.output?.filter((value) => ALCORE_KNOWN_CAPABILITIES.has(value));
    const tools = model.capabilities?.tools;
    if (input !== undefined || outCap !== undefined || tools !== undefined) {
      entry.capabilities = {
        tools: tools ?? true,
        input: input ?? ['text'],
        output: outCap ?? ['text'],
      };
    }
    kept.push(entry);
  }
  return kept;
};

export const buildAlcoreProviderConfig = (base, models) => ({
  package: ALCORE_PROVIDER_PACKAGE,
  name: ALCORE_PROVIDER_NAME,
  env: [ALCORE_ENV_CREDENTIAL],
  settings: { baseURL: base },
  models: Object.fromEntries(models.map((model) => [model.modelID, model])),
});

export const createAlcoreProviderRuntime = ({
  userTokenStore = null,
  upsertProviderConfig = null,
  removeProviderConfig = null,
  serviceFetch = (...args) => fetch(...args),
  env = process.env,
  isEnterprise = () => isEnterpriseMode(),
  // OpenCode credential provisioning (task 48 — the badge flip, task 51 —
  // the personal key). Shape:
  // `{ listCredentialIDs: () => Promise<string[]>,
  //    connectKey: (key: string) => Promise<void>,
  //    removeCredential: (id: string) => Promise<void> }`.
  // Production wires the real `@opencode/client` calls (global client, no
  // directory — the same client the Settings API-key save uses); tests
  // inject recording fakes. Null (default) keeps the block-only behavior:
  // provider block, no OpenCode credential.
  // The key stored is ALWAYS the freshly minted personal API key for the
  // caller's own link (see `./personal-key.js`) — never the rotating login
  // Bearer, never a service or management key, never from config, never
  // logged.
  openCodeCredentials = null,
  // Personal-key provisioning (task 51): `{ mintPersonalKey,
  // revokePersonalKey, readKeyId }` from `./personal-key.js` (production:
  // `createPersonalKeyRuntime`; tests: a recording fake). Null (default)
  // keeps the block-only behavior: the provider block is still written,
  // but no key is minted and no credential is stored.
  personalKeys = null,
  // Wait between key-method retries (injectable so tests never sleep).
  credentialWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  credentialRetryDelaysMs = ALCORE_CREDENTIAL_RETRY_DELAYS_MS,
} = {}) => {
  const readStoredAccess = async (sub) => {
    if (userTokenStore === null || userTokenStore === undefined) return '';
    try {
      const pair = await userTokenStore.readPair(sub);
      const access = z.object({ accessToken: z.string() }).safeParse(pair).data?.accessToken ?? '';
      return access.trim();
    } catch {
      return '';
    }
  };

  const readLiveCatalog = async (base, accessToken) => discoverProviderModels(
    { baseURL: base, modelsPath: '/models', apiKey: accessToken, enrich: false },
    { fetch: serviceFetch, timeoutMs: ALCORE_CATALOG_TIMEOUT_MS },
  );

  // Live catalog with the caller's Bearer, refreshed once on a 401. Never
  // throws raw platform shapes: every failure is an AlcoreProviderError.
  // Never clears the pair here — at login time a catalog refusal must not
  // nuke credentials the quota path may still use.
  const fetchAlcoreCatalog = async (sub) => {
    const id = subSchema.safeParse(sub).data;
    if (id === undefined) {
      throw new AlcoreProviderError('ALCORE_INVALID_REQUEST', 'Invalid Alcore subject.');
    }
    const base = resolveAlcoreBase(undefined, env);
    let access = await readStoredAccess(id);
    if (access === '') {
      throw new AlcoreProviderError('ALCORE_NOT_CONFIGURED', 'No Alcore user token is stored for this session.');
    }
    try {
      try {
        return { base, access, models: sanitizeCatalogModels((await readLiveCatalog(base, access)).models) };
      } catch (refused) {
        if (!isAuthRefusal(refused)) throw refused;
        let fresh = '';
        try {
          fresh = await userTokenStore.refreshAccessToken(id);
        } catch (refreshError) {
          if (refreshError?.code === 'USER_TOKEN_REFRESH_TRANSIENT') {
            throw new AlcoreProviderError('ALCORE_TRANSIENT', 'Alcore catalog is unavailable.');
          }
          throw new AlcoreProviderError('ALCORE_REJECTED', 'Alcore refused the caller token.');
        }
        access = String(fresh ?? '').trim();
        if (access === '') {
          throw new AlcoreProviderError('ALCORE_REJECTED', 'Alcore refused the caller token.');
        }
        return { base, access, models: sanitizeCatalogModels((await readLiveCatalog(base, access)).models) };
      }
    } catch (error) {
      if (error instanceof AlcoreProviderError) throw error;
      if (isTransientFailure(error)) {
        throw new AlcoreProviderError('ALCORE_TRANSIENT', 'Alcore catalog is unavailable.');
      }
      throw new AlcoreProviderError('ALCORE_REJECTED', 'Alcore answered an unusable catalog.');
    }
  };

  // Mint the provider credential: one personal API key for the caller's
  // own link (see `./personal-key.js`). Resolves `{ key }` on success or
  // `{ reason }` when no key is available (unwired mint runtime, refused or
  // unreachable mint, malformed answer) — the caller degrades to the
  // block-only "Not signed in" card, never a broken login.
  const mintProviderCredential = async (sub) => {
    if (personalKeys === null || personalKeys === undefined) {
      return { key: null, reason: 'not_wired' };
    }
    try {
      const minted = await personalKeys.mintPersonalKey(sub);
      const key = z.string().min(1).safeParse(minted?.key).data ?? '';
      if (key === '') return { key: null, reason: 'personal_key_unavailable' };
      return { key, reason: null };
    } catch (error) {
      return { key: null, reason: error?.code ?? 'personal_key_unavailable' };
    }
  };
  // OpenCode still reports a custom provider as "Not signed in" until its
  // integration holds a credential connection: the config block alone lists
  // models but leaves `connections` empty. Stale credentials (an expired
  // rotating JWT from a previous login) are removed first so one login never
  // accumulates "Accounts" — a single fresh credential reads as Connected.
  // Best-effort only: any failure warns (never the key) and the provider
  // block already written above keeps serving models.
  const provisionOpenCodeCredential = async (access) => {
    if (openCodeCredentials === null || openCodeCredentials === undefined) return;
    const key = String(access ?? '').trim();
    if (key === '') return;
    try {
      let stale = [];
      try {
        stale = (await openCodeCredentials.listCredentialIDs()) ?? [];
      } catch {
        stale = [];
      }
      for (const credentialId of stale) {
        try {
          await openCodeCredentials.removeCredential(credentialId);
        } catch {
          // Best-effort: the fresh key below still flips the badge even
          // when a stale entry lingers (it reads as an extra account).
        }
      }
      const delays = Array.isArray(credentialRetryDelaysMs) ? credentialRetryDelaysMs : ALCORE_CREDENTIAL_RETRY_DELAYS_MS;
      for (let attempt = 0; ; attempt += 1) {
        try {
          await openCodeCredentials.connectKey(key);
          return;
        } catch (error) {
          const delay = delays[attempt];
          const notRegisteredYet = error instanceof Error && /not found/i.test(error.message);
          if (!notRegisteredYet || delay === undefined) throw error;
          await credentialWait(delay);
        }
      }
    } catch (error) {
      console.warn(`[alcore-provider] credential sync skipped (${error?.code ?? 'unavailable'})`);
    }
  };

  // Removes every `alcore` credential OpenCode holds. Best-effort: never
  // throws, never logs ids or keys. Runs even in enterprise mode and even
  // for an unknown subject — the credential is global, and removal only
  // narrows access, so an orphan must never survive a sign-out.
  const removeOpenCodeCredentials = async () => {
    if (openCodeCredentials === null || openCodeCredentials === undefined) return;
    try {
      let ids = [];
      try {
        ids = (await openCodeCredentials.listCredentialIDs()) ?? [];
      } catch {
        ids = [];
      }
      for (const credentialId of ids) {
        try {
          await openCodeCredentials.removeCredential(credentialId);
        } catch {
          // Best-effort: sign-out already rotated the session secret and
          // dropped the ambient credential; a lingering OpenCode entry is
          // narrowed on the next login's stale-sweep anyway.
        }
      }
    } catch {
      // Best-effort: never fail a sign-out that already succeeded.
    }
  };

  // Best-effort registration after a proven login. Resolves `{ ok: true,
  // models }` or `{ ok: false, reason }` and NEVER rejects: a catalog
  // outage, a refused token, enterprise mode, a config-write failure, a
  // refused/unreachable personal-key mint, or a credential-sync failure
  // must not break the login that just succeeded. The credential stored is
  // the freshly minted personal API key for the caller's own link (see
  // `./personal-key.js`) — never the rotating login Bearer, never a
  // service or management key, never in config/disk/URL/logs. When the
  // mint is unavailable the provider block is still written but no secret
  // is stored, so the card reads "Not signed in" while the rest works.
  const syncOnLogin = async (sub) => {
    try {
      let enterprise = false;
      try {
        enterprise = (await isEnterprise()) === true;
      } catch {
        enterprise = false;
      }
      if (enterprise) return { ok: false, reason: 'enterprise_mode' };
      const id = subSchema.safeParse(sub).data;
      if (id === undefined) return { ok: false, reason: 'invalid_request' };
      if (upsertProviderConfig === null || upsertProviderConfig === undefined) {
        return { ok: false, reason: 'not_wired' };
      }
      const catalog = await fetchAlcoreCatalog(id);
      if (catalog.models.length === 0) {
        console.warn('[alcore-provider] catalog answered no usable models; provider not registered');
        return { ok: false, reason: 'empty_catalog' };
      }
      upsertProviderConfig(
        ALCORE_PROVIDER_ID,
        buildAlcoreProviderConfig(catalog.base, catalog.models),
        null,
        'user',
        {},
      );
      const credential = await mintProviderCredential(id);
      if (credential.key === null) {
        // Mint failure never breaks the login: the block above is written
        // (live models listed) but no secret is stored, so the card reads
        // "Not signed in". Any stale ambient value is dropped so an old
        // login Bearer can never linger past its rotation.
        try {
          delete env[ALCORE_ENV_CREDENTIAL];
        } catch {
          // Best-effort: the card state above is what matters.
        }
        return { ok: false, reason: credential.reason };
      }
      try {
        env[ALCORE_ENV_CREDENTIAL] = credential.key;
      } catch {
        // A frozen env object must not fail the sync: the config entry is
        // written and the card lists live models either way.
      }
      await provisionOpenCodeCredential(credential.key);
      return { ok: true, models: catalog.models.length };
    } catch (error) {
      console.warn(`[alcore-provider] login sync skipped (${error?.code ?? 'unavailable'})`);
      return { ok: false, reason: error?.code ?? 'unavailable' };
    }
  };

  // Best-effort teardown on global sign-out. Revokes the minted personal
  // key id FIRST (the caller's Bearer is still keychained here — clearPair
  // runs below — and the revoke is what turns a sign-out into a dead
  // provider key), then drops the ambient credential and every OpenCode
  // `alcore` credential; the pair and the config entry follow when present.
  // NEVER rejects. Removal runs even in enterprise mode and even for an
  // unknown subject: it only narrows access. A refused or unreachable
  // revoke still proceeds to the local removal, and the next login's
  // rotate-with-revoke-old cleans up any surviving row regardless.
  const clearOnSignOut = async (sub) => {
    const outcome = { cleared: false, removed: false };
    const id = subSchema.safeParse(sub).data;
    if (id !== undefined && personalKeys !== null && personalKeys !== undefined) {
      try {
        let storedId = null;
        try {
          storedId = await personalKeys.readKeyId(id);
        } catch {
          storedId = null;
        }
        // A recorded id revokes exactly that row; without one the server
        // revokes every active personal row for the caller — either way no
        // personal key survives the sign-out.
        await personalKeys.revokePersonalKey(id, storedId ?? undefined);
      } catch {
        // Best-effort: sign-out already rotated the session secret and the
        // local removal below still runs.
      }
    }
    try {
      delete env[ALCORE_ENV_CREDENTIAL];
    } catch {
      // Best-effort: the pair and config cleanup below still run.
    }
    await removeOpenCodeCredentials();
    if (id === undefined) return outcome;
    if (userTokenStore !== null && userTokenStore !== undefined) {
      try {
        await userTokenStore.clearPair(id);
        outcome.cleared = true;
      } catch {
        // Best-effort: the serving path is what matters, and sign-out
        // rotates the session secret regardless.
      }
    }
    if (removeProviderConfig !== null && removeProviderConfig !== undefined) {
      try {
        outcome.removed = (await removeProviderConfig(ALCORE_PROVIDER_ID, null, 'user')) === true;
      } catch {
        // Best-effort: a missing entry reads the same as a removed one.
        outcome.removed = false;
      }
    }
    return outcome;
  };

  return { resolveBase: (explicit) => resolveAlcoreBase(explicit, env), fetchAlcoreCatalog, syncOnLogin, clearOnSignOut };
};

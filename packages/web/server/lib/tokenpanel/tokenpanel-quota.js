// IDE TokenPanel quota proxy (project-ide tasks 36+39).
//
// The header account surface reads live quota over
// `GET /api/tokenpanel/quota?authUserId=` (see
// `packages/ui/src/components/layout/accountQuota.ts`). This module owns
// the route: it re-reads the TokenPanel quota API on every miss and
// answers the exact body shape the hook validates.
//
// Caller auth (no service keys anywhere on this path): the proxy presents
// the CALLER's own access Bearer — the keychained pair the desktop login
// captured at loopback completion (see
// `packages/web/server/lib/user-tokens/user-token-store.js`) — as
// `Authorization: Bearer` against `TOKENPANEL_API_URL` (default
// `https://alcore.io.vn`). No TokenPanel management key is read here:
// management keys must never appear in user-facing flows. Self-only is
// enforced before any upstream call (`authUserId` must equal the
// session's Alcore `sub`, resolved through the injected `resolveSubject`);
// a mismatch answers 403 without touching tokens or the network. The
// token is never logged, never placed in a URL, and never sent to the
// browser. Base and pair resolve per request, so rotation applies without
// a restart; tests inject them (plus `serviceFetch`/`now`).
//
// Refresh discipline: an upstream 401 (expired access JWT) refreshes ONCE
// through the store's auth-service rotation and retries with the fresh
// token. A refused refresh, a missing refresh token, or a second 401
// clears the stored pair and answers 401 `tokenpanel_session_expired` —
// the renderer's cue to sign out to the gate. A refresh that fails
// transiently (unreachable/throttled auth-service) keeps the task-36
// stale-in-grace behavior. That 401 names the TokenPanel session, not the
// UI session (which is still valid): the shared session-expiry classifier
// confirms through GET /auth/session and does not flip on it.
//
// Read discipline mirrors the ide-gate TokenPanel fallback
// (`packages/web/server/lib/ide-gate/ide-gate.js`): live wins; a transient
// outage (network/timeout/5xx/429) serves the last-known body within one
// TTL of grace with `stale:true`; past grace (or a cold cache) fails
// closed — never a fabricated quota. A hard-invalid answer (403/404,
// malformed body, or a post-refresh 401) never serves stale. A caller
// with no stored pair answers 503 `tokenpanel_not_configured`, which the
// hook also reads as `unavailable`.
//
// Surfaces (ui-api-decoupling): registered in
// `feature-routes-runtime.js` beside the other explicit routes — behind the
// existing `/api` session gate, before the generic OpenCode proxy. Web and
// Electron desktop reach it through the same server; VS Code has no such
// server (the account surface is hidden there); hosted/Capacitor mobile
// inherit the shared-UI behavior wherever this server runs.
import { z } from 'zod';

export const TOKENPANEL_DEFAULT_BASE = 'https://alcore.io.vn';
export const TOKENPANEL_QUOTA_PATH = '/admin/ide/quota';
export const TOKENPANEL_QUOTA_CACHE_TTL_MS = 60_000;

const TOKENPANEL_SERVICE_TIMEOUT_MS = 15_000;

const quotaBalanceSchema = z.object({
  amountMicros: z.number(),
  reservedMicros: z.number(),
  availableMicros: z.number(),
  currency: z.string().min(1).max(8),
});

const quotaUsageSchema = z.object({
  totalRequests: z.number(),
  totalTokens: z.number(),
  totalCostMicros: z.number(),
  totalPriceMicros: z.number(),
  currency: z.string().min(1).max(8),
});

// The exact body the UI hook validates (accountQuota.ts): identity link,
// TokenPanel-owned usage/balance, and the live/cache/stale read markers.
const quotaBodySchema = z.object({
  authUserId: z.string().min(1).max(128),
  customerId: z.string().min(1).max(64),
  balance: quotaBalanceSchema,
  usage: quotaUsageSchema,
  source: z.union([z.literal('live'), z.literal('cache')]),
  stale: z.boolean(),
});

const authUserIdSchema = z.string().min(1).max(128);

export class TokenpanelQuotaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TokenpanelQuotaError';
    this.code = code;
  }
}

const readEnvBase = () => {
  const raw = (process.env.TOKENPANEL_API_URL ?? '').trim().replace(/\/+$/, '');
  return raw === '' ? TOKENPANEL_DEFAULT_BASE : raw;
};

export const createTokenpanelQuotaRuntime = ({
  serviceBase,
  serviceFetch = (...args) => fetch(...args),
  now = () => Date.now(),
  cacheTtlMs = TOKENPANEL_QUOTA_CACHE_TTL_MS,
  // Shared keychain store (production wiring passes the singleton; tests
  // inject a memory fake). Null reads as "no stored pairs".
  userTokenStore = null,
  // Resolves the caller's own Alcore sub for the self-only check
  // (production: uiAuthController.resolveRequestAlcoreSub). A throwing or
  // non-string answer reads as unknown identity and fails closed.
  resolveSubject = async () => '',
} = {}) => {
  const cache = new Map();

  const optionalText = z.string().optional();

  const resolveBase = () => {
    const direct = (optionalText.safeParse(serviceBase).data ?? '').trim().replace(/\/+$/, '');
    return direct === '' ? readEnvBase() : direct;
  };

  const sweepCache = (at) => {
    for (const [id, entry] of cache) {
      if (!entry || entry.fetchedAt + 2 * cacheTtlMs <= at) cache.delete(id);
    }
    while (cache.size > 500) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  };

  const readStoredAccess = async (authUserId) => {
    if (userTokenStore === null || userTokenStore === undefined) return '';
    try {
      const pair = await userTokenStore.readPair(authUserId);
      return z.object({ accessToken: z.string() }).safeParse(pair).data?.accessToken ?? '';
    } catch {
      return '';
    }
  };

  const clearStoredPair = async (authUserId) => {
    if (userTokenStore === null || userTokenStore === undefined) return;
    try {
      await userTokenStore.clearPair(authUserId);
    } catch {
      // Best-effort: the session-expired answer below is what matters.
    }
  };

  // One live read with the caller's Bearer. 401 is reported as
  // TOKENPANEL_UNAUTHORIZED (an internal trigger for the single refresh,
  // never a direct answer); every other hard-invalid shape is REJECTED.
  const readLiveQuota = async (base, authUserId, accessToken) => {
    const response = await serviceFetch(
      `${base}${TOKENPANEL_QUOTA_PATH}?authUserId=${encodeURIComponent(authUserId)}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(TOKENPANEL_SERVICE_TIMEOUT_MS),
      },
    );
    if (response.status === 401) {
      throw new TokenpanelQuotaError('TOKENPANEL_UNAUTHORIZED', 'TokenPanel refused the caller token.');
    }
    if (response.status === 429 || response.status >= 500) {
      throw new TokenpanelQuotaError('TOKENPANEL_TRANSIENT', `TokenPanel answered ${response.status}.`);
    }
    if (response.status !== 200) {
      throw new TokenpanelQuotaError('TOKENPANEL_REJECTED', `TokenPanel refused the quota read (${response.status}).`);
    }
    const raw = await response.json().catch(() => null);
    const bodyParsed = quotaBodySchema.safeParse(raw);
    if (!bodyParsed.success) {
      throw new TokenpanelQuotaError('TOKENPANEL_REJECTED', 'TokenPanel answered a malformed quota body.');
    }
    return { ...bodyParsed.data, source: 'live', stale: false };
  };

  // Single refresh-and-retry after an upstream 401. Resolves the fresh
  // live body, or throws TOKENPANEL_TRANSIENT (auth-service unreachable:
  // callers may serve stale cache) or TOKENPANEL_SESSION_EXPIRED (the
  // session is dead: the pair is cleared and the renderer signs out).
  const refreshAndRetry = async (base, authUserId) => {
    if (userTokenStore === null || userTokenStore === undefined) {
      throw new TokenpanelQuotaError('TOKENPANEL_SESSION_EXPIRED', 'TokenPanel session has expired.');
    }
    let fresh = '';
    try {
      fresh = await userTokenStore.refreshAccessToken(authUserId);
    } catch (error) {
      if (error?.code === 'USER_TOKEN_REFRESH_TRANSIENT') {
        throw new TokenpanelQuotaError('TOKENPANEL_TRANSIENT', 'TokenPanel quota is unavailable.');
      }
      await clearStoredPair(authUserId);
      throw new TokenpanelQuotaError('TOKENPANEL_SESSION_EXPIRED', 'TokenPanel session has expired.');
    }
    try {
      return await readLiveQuota(base, authUserId, fresh);
    } catch (retryError) {
      if (retryError instanceof TokenpanelQuotaError && retryError.code === 'TOKENPANEL_TRANSIENT') throw retryError;
      if (!(retryError instanceof TokenpanelQuotaError)) throw retryError;
      // The retry is network-clean: any further refusal (including a
      // second 401) means the rotated token is dead too.
      await clearStoredPair(authUserId);
      throw new TokenpanelQuotaError('TOKENPANEL_SESSION_EXPIRED', 'TokenPanel session has expired.');
    }
  };

  // Live read with the ide-gate fallback discipline. Returns
  // `{ body, stale }` with the documented quota shape, or throws
  // TokenpanelQuotaError (`TOKENPANEL_INVALID_REQUEST` /
  // `TOKENPANEL_FORBIDDEN` / `TOKENPANEL_NOT_CONFIGURED` /
  // `TOKENPANEL_TRANSIENT` / `TOKENPANEL_REJECTED` /
  // `TOKENPANEL_SESSION_EXPIRED`).
  const resolveQuotaBody = async (authUserId, subject) => {
    const idParsed = authUserIdSchema.safeParse(authUserId);
    if (!idParsed.success) {
      throw new TokenpanelQuotaError('TOKENPANEL_INVALID_REQUEST', 'Invalid authUserId.');
    }
    const id = idParsed.data;
    const caller = z.string().safeParse(subject).data ?? '';
    if (caller === '' || caller !== id) {
      throw new TokenpanelQuotaError('TOKENPANEL_FORBIDDEN', 'Quota reads are limited to the signed-in identity.');
    }
    let base;
    try {
      const parsed = new URL(resolveBase());
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('bad protocol');
      base = parsed.origin;
    } catch {
      throw new TokenpanelQuotaError('TOKENPANEL_MISCONFIGURED', 'TokenPanel base URL is misconfigured.');
    }
    const at = now();
    sweepCache(at);
    const accessToken = await readStoredAccess(id);
    if (accessToken === '') {
      throw new TokenpanelQuotaError('TOKENPANEL_NOT_CONFIGURED', 'TokenPanel quota is not configured on this server.');
    }
    let live = null;
    try {
      try {
        live = await readLiveQuota(base, id, accessToken);
      } catch (unauthorized) {
        if (!(unauthorized instanceof TokenpanelQuotaError) || unauthorized.code !== 'TOKENPANEL_UNAUTHORIZED') {
          throw unauthorized;
        }
        live = await refreshAndRetry(base, id);
      }
    } catch (error) {
      if (error instanceof TokenpanelQuotaError && error.code !== 'TOKENPANEL_TRANSIENT') throw error;
      const cached = cache.get(id);
      if (cached && at - cached.fetchedAt <= 2 * cacheTtlMs) {
        return { body: { ...cached.body, source: 'cache', stale: true }, stale: true };
      }
      throw new TokenpanelQuotaError('TOKENPANEL_TRANSIENT', 'TokenPanel quota is unavailable.');
    }
    cache.set(id, { body: live, fetchedAt: now() });
    return { body: live, stale: false };
  };

  const errorOf = (error) => {
    if (error instanceof TokenpanelQuotaError) {
      if (error.code === 'TOKENPANEL_NOT_CONFIGURED') return { status: 503, body: { error: 'tokenpanel_not_configured' } };
      if (error.code === 'TOKENPANEL_INVALID_REQUEST') return { status: 400, body: { error: 'invalid_request' } };
      if (error.code === 'TOKENPANEL_FORBIDDEN') return { status: 403, body: { error: 'tokenpanel_forbidden' } };
      if (error.code === 'TOKENPANEL_SESSION_EXPIRED') return { status: 401, body: { error: 'tokenpanel_session_expired' } };
      if (error.code === 'TOKENPANEL_REJECTED') return { status: 502, body: { error: 'tokenpanel_rejected' } };
      return { status: 503, body: { error: 'tokenpanel_unavailable' } };
    }
    return { status: 503, body: { error: 'tokenpanel_unavailable' } };
  };

  const registerRoutes = (app) => {
    app.get('/api/tokenpanel/quota', async (req, res) => {
      const candidate = authUserIdSchema.safeParse(req?.query?.authUserId);
      if (!candidate.success) {
        return res.status(400).json({ error: 'invalid_request' });
      }
      let subject = '';
      try {
        const resolved = await resolveSubject(req);
        subject = z.string().safeParse(resolved).data ?? '';
      } catch {
        subject = '';
      }
      try {
        const resolved = await resolveQuotaBody(candidate.data, subject);
        return res.json(resolved.body);
      } catch (error) {
        const mapped = errorOf(error);
        return res.status(mapped.status).json(mapped.body);
      }
    });
  };

  return { registerRoutes, resolveQuotaBody };
};

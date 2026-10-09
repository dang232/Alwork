// Desktop sign-in proxies (Cursor-style Email + Google login for the app gate).
//
// The app gate (`SessionAuthGate`) no longer takes a password: the desktop
// signs in with the Alcore account instead. These routes translate the Alcore
// auth-service flows into IDE UI sessions WITHOUT touching Repo C:
//
// - Email: the service's existing login/register/OTP endpoints are proxied.
//   On a service pair, the request is converted into the already-supported
//   `POST /auth/session {alcoreToken}` shape and delegated to
//   `uiAuthController.handleSessionCreate`, so session issuance, cookies,
//   rate limiting, and client tokens stay on the one code path that owns them.
// - Google: the system browser opens Google's OAuth authorize page directly
//   (plain redirect, never the GIS JavaScript flow whose authorized origins
//   cannot cover dynamic loopback ports). Google returns the authorization
//   code to the loopback callback served here; this server redeems it at the
//   service's existing `POST /auth/google/desktop-code` endpoint (the
//   confidential secret never leaves the service) and the app completes the
//   login by polling. The renderer never sees credentials, and no service
//   URL is hardcoded in UI code (the server derives it from the Alcore
//   issuer it already verifies against).
//
// Privacy: request bodies may carry passwords and authorization codes.
// Nothing here logs them. Service `Set-Cookie` headers are never forwarded:
// every handler answers with its own `res.status().json()`, so no upstream
// header survives.
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

import { readAlcoreIssuer, readAlcoreKeys } from '../ui-auth/ui-auth.js';

const SERVICE_TIMEOUT_MS = 15_000;
const GOOGLE_REQUEST_TTL_MS = 5 * 60 * 1000;
const GOOGLE_CLIENT_CACHE_TTL_MS = 10 * 60 * 1000;
const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const DESKTOP_GOOGLE_CALLBACK_PATH = '/auth/desktop-google/callback';
// Fixed loopback port for the desktop Google callback: the registered Google
// redirect URI depends on it, so there is no fallback. The main server binds
// it directly when it serves on it (packaged desktop); every other mode
// serves the same callback through a dedicated listener on this port.
// Occupied → loud startup failure.
export const DESKTOP_PORT = 57123;
const DESKTOP_GOOGLE_REDIRECT_URI = `http://127.0.0.1:${DESKTOP_PORT}${DESKTOP_GOOGLE_CALLBACK_PATH}`;
const JSON_BODY_LIMIT = '64kb';

const defaultServiceBase = () => {
  try {
    return new URL(readAlcoreIssuer(undefined)).origin;
  } catch {
    return 'https://auth.alcore.io.vn';
  }
};

const resolveServiceBase = (explicit) => {
  const direct = z.string().min(1).optional().safeParse(explicit).data?.trim();
  if (direct) {
    try {
      return new URL(direct).origin;
    } catch {
      return defaultServiceBase();
    }
  }
  return defaultServiceBase();
};

const emailSchema = z.string().trim().toLowerCase().min(3).max(254);
const passwordSchema = z.string().min(1).max(512);
const codeSchema = z.string().trim().min(1).max(64);
const requestIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
const nonEmptyStringSchema = z.string().min(1);
// Service and browser payloads are parsed with these schemas at their
// boundaries instead of ad-hoc type narrowing.
const servicePairSchema = z.object({
  access_token: nonEmptyStringSchema,
  // The rotating refresh token the auth-service returns beside the access
  // JWT (absent until its track lands): captured to the keychain with the
  // access token, never required for the login itself.
  refresh_token: z.string().trim().min(1).max(4096).optional(),
});
// Upstream error codes are named, not free text: only codes matching the
// service's own machine-code shape pass through to the failure page.
const serviceErrorSchema = z.object({ error: z.string().regex(/^[A-Za-z0-9_]{1,64}$/) });
const serviceMeSchema = z.object({ id: nonEmptyStringSchema });
// Verified identity extras the IDE session can carry without touching
// issuance: the Google exchange profile (signature-verified name/picture
// the auth-service hands to the completing client once and persists
// nowhere) plus the account email (pair user view, or best-effort
// GET /auth/me with the fresh pair). Bounds mirror the service so a
// malformed value drops its field instead of forging a profile.
const profileNameField = z.string().trim().min(1).max(256);
const profilePictureField = z.string().trim().min(1).max(2048).refine((url) => url.startsWith('https://'));
const profileEmailField = z.string().trim().toLowerCase().email().max(254);
const completionProfileSchema = z.object({
  name: profileNameField.optional(),
  picture: profilePictureField.optional(),
  email: profileEmailField.optional(),
});
const exchangeProfileSchema = z.object({
  profile: z.record(z.string(), z.unknown()).optional(),
});
const pairUserSchema = z.object({
  user: z.object({
    email: profileEmailField,
  }).optional(),
});
const meEmailSchema = z.object({
  email: profileEmailField,
});

// Field-wise capture of the exchange profile: one malformed field drops
// only itself, never the whole profile or the login.
const captureExchangeProfile = (exchangeData) => {
  const outer = exchangeProfileSchema.safeParse(exchangeData);
  const holder = outer.success ? outer.data.profile : undefined;
  if (holder === undefined) return null;
  const profile = {};
  const name = z.object({ name: profileNameField.optional() }).safeParse(holder);
  if (name.success && name.data.name !== undefined) profile.name = name.data.name;
  const picture = z.object({ picture: profilePictureField.optional() }).safeParse(holder);
  if (picture.success && picture.data.picture !== undefined) profile.picture = picture.data.picture;
  return Object.keys(profile).length === 0 ? null : profile;
};

const readPairEmail = (pair) => {
  const parsed = pairUserSchema.safeParse(pair);
  return parsed.success ? parsed.data.user?.email ?? '' : '';
};

const mergeCompletionProfile = (completionProfile, email) => {
  const merged = {};
  if (completionProfile?.name !== undefined) merged.name = completionProfile.name;
  if (completionProfile?.picture !== undefined) merged.picture = completionProfile.picture;
  if (email !== '') merged.email = email;
  return Object.keys(merged).length === 0 ? null : merged;
};
const tokenSidSchema = z.object({ sid: z.string() });
const tokenSubSchema = z.object({ sub: z.string() });
const desktopCallbackQuerySchema = z.object({
  state: z.string(),
  code: z.string().optional(),
  error: z.string().optional(),
});
const booleanSchema = z.boolean().optional();

const sessionFieldsSchema = z.object({
  trustDevice: booleanSchema,
  issueClientToken: booleanSchema,
  clientLabel: z.string().trim().min(1).max(128).optional(),
  clientKind: z.string().trim().min(1).max(64).optional(),
  dedupeKey: z.string().trim().min(1).max(128).optional(),
  deviceName: z.string().trim().min(1).max(128).optional(),
  devicePlatform: z.string().trim().min(1).max(64).optional(),
  deviceModel: z.string().trim().min(1).max(128).optional(),
  appVersion: z.string().trim().min(1).max(64).optional(),
});

const emailLoginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
}).merge(sessionFieldsSchema);

const emailRegisterSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

const emailVerifyOtpSchema = z.object({
  email: emailSchema,
  code: codeSchema,
}).merge(sessionFieldsSchema);

const emailOtpResendSchema = z.object({
  email: emailSchema,
});

const googleCompleteSchema = z.object({
  requestId: requestIdSchema,
}).merge(sessionFieldsSchema);

const badRequest = (res, error) => res.status(400).json({ error });

export const createDesktopAuthRuntime = ({
  uiAuthController,
  alcoreSecret,
  alcorePreviousSecret,
  authServiceBase,
  serviceFetch = (...args) => fetch(...args),
  now = () => Date.now(),
  // Shared keychain store (production wiring passes the singleton; tests
  // inject a recording fake). Null disables capture without touching login.
  userTokenStore = null,
} = {}) => {
  const serviceBase = resolveServiceBase(authServiceBase);
  const pendingGoogle = new Map();
  let googleClientCache = null;

  const hasAlcoreSecret = () => {
    try {
      return readAlcoreKeys({ alcoreSecret, alcorePreviousSecret }).current !== '';
    } catch {
      return false;
    }
  };

  // Whether this server can verify Alcore tokens locally. Servers without
  // a shared secret (packaged desktop) convert service pairs through
  // service introspection instead (see completeWithServicePair).

  const sweepGoogle = () => {
    const at = now();
    for (const [id, entry] of pendingGoogle) {
      if (!entry || entry.expiresAt <= at) pendingGoogle.delete(id);
    }
  };

  const isTunnelScope = (tunnelAuthController, req) => {
    try {
      const scope = tunnelAuthController?.classifyRequestScope?.(req);
      return scope === 'tunnel' || scope === 'unknown-public';
    } catch {
      return false;
    }
  };

  const tunnelRefusal = (res, action) => res.status(403).json({
    error: `${action} is disabled for tunnel scope`,
    tunnelLocked: true,
  });

  const callAuthService = async (path, body, method = 'POST') => {
    const response = await serviceFetch(`${serviceBase}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    });
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  };

  const passthroughStatus = (res, status, data, fallback) => {
    if (status === 429) {
      const retryAfter = data && typeof data.retryAfter === 'number' ? data.retryAfter : undefined;
      if (retryAfter !== undefined) res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({ error: 'Too many attempts, please try again later', ...(retryAfter !== undefined ? { retryAfter } : {}) });
    }
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      const { ...safe } = data;
      return res.status(status).json(safe);
    }
    return res.status(status).json({ error: fallback });
  };

  // Best-effort account email for the local-verify path: Email/OTP pairs
  // already carry the verified user view, but Google pairs do not, so one
  // GET /auth/me with the fresh pair (the user's own token, keychained
  // only through captureUserTokens after issuance) fills it. Any failure
  // leaves name/picture intact — email is enrichment, never a login gate.
  const readServiceEmail = async (token) => {
    try {
      const response = await serviceFetch(`${serviceBase}/auth/me`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
      });
      if (response.status !== 200) return '';
      const parsed = meEmailSchema.safeParse(await response.json().catch(() => null));
      return parsed.success ? parsed.data.email : '';
    } catch {
      return '';
    }
  };

  // Convert a service session pair into an IDE UI session through the one
  // login path that owns cookies, TTLs, and client tokens. Fails closed when
  // this server could not verify Alcore tokens (no shared secret configured).
  // `completionProfile` is server-held data only (the captured exchange
  // profile, never client input): it rides the session body into issuance,
  // where the session owner re-validates and binds it. Issuance, cookies,
  // and validation are untouched.
  // Keychain capture at loopback completion: stores the pair the login
  // just proved, keyed by the verified subject, so the TokenPanel quota
  // proxy can present the caller's own Bearer later. Never breaks the
  // login it follows: an unkeyable subject, a non-200 issuance, or a
  // failing store resolves silently, and nothing here logs the tokens.
  const captureUserTokens = async (sub, accessToken, refreshToken, res) => {
    try {
      if (userTokenStore === null || userTokenStore === undefined) return;
      if (res?.statusCode !== 200) return;
      const id = z.string().trim().min(1).safeParse(sub).data ?? '';
      const access = String(accessToken ?? '').trim();
      if (id === '' || access === '') return;
      await userTokenStore.savePair(id, { accessToken: access, refreshToken });
    } catch {
      // Storage failure must not fail a proven login.
    }
  };

  const completeWithServicePair = async (req, res, pair, sessionOpts, completionProfile = null) => {
    const parsedPair = servicePairSchema.safeParse(pair);
    const token = parsedPair.success ? parsedPair.data.access_token.trim() : '';
    const refreshToken = parsedPair.success ? (parsedPair.data.refresh_token ?? '') : '';
    if (token === '') {
      return res.status(502).json({ error: 'unavailable' });
    }
    if (hasAlcoreSecret()) {
      const pairEmail = readPairEmail(pair);
      const email = pairEmail === '' ? await readServiceEmail(token) : pairEmail;
      const profile = mergeCompletionProfile(completionProfile, email);
      const sessionExtra = { alcoreToken: token };
      if (profile !== null) sessionExtra.profile = profile;
      req.body = sessionBodyOf(sessionOpts, sessionExtra);
      await uiAuthController.handleSessionCreate(req, res);
      // The session owner just verified this pair (local HMAC): the decode
      // below is keying only — trust comes from the 200 above, and the
      // unverified sub never gates anything.
      await captureUserTokens(decodeAccessTokenSub(token), token, refreshToken, res);
      return;
    }
    // Packaged desktop: no shared secret is available (and none is shipped
    // in the app), so the pair is confirmed live against the service itself
    // before the local session is issued. An unreachable or unconfirming
    // service fails closed — never a session.
    if (uiAuthController.handleServiceVerifiedSessionCreate === undefined) {
      return res.status(503).json({ error: 'alcore_not_configured' });
    }
    const confirmed = await introspectServicePair(token);
    if (!confirmed || confirmed.sid === '') {
      return res.status(502).json({ error: 'unavailable' });
    }
    const profile = mergeCompletionProfile(completionProfile, confirmed.email);
    const sessionExtra = {};
    if (profile !== null) sessionExtra.profile = profile;
    req.body = sessionBodyOf(sessionOpts, sessionExtra);
    await uiAuthController.handleServiceVerifiedSessionCreate(req, res, { sub: confirmed.sub, sid: confirmed.sid });
    // The subject here was confirmed live against the service itself.
    await captureUserTokens(confirmed.sub, token, refreshToken, res);
    return;
  };

  // Session login body: optional flags are added only when present, so an
  // absent flag and an explicit false stay distinct downstream.
  const sessionBodyOf = (sessionOpts, extra) => {
    const body = { ...extra, ...optionalSessionFields(sessionOpts) };
    if (sessionOpts.trustDevice === true) body.trustDevice = true;
    if (sessionOpts.issueClientToken === true) body.issueClientToken = true;
    return body;
  };

  // GET /auth/me token introspection: proves the service pair is live and
  // yields the authoritative subject. The sid rides along unverified from
  // the token payload (informational, for the session response); trust comes
  // from the service's 200, not from local parsing. The account email rides
  // along the same way when the user view carries one (best-effort profile
  // enrichment, never a gate).
  const introspectServicePair = async (token) => {
    try {
      const response = await serviceFetch(`${serviceBase}/auth/me`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
      });
      const data = await response.json().catch(() => null);
      const parsedMe = serviceMeSchema.safeParse(data);
      const sub = parsedMe.success ? parsedMe.data.id.trim() : '';
      if (response.status !== 200 || sub === '') return null;
      const parsedEmail = meEmailSchema.safeParse(data);
      return { sub, sid: decodeAccessTokenSid(token), email: parsedEmail.success ? parsedEmail.data.email : '' };
    } catch {
      return null;
    }
  };

  // Unverified subject decode for keychain keying only (see
  // captureUserTokens): trust comes from issuance, never this parse.
  const decodeAccessTokenSub = (token) => {
    try {
      const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
      const parsedSub = tokenSubSchema.safeParse(payload);
      return parsedSub.success ? parsedSub.data.sub.trim() : '';
    } catch {
      return '';
    }
  };

  const decodeAccessTokenSid = (token) => {
    try {
      const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
      const parsedSid = tokenSidSchema.safeParse(payload);
      return parsedSid.success ? parsedSid.data.sid.trim() : '';
    } catch {
      return '';
    }
  };

  const optionalSessionFields = (opts) => {
    const out = {};
    for (const key of ['clientLabel', 'clientKind', 'dedupeKey', 'deviceName', 'devicePlatform', 'deviceModel', 'appVersion']) {
      if (typeof opts[key] === 'string' && opts[key] !== '') out[key] = opts[key];
    }
    return out;
  };

  const sessionOptsOf = (parsed) => ({
    trustDevice: parsed.trustDevice,
    issueClientToken: parsed.issueClientToken,
    ...optionalSessionFields(parsed),
  });

  const fetchGoogleClientId = async () => {
    const at = now();
    if (googleClientCache && googleClientCache.expiresAt > at) return googleClientCache.clientId;
    try {
      const { status, data } = await callAuthService('/auth/google/config', undefined, 'GET');
      const clientId = status === 200 && data && typeof data.clientId === 'string' ? data.clientId.trim() : '';
      if (clientId !== '') {
        googleClientCache = { clientId, expiresAt: at + GOOGLE_CLIENT_CACHE_TTL_MS };
        return clientId;
      }
    } catch {
      // Unreachable service reads as unconfigured; the next call retries.
    }
    return '';
  };

  const base64Url = (bytes) => Buffer.from(bytes).toString('base64url');

  // PKCE (S256) for the loopback hop: the verifier never leaves this server
  // except inside the confidential service exchange.
  const mintPkce = () => {
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash('sha256').update(verifier, 'utf8').digest());
    return { verifier, challenge };
  };


  const callbackPage = (title, heading, message, done) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — OpenChamber</title>
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#131110;color:#fafaf9}.card{text-align:center;max-width:24rem;padding:2rem}#done{color:#4ade80}p{color:#a8a29e}</style>
</head>
<body><div class="card">
<h1>${heading}</h1>
<p${done ? ' id="done"' : ''}>${message}</p>
</div></body></html>`;

  const callbackSuccessPage = () => callbackPage(
    'Signed in',
    'Sign in with Google',
    'Signed in — return to the OpenChamber app.',
    true,
  );

  const escHtml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // Named loopback-callback failure page. Every failure names the failing
  // step and the upstream error code twice: in body[data-auth-error] (the
  // machine hook, same contract as the service's googleFail pages) and in
  // a visible <code> line — a did-not-complete page never stays silent
  // about where it failed. `detail` carries short upstream context (the
  // provider's error value or the service HTTP status); always escaped.
  const callbackFailurePage = (status, { step, code, detail }) => {
    const copy = status === 502 || status === 503
      ? { title: 'Sign-in unavailable', message: 'Google login is not available right now. Close this tab and try again later.' }
      : status === 409
        ? { title: 'Sign-in conflict', message: 'This Google account is linked to a different sign-in. Close this tab and try another account.' }
        : { title: 'Sign-in failed', message: 'Google sign-in did not complete. Close this tab and restart Google login from the app.' };
    const detailLine = detail === '' ? '' : `<p><code>${escHtml(detail)}</code></p>`;
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${copy.title} — OpenChamber</title>
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#131110;color:#fafaf9}.card{text-align:center;max-width:24rem;padding:2rem}p{color:#a8a29e}code{color:#e7e5e4}</style>
</head>
<body data-auth-error="${escHtml(code)}"><div class="card">
<h1>Sign in with Google</h1>
<p>${copy.message}</p>
<p><code>${escHtml(step)} \u00b7 ${escHtml(code)}</code></p>
${detailLine}
</div></body></html>`;
  };

  // Map a failed POST /auth/google/desktop-code exchange to a named
  // failure. A 404 or non-JSON answer means the service where the app
  // points has no desktop-code endpoint (deployment predates it): that is
  // reported as desktop_code_unavailable, never as a generic credential
  // failure. Known service error codes pass through; anything else reads
  // as an invalid credential, matching the service's own fail-closed shape.
  const exchangeFailureOf = (exchange) => {
    const data = exchange.data;
    if (exchange.status === 404 || data === null) {
      return {
        step: 'exchange', code: 'desktop_code_unavailable', status: 502, detail: `service ${exchange.status}`,
      };
    }
    const parsedServiceError = serviceErrorSchema.safeParse(data);
    const serviceCode = parsedServiceError.success ? parsedServiceError.data.error : '';
    if (exchange.status === 503 || serviceCode === 'google_not_configured') {
      return { step: 'exchange', code: 'google_not_configured', status: 503, detail: '' };
    }
    if (exchange.status === 409 || serviceCode === 'identity_conflict') {
      return { step: 'exchange', code: 'identity_conflict', status: 409, detail: '' };
    }
    if (exchange.status === 429) {
      return {
        step: 'exchange', code: 'upstream_unavailable', status: 502, detail: `service ${exchange.status}`,
      };
    }
    return {
      step: 'exchange', code: serviceCode === '' ? 'invalid_google_credential' : serviceCode, status: 401, detail: '',
    };
  };

  // Loopback OAuth callback handler, shared by the main server and the
  // fixed-port listener: one implementation over one pending-request map.
  // The dedicated listener mounts only this route through
  // registerCallbackRoute below — no logic is duplicated there.
  const handleDesktopGoogleCallback = async (req, res) => {
    const fail = (status, failure) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(status).send(callbackFailurePage(status, failure));
    };
    const parsedQuery = desktopCallbackQuerySchema.safeParse(req?.query ?? {});
    const state = parsedQuery.success ? parsedQuery.data.state : '';
    const code = parsedQuery.success && parsedQuery.data.code !== undefined ? parsedQuery.data.code : '';
    const googleError = parsedQuery.success && parsedQuery.data.error !== undefined ? parsedQuery.data.error : '';
    if (googleError !== '') {
      return fail(400, {
        step: 'google', code: 'google_oauth_error', detail: googleError.slice(0, 64),
      });
    }
    if (!requestIdSchema.safeParse(state).success || code === '' || code.length > 2048) {
      return fail(400, { step: 'callback', code: 'invalid_request', detail: '' });
    }
    sweepGoogle();
    const pending = pendingGoogle.get(state);
    if (!pending) {
      return fail(410, { step: 'callback', code: 'invalid_state', detail: '' });
    }
    if (pending.failure !== null && pending.failure !== undefined) {
      // Repeat navigation after a failed exchange: the same named page.
      return fail(pending.failure.status, pending.failure);
    }
    if (pending.pair !== null) {
      // Double navigation after a captured code: idempotent success.
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(callbackSuccessPage());
    }
    let exchange;
    try {
      exchange = await callAuthService('/auth/google/desktop-code', {
        code,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier,
        nonce: pending.nonce,
      });
    } catch {
      pending.failure = { step: 'exchange', code: 'upstream_unavailable', status: 502, detail: '' };
      return fail(502, pending.failure);
    }
    const parsedPair = exchange.status === 200
      ? servicePairSchema.safeParse(exchange.data)
      : null;
    const accessToken = parsedPair && parsedPair.success ? parsedPair.data.access_token.trim() : '';
    if (accessToken === '') {
      pending.failure = exchangeFailureOf(exchange);
      return fail(pending.failure.status, pending.failure);
    }
    pending.pair = accessToken;
    // The loopback completion must carry BOTH tokens: the refresh token
    // rides the server-held pending entry (never the browser, never the
    // poll body) into google-complete, where capture keychains it.
    pending.refreshToken = parsedPair.success ? (parsedPair.data.refresh_token ?? '') : '';
    // The completion payload carries the signature-verified Google profile
    // once; capture it here or the IDE session never learns the name/avatar.
    pending.profile = captureExchangeProfile(exchange.data);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(callbackSuccessPage());
  };

  const registerCallbackRoute = ({ get: getRoute }) => {
    getRoute(DESKTOP_GOOGLE_CALLBACK_PATH, handleDesktopGoogleCallback);
  };

  const registerRoutes = ({ get, post }, { express, tunnelAuthController }) => {
    const json = express.json({ limit: JSON_BODY_LIMIT });

    get('/api/auth/desktop/config', async (req, res) => {
      const clientId = await fetchGoogleClientId();
      res.setHeader('Cache-Control', 'no-store');
      res.json({ googleConfigured: clientId !== '' });
    });

    post('/api/auth/desktop/email/login', json, async (req, res) => {
      if (isTunnelScope(tunnelAuthController, req)) return tunnelRefusal(res, 'Email login');
      // No fail-fast on the Alcore secret here: servers without one confirm
      // the resulting pair against the service itself (see
      // completeWithServicePair), so the credential send below is purposeful.
      const parsed = emailLoginSchema.safeParse(req?.body);
      if (!parsed.success) return badRequest(res, 'invalid_request');
      let service;
      try {
        service = await callAuthService('/auth/login', { email: parsed.data.email, password: parsed.data.password });
      } catch {
        return res.status(502).json({ error: 'unavailable' });
      }
      if (service.status === 200) {
        return completeWithServicePair(req, res, service.data, sessionOptsOf(parsed.data));
      }
      return passthroughStatus(res, service.status, service.data, 'invalid_request');
    });

    post('/api/auth/desktop/email/register', json, async (req, res) => {
      if (isTunnelScope(tunnelAuthController, req)) return tunnelRefusal(res, 'Email signup');
      const parsed = emailRegisterSchema.safeParse(req?.body);
      if (!parsed.success) return badRequest(res, 'invalid_request');
      let service;
      try {
        service = await callAuthService('/auth/register', { email: parsed.data.email, password: parsed.data.password });
      } catch {
        return res.status(502).json({ error: 'unavailable' });
      }
      return passthroughStatus(res, service.status, service.data, 'invalid_request');
    });

    post('/api/auth/desktop/email/verify-otp', json, async (req, res) => {
      if (isTunnelScope(tunnelAuthController, req)) return tunnelRefusal(res, 'Email verification');
      // Same as email login: the pair converts via service introspection
      // when no local secret is configured.
      const parsed = emailVerifyOtpSchema.safeParse(req?.body);
      if (!parsed.success) return badRequest(res, 'invalid_request');
      let service;
      try {
        service = await callAuthService('/auth/verify-otp', { email: parsed.data.email, code: parsed.data.code });
      } catch {
        return res.status(502).json({ error: 'unavailable' });
      }
      if (service.status === 200) {
        return completeWithServicePair(req, res, service.data, sessionOptsOf(parsed.data));
      }
      return passthroughStatus(res, service.status, service.data, 'invalid_request');
    });

    post('/api/auth/desktop/email/otp-resend', json, async (req, res) => {
      if (isTunnelScope(tunnelAuthController, req)) return tunnelRefusal(res, 'Email verification');
      const parsed = emailOtpResendSchema.safeParse(req?.body);
      if (!parsed.success) return badRequest(res, 'invalid_request');
      let service;
      try {
        service = await callAuthService('/auth/otp-resend', { email: parsed.data.email });
      } catch {
        return res.status(502).json({ error: 'unavailable' });
      }
      return passthroughStatus(res, service.status, service.data, 'invalid_request');
    });

    post('/api/auth/desktop/google/start', json, async (req, res) => {
      if (isTunnelScope(tunnelAuthController, req)) return tunnelRefusal(res, 'Google login');
      const clientId = await fetchGoogleClientId();
      if (clientId === '') {
        return res.status(503).json({ error: 'google_not_configured' });
      }
      // Pinned to the registered Google callback URI in all modes: the
      // request Host (dynamic per launch) never influences it, so the
      // authorize URL always matches the registered redirect exactly.
      const redirectUri = DESKTOP_GOOGLE_REDIRECT_URI;
      sweepGoogle();
      const requestId = randomBytes(16).toString('hex');
      const { verifier, challenge } = mintPkce();
      const nonce = randomBytes(16).toString('hex');
      pendingGoogle.set(requestId, {
        verifier,
        nonce,
        redirectUri,
        pair: null,
        refreshToken: '',
        profile: null,
        failure: null,
        expiresAt: now() + GOOGLE_REQUEST_TTL_MS,
      });
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state: requestId,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ requestId, googleUrl: `${GOOGLE_AUTHORIZE_URL}?${params.toString()}` });
    });

    registerCallbackRoute({ get });

    post('/api/auth/desktop/google-complete', json, async (req, res) => {
      if (isTunnelScope(tunnelAuthController, req)) return tunnelRefusal(res, 'Google login');
      const parsed = googleCompleteSchema.safeParse(req?.body);
      if (!parsed.success) return badRequest(res, 'invalid_request');
      sweepGoogle();
      const pending = pendingGoogle.get(parsed.data.requestId);
      if (pending?.failure !== undefined && pending?.failure !== null) {
        // Terminal: the callback already failed with a named step+code.
        // Hand it to the app at once instead of polling 404 until the
        // request expires. Single-use: consume before answering.
        pendingGoogle.delete(parsed.data.requestId);
        return res.status(pending.failure.status).json({ error: pending.failure.code, step: pending.failure.step });
      }
      const parsedPair = servicePairSchema.safeParse({ access_token: pending?.pair });
      if (!pending || !parsedPair.success || parsedPair.data.access_token.trim() === '') {
        // Still waiting (or unknown/consumed/expired): answer 404 WITHOUT
        // consuming, so pre-callback polls never orphan the pending login
        // the loopback callback is about to present.
        return res.status(404).json({ error: 'no_credential' });
      }
      // Single-use: consume before issuing so a replay races nothing. The
      // captured exchange profile and refresh token are server-held (never
      // client input) and ride into issuance, where the session owner
      // binds the profile and the keychain capture takes the pair.
      const completionProfile = pending.profile ?? null;
      const completionPair = { access_token: parsedPair.data.access_token.trim() };
      const pendingRefresh = z.string().trim().min(1).safeParse(pending.refreshToken).data;
      if (pendingRefresh !== undefined) {
        completionPair.refresh_token = pendingRefresh;
      }
      pendingGoogle.delete(parsed.data.requestId);
      return completeWithServicePair(req, res, completionPair, sessionOptsOf(parsed.data), completionProfile);
    });
  };

  return {
    registerRoutes,
    // Mounts only GET /auth/desktop-google/callback with the same handler
    // (and the same pending-request map) for the fixed-port listener.
    registerCallbackRoute,
    serviceBase,
    // Test seams (not routes).
    _pendingGoogle: pendingGoogle,
    _sweepGoogle: sweepGoogle,
  };
};

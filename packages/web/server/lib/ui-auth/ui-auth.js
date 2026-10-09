import crypto from 'crypto';

// jose is loaded on the first session check, not with the server.
let josePending;
const loadJose = () => {
  josePending ??= import('jose');
  return josePending;
};
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createUiPasskeys } from './ui-passkeys.js';
import { sessionCookieNameForRequest } from './session-cookie.js';
import { z } from 'zod';

const SESSION_COOKIE_NAME = 'oc_ui_session';
const HOUR_MS = 60 * 60 * 1000;

// A positive number of hours or days from the environment, else the default.
export const readSessionTtlMs = (raw, unitMs, fallbackMs) => {
  const value = Number(String(raw ?? '').trim());
  return Number.isFinite(value) && value > 0 ? Math.round(value * unitMs) : fallbackMs;
};

const SESSION_TTL_MS = readSessionTtlMs(process.env.OPENCHAMBER_UI_SESSION_TTL_HOURS, HOUR_MS, 12 * HOUR_MS);
const TRUSTED_DEVICE_SESSION_TTL_MS = readSessionTtlMs(
  process.env.OPENCHAMBER_UI_TRUSTED_SESSION_TTL_DAYS,
  24 * HOUR_MS,
  7 * 24 * HOUR_MS,
);
const URL_AUTH_TOKEN_TTL_MS = 60 * 1000;
const URL_AUTH_TOKEN_PREFIX = 'oc_url_';

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = Number(process.env.OPENCHAMBER_RATE_LIMIT_MAX_ATTEMPTS) || 10;
const RATE_LIMIT_LOCKOUT_MS = 15 * 60 * 1000;
const RATE_LIMIT_CLEANUP_MS = 60 * 60 * 1000;
const RATE_LIMIT_NO_IP_MAX_ATTEMPTS = Number(process.env.OPENCHAMBER_RATE_LIMIT_NO_IP_MAX_ATTEMPTS) || 3;

const loginRateLimiter = new Map();
let rateLimitCleanupTimer = null;

const rateLimitLocks = new Map();

const getClientIp = (req) => {
  // req.ip follows X-Forwarded-For only through proxies the server trusts
  // ('trust proxy' in server/index.js); reading the header directly would let
  // every login attempt pick a fresh rate-limit bucket.
  const ip = req.ip || req.socket?.remoteAddress;
  if (ip) {
    if (ip.startsWith('::ffff:')) {
      return ip.substring(7);
    }
    return ip;
  }
  return null;
};

const getRateLimitKey = (req) => {
  const ip = getClientIp(req);
  if (ip) return ip;
  return 'rate-limit:no-ip';
};

const getRateLimitConfig = (key) => {
  if (key === 'rate-limit:no-ip') {
    return {
      maxAttempts: RATE_LIMIT_NO_IP_MAX_ATTEMPTS,
      windowMs: RATE_LIMIT_WINDOW_MS
    };
  }
  return {
    maxAttempts: RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: RATE_LIMIT_WINDOW_MS
  };
};

const acquireRateLimitLock = async (key) => {
  const prev = rateLimitLocks.get(key) || Promise.resolve();
  const curr = prev.then(() => rateLimitLocks.delete(key));
  rateLimitLocks.set(key, curr);
  await curr;
};

const checkRateLimit = async (req) => {
  const key = getRateLimitKey(req);
  await acquireRateLimitLock(key);

  const now = Date.now();
  const { maxAttempts } = getRateLimitConfig(key);

  let record;
  try {
    record = loginRateLimiter.get(key);
  } catch (err) {
    console.error('[RateLimit] Failed to get record', { key, error: err.message });
    return {
      allowed: true,
      limit: maxAttempts,
      remaining: maxAttempts,
      reset: Math.ceil((now + RATE_LIMIT_WINDOW_MS) / 1000)
    };
  }

  if (record?.lockedUntil && now < record.lockedUntil) {
    return {
      allowed: false,
      retryAfter: Math.ceil((record.lockedUntil - now) / 1000),
      locked: true,
      limit: maxAttempts,
      remaining: 0,
      reset: Math.ceil(record.lockedUntil / 1000)
    };
  }

  if (record?.lockedUntil && now >= record.lockedUntil) {
    try {
      loginRateLimiter.delete(key);
    } catch (err) {
      console.error('[RateLimit] Failed to delete expired record', { key, error: err.message });
    }
  }

  if (!record || now - record.lastAttempt > RATE_LIMIT_WINDOW_MS) {
    return {
      allowed: true,
      limit: maxAttempts,
      remaining: maxAttempts,
      reset: Math.ceil((now + RATE_LIMIT_WINDOW_MS) / 1000)
    };
  }

  if (record.count >= maxAttempts) {
    const lockedUntil = now + RATE_LIMIT_LOCKOUT_MS;
    try {
      loginRateLimiter.set(key, { count: record.count + 1, lastAttempt: now, lockedUntil });
    } catch (err) {
      console.error('[RateLimit] Failed to set lockout', { key, error: err.message });
    }
    return {
      allowed: false,
      retryAfter: Math.ceil(RATE_LIMIT_LOCKOUT_MS / 1000),
      locked: true,
      limit: maxAttempts,
      remaining: 0,
      reset: Math.ceil(lockedUntil / 1000)
    };
  }

  const remaining = maxAttempts - record.count;
  const reset = Math.ceil((record.lastAttempt + RATE_LIMIT_WINDOW_MS) / 1000);
  return {
    allowed: true,
    limit: maxAttempts,
    remaining,
    reset
  };
};

const recordFailedAttempt = async (req) => {
  const key = getRateLimitKey(req);
  await acquireRateLimitLock(key);

  const now = Date.now();
  const { maxAttempts } = getRateLimitConfig(key);
  const record = loginRateLimiter.get(key);

  if (!record || now - record.lastAttempt > RATE_LIMIT_WINDOW_MS) {
    try {
      loginRateLimiter.set(key, { count: 1, lastAttempt: now });
    } catch (err) {
      console.error('[RateLimit] Failed to record attempt', { key, error: err.message });
    }
  } else {
    const newCount = record.count + 1;
    try {
      loginRateLimiter.set(key, { count: newCount, lastAttempt: now });
    } catch (err) {
      console.error('[RateLimit] Failed to record attempt', { key, error: err.message });
    }
  }
};

const clearRateLimit = async (req) => {
  const key = getRateLimitKey(req);
  await acquireRateLimitLock(key);

  try {
    loginRateLimiter.delete(key);
  } catch (err) {
    console.error('[RateLimit] Failed to clear', { key, error: err.message });
  }
};

const cleanupRateLimitRecords = () => {
  const now = Date.now();
  for (const [key, record] of loginRateLimiter.entries()) {
    const isExpired = record.lockedUntil && now >= record.lockedUntil;
    const isStale = now - record.lastAttempt > RATE_LIMIT_CLEANUP_MS;
    if (isExpired || isStale) {
      try {
        loginRateLimiter.delete(key);
      } catch (err) {
        console.error('[RateLimit] Cleanup failed', { key, error: err.message });
      }
    }
  }
};

const startRateLimitCleanup = () => {
  if (!rateLimitCleanupTimer) {
    rateLimitCleanupTimer = setInterval(cleanupRateLimitRecords, RATE_LIMIT_CLEANUP_MS);
    if (rateLimitCleanupTimer && typeof rateLimitCleanupTimer.unref === 'function') {
      rateLimitCleanupTimer.unref();
    }
  }
};

const stopRateLimitCleanup = () => {
  if (rateLimitCleanupTimer) {
    clearInterval(rateLimitCleanupTimer);
    rateLimitCleanupTimer = null;
  }
};

const isSecureRequest = (req) => {
  if (req.secure) {
    return true;
  }
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string') {
    const firstProto = forwardedProto.split(',')[0]?.trim().toLowerCase();
    return firstProto === 'https';
  }
  return false;
};

const parseCookies = (cookieHeader) => {
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return {};
  }

  return cookieHeader.split(';').reduce((acc, segment) => {
    const [name, ...rest] = segment.split('=');
    if (!name) {
      return acc;
    }
    const key = name.trim();
    if (!key) {
      return acc;
    }
    const value = rest.join('=').trim();
    try {
      acc[key] = decodeURIComponent(value || '');
    } catch {
      acc[key] = value || '';
    }
    return acc;
  }, {});
};

const getBearerTokenFromRequest = (req) => {
  const header = req?.headers?.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === 'string') {
    const match = value.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1]?.trim() || '';
    if (token) return token;
  }
  return null;
};

const getUrlAuthTokenFromRequest = (req) => {
  const queryToken = req?.query?.oc_url_token;
  let token = Array.isArray(queryToken) ? queryToken[0] : queryToken;
  if (typeof token !== 'string' && typeof req?.url === 'string') {
    try {
      token = new URL(req.url, 'http://localhost').searchParams.get('oc_url_token') || undefined;
    } catch {
      token = undefined;
    }
  }
  if (typeof token === 'string' && token.trim()) return token.trim();
  return null;
};

const getRequestPathname = (req) => {
  const rawUrl = req?.originalUrl || req?.url;
  if (typeof rawUrl === 'string' && rawUrl) {
    try {
      return new URL(rawUrl, 'http://localhost').pathname;
    } catch {
      // Fall through to Express' derived path fields.
    }
  }
  if (typeof req?.baseUrl === 'string' && req.baseUrl && typeof req?.path === 'string' && req.path) {
    return `${req.baseUrl}${req.path}`.replace(/\/+/g, '/');
  }
  if (typeof req?.path === 'string' && req.path) return req.path;
  return '';
};

const isWebSocketUpgrade = (req) => {
  const upgrade = req?.headers?.upgrade;
  const upgradeValue = Array.isArray(upgrade) ? upgrade[0] : upgrade;
  return String(upgradeValue || '').toLowerCase() === 'websocket';
};

const GUEST_URL_AUTH_SCOPE = /^guest:([a-z][a-z0-9-]*)$/;

/**
 * A URL token scope narrows where the token is accepted. `guest:<id>` is
 * minted for a guest iframe and only opens that guest's own package files:
 * the iframe URL is readable by the guest's script, so the token must be
 * worthless anywhere else.
 * @returns {{ kind: 'guest', id: string } | null | undefined} `undefined` when the value is not a scope
 */
const parseUrlAuthScope = (value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return undefined;
  const match = raw.trim().match(GUEST_URL_AUTH_SCOPE);
  return match ? { kind: 'guest', id: match[1] } : undefined;
};

const isGuestScopedPath = (pathname, guestId) => pathname.startsWith(`/api/guests/${guestId}/`);

// An isolated space's raw file and its sockets, under `/api/spaces/<id>/`, matched by shape.
const SPACE_RAW_FILE_PATH = /^\/api\/spaces\/[0-9a-f]{12}\/fs\/raw$/;
const SPACE_WS_PATH = /^\/api\/spaces\/[0-9a-f]{12}\/(?:terminal\/ws|dev-tunnel|event\/ws|global\/event\/ws)$/;

const isUrlAuthReadableHttpPath = (pathname) => {
  return pathname === '/api/event'
    || pathname === '/api/global/event'
    || pathname === '/api/openchamber/events'
    || pathname === '/api/openchamber/realtime-proxy/sse'
    || pathname === '/api/notifications/stream'
    || pathname === '/api/fs/raw'
    || pathname.startsWith('/api/preview/proxy/')
    || /^\/api\/projects\/[^/]+\/icon$/.test(pathname)
    || pathname === '/api/guests'
    || /^\/api\/guests\/[a-z][a-z0-9-]*\//.test(pathname)
    || SPACE_RAW_FILE_PATH.test(pathname);
};

const isUrlAuthWebSocketPath = (pathname) => {
  return pathname === '/api/event/ws'
    || pathname === '/api/global/event/ws'
    || pathname === '/api/openchamber/realtime-proxy/ws'
    || pathname === '/api/terminal/ws'
    || pathname === '/api/dictation/ws'
    || pathname === '/api/dev-tunnel'
    || /^\/api\/guests\/[a-z][a-z0-9-]*\/surface\/ws$/.test(pathname)
    || pathname.startsWith('/api/preview/proxy/')
    || SPACE_WS_PATH.test(pathname);
};

const canUseUrlAuthTokenForRequest = (req, scope = null) => {
  const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET';
  const pathname = getRequestPathname(req);
  if (scope?.kind === 'guest') {
    return !isWebSocketUpgrade(req) && method === 'GET' && isGuestScopedPath(pathname, scope.id);
  }
  if (isWebSocketUpgrade(req)) {
    return isUrlAuthWebSocketPath(pathname);
  }
  return method === 'GET' && isUrlAuthReadableHttpPath(pathname);
};

const buildCookie = ({
  name,
  value,
  maxAge,
  secure,
}) => {
  const attributes = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];

  if (typeof maxAge === 'number') {
    attributes.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  }

  const expires = maxAge === 0
    ? 'Thu, 01 Jan 1970 00:00:00 GMT'
    : new Date(Date.now() + maxAge * 1000).toUTCString();

  attributes.push(`Expires=${expires}`);

  if (secure) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
};

// Alcore login (Wave 1): replaces the legacy password gate. Browser access
// requires a valid Alcore access token (HS256 JWT minted by the Alcore auth
// service: { sub, sid, iss, aud: 'auth', intent: 'session', exp }), exchanged
// via POST /auth/session for a port-scoped UI session cookie, or presented
// directly as Authorization: Bearer. Verified with node:crypto only — no new
// dependencies. Pairing/client tokens (oc_client_...) and the 127.0.0.1
// default bind are untouched; only this gate changes.
const DEFAULT_ALCORE_ISSUER = 'https://auth.alcore.io.vn';
const ALCORE_AUD = 'auth';
const ALCORE_INTENT = 'session';

export const readAlcoreIssuer = (explicit) => {
  const direct = z.string().min(1).optional().safeParse(explicit).data?.trim();
  if (direct) return direct;
  const fromEnv = z.string().min(1).optional().safeParse(
    process.env.ALCORE_ISSUER ?? process.env.AUTH_ISSUER,
  ).data?.trim();
  return fromEnv || DEFAULT_ALCORE_ISSUER;
};

const alcoreKeyOptionsSchema = z.object({
  current: z.string().optional(),
  alcoreSecret: z.string().optional(),
  previous: z.string().optional(),
  alcorePreviousSecret: z.string().optional(),
  currentKid: z.string().optional(),
  alcoreKid: z.string().optional(),
  previousKid: z.string().optional(),
  alcorePreviousKid: z.string().optional(),
});

const firstSecret = (values) => {
  for (const value of values) {
    if (value !== undefined && value !== '') return value;
  }
  return '';
};

const firstKid = (values, fallback) => {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return fallback;
};

export const readAlcoreKeys = (explicit = {}) => {
  const options = alcoreKeyOptionsSchema.safeParse(explicit).data ?? {};
  const env = process.env;
  const current = firstSecret([options.current, options.alcoreSecret, env.ALCORE_JWT_SECRET, env.JWT_SECRET]);
  const previous = firstSecret([options.previous, options.alcorePreviousSecret, env.ALCORE_JWT_SECRET_PREVIOUS, env.JWT_SECRET_PREVIOUS]);
  const currentKid = firstKid([options.currentKid, options.alcoreKid, env.ALCORE_JWT_SECRET_KID, env.JWT_SECRET_KID], 'k1');
  const previousKid = firstKid([options.previousKid, options.alcorePreviousKid, env.ALCORE_JWT_SECRET_PREVIOUS_KID, env.JWT_SECRET_PREVIOUS_KID], 'k0');
  return previous === '' ? { current, currentKid } : { current, currentKid, previous, previousKid };
};

const alcoreB64Decode = (input) => Buffer.from(String(input).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const alcoreB64DecodeBytes = (input) => Buffer.from(String(input).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const alcoreSignData = (data, secret) => crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(Buffer.from(data, 'utf8')).digest();

const alcoreHeaderSchema = z.object({
  alg: z.string(),
  kid: z.string().optional(),
});

const alcorePayloadSchema = z.object({
  sub: z.string().min(1),
  sid: z.string().min(1),
  iss: z.string(),
  aud: z.string(),
  exp: z.number(),
  intent: z.string(),
});

const alcoreKeySetSchema = z.object({
  current: z.string().optional(),
  currentKid: z.string().optional(),
  previous: z.string().optional(),
  previousKid: z.string().optional(),
});

export const verifyAlcoreAccessToken = (token, keys, issuer) => {
  const clean = z.string().min(1).safeParse(token).data;
  if (!clean) throw new Error('malformed jwt');
  const parts = clean.split('.');
  if (parts.length !== 3) throw new Error('malformed jwt');
  const headerEnc = parts[0] ?? '';
  const payloadEnc = parts[1] ?? '';
  const sig = parts[2] ?? '';
  let headerRaw;
  let payloadRaw;
  try {
    headerRaw = JSON.parse(alcoreB64Decode(headerEnc));
    payloadRaw = JSON.parse(alcoreB64Decode(payloadEnc));
  } catch {
    throw new Error('malformed jwt');
  }
  const header = alcoreHeaderSchema.safeParse(headerRaw).data;
  if (!header) throw new Error('malformed jwt');
  if (header.alg !== 'HS256') throw new Error('unsupported alg');
  const rawKid = header.kid ?? null;
  const tokenKid = rawKid === null || rawKid === '' ? null : rawKid;
  const keySet = alcoreKeySetSchema.safeParse(keys).data ?? {};
  if (tokenKid !== null) {
    const known = (keySet.currentKid !== undefined && tokenKid === keySet.currentKid)
      || (keySet.previousKid !== undefined && tokenKid === keySet.previousKid);
    if (!known) throw new Error('unknown kid');
  }
  const current = keySet.current ?? '';
  const previous = keySet.previous ?? '';
  const candidates = tokenKid === null
    ? (previous !== '' ? [current, previous] : [current])
    : (tokenKid === keySet.previousKid && previous !== '' ? [previous] : [current]);
  const data = headerEnc + '.' + payloadEnc;
  const presented = alcoreB64DecodeBytes(sig);
  let ok = false;
  for (const candidate of candidates) {
    if (candidate === '') continue;
    const expected = alcoreSignData(data, candidate);
    if (presented.length === expected.length && crypto.timingSafeEqual(presented, expected)) {
      ok = true;
      break;
    }
  }
  if (!ok) throw new Error('bad signature');
  const claims = alcorePayloadSchema.safeParse(payloadRaw).data;
  if (!claims) throw new Error('malformed payload');
  if (claims.iss !== issuer || claims.aud !== ALCORE_AUD) throw new Error('malformed payload');
  if (claims.intent !== ALCORE_INTENT) throw new Error('malformed payload');
  if (claims.exp <= Math.floor(Date.now() / 1000)) throw new Error('expired');
  return { sub: claims.sub, sid: claims.sid, iss: claims.iss, aud: claims.aud, exp: claims.exp, intent: claims.intent };
};

const getAlcoreTokenFromRequest = (req) => {
  const header = req?.headers?.authorization;
  const first = (Array.isArray(header) ? header[0] : header) ?? '';
  const text = z.string().safeParse(first).data ?? '';
  const match = text.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() ?? '';
  if (token !== '' && token.split('.').length === 3 && !token.startsWith('oc_client_')) return token;
  return null;
};

const alcoreLoginBodySchema = z.object({
  alcoreToken: z.string().optional(),
  accessToken: z.string().optional(),
  token: z.string().optional(),
});

const serviceVerifiedIdentitySchema = z.object({
  sub: z.string(),
  sid: z.string(),
});

// Desktop-login profile read-through (project-ide task 36): the desktop
// completion path (desktop-auth) captures the service-verified Google
// profile + account email server-side and passes it in the session body.
// It is bound here to the issued session (cookie token, and the desktop
// client id when one is minted alongside) in a TTL-bounded in-memory map
// so GET /auth/session can carry name/avatar/email. Validation, cookies,
// JWTs, TTLs, rate limits, and client issuance are untouched: a missing or
// malformed profile answers exactly the old shape, and entries expire with
// the session that owns them. The sub link is always server-verified;
// display fields arriving on the direct login path are bound to that same
// verified sub, never a client-chosen identity.
const sessionProfileNameField = z.string().trim().min(1).max(256);
const sessionProfilePictureField = z.string().trim().min(1).max(2048).refine((url) => url.startsWith('https://'));
const sessionProfileEmailField = z.string().trim().toLowerCase().email().max(254);
const sessionProfileBodySchema = z.object({ profile: z.object({}).passthrough().optional() });
const SESSION_PROFILE_MAX_KEYS = 2000;

// Field-wise read of the login body profile: one malformed field drops
// only itself, never the whole profile or the login.
const readSessionProfile = (req) => {
  const outer = sessionProfileBodySchema.safeParse(req?.body);
  const holder = outer.success ? outer.data.profile : undefined;
  if (holder === undefined) return null;
  const record = {};
  const name = z.object({ name: sessionProfileNameField.optional() }).safeParse(holder);
  if (name.success && name.data.name !== undefined) record.name = name.data.name;
  const picture = z.object({ picture: sessionProfilePictureField.optional() }).safeParse(holder);
  if (picture.success && picture.data.picture !== undefined) record.picture = picture.data.picture;
  const email = z.object({ email: sessionProfileEmailField.optional() }).safeParse(holder);
  if (email.success && email.data.email !== undefined) record.email = email.data.email;
  return Object.keys(record).length === 0 ? null : record;
};

const clientBindingSchema = z.object({
  client: z.object({ id: z.string().min(1) }).passthrough().optional(),
  clientId: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
});

// The status-time binding for an issued desktop client, derived exactly the
// way clientSessionToken derives it when that client later authenticates.
const clientBindingOf = (result) => {
  const parsed = clientBindingSchema.safeParse(result);
  if (!parsed.success) return null;
  const id = parsed.data.client?.id ?? parsed.data.clientId ?? parsed.data.id ?? null;
  return id === null ? null : `client:${id}`;
};

const readAlcoreLoginToken = (req) => {
  const body = alcoreLoginBodySchema.safeParse(req?.body).data;
  const candidates = [body?.alcoreToken, body?.accessToken, body?.token];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed && trimmed.split('.').length === 3) return trimmed;
  }
  return getAlcoreTokenFromRequest(req);
};

const isTrustedDeviceRequest = (value) => value === true;

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');
const JWT_SECRET_FILE = path.join(OPENCHAMBER_DATA_DIR, 'jwt-secret');

function getOrCreateJwtSecret() {
  const envSecret = process.env.OPENCODE_JWT_SECRET;
  if (envSecret) {
    return new TextEncoder().encode(envSecret);
  }

  try {
    if (fs.existsSync(JWT_SECRET_FILE)) {
      return new TextEncoder().encode(fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim());
    }
  } catch (e) {
    console.warn('[JWT] Failed to read secret file:', e.message);
  }

  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(OPENCHAMBER_DATA_DIR, { recursive: true });
    fs.writeFileSync(JWT_SECRET_FILE, secret, { mode: 0o600 });
    console.log('[JWT] Generated and persisted new secret to', JWT_SECRET_FILE);
  } catch (e) {
    console.warn('[JWT] Failed to persist secret:', e.message);
  }

  return new TextEncoder().encode(secret);
}

function persistJwtSecret(secret) {
  if (process.env.OPENCODE_JWT_SECRET) {
    const error = new Error('Global sign-out is unavailable while OPENCODE_JWT_SECRET is set');
    error.statusCode = 400;
    throw error;
  }

  fs.mkdirSync(OPENCHAMBER_DATA_DIR, { recursive: true });
  fs.writeFileSync(JWT_SECRET_FILE, secret, { mode: 0o600 });
  return new TextEncoder().encode(secret);
}

export const createUiAuth = ({
  password,
  alcoreSecret,
  alcorePreviousSecret,
  alcoreIssuer,
  alcoreKid,
  alcorePreviousKid,
  cookieName = SESSION_COOKIE_NAME,
  sessionTtlMs = SESSION_TTL_MS,
  trustedSessionTtlMs = TRUSTED_DEVICE_SESSION_TTL_MS,
  readSettingsFromDiskMigrated,
  clientAuthController = null,
  requireClientAuth = false,
} = {}) => {
  const alcoreIssuerValue = readAlcoreIssuer(alcoreIssuer);
  const alcoreKeys = () => readAlcoreKeys({ alcoreSecret, alcorePreviousSecret, alcoreKid, alcorePreviousKid });
  const verifyAlcore = (token) => {
    const keys = alcoreKeys();
    if (!keys.current) throw new Error('alcore not configured');
    return verifyAlcoreAccessToken(token, keys, alcoreIssuerValue);
  };
  const tryVerifyAlcore = (token) => {
    if (!token) return null;
    try {
      return verifyAlcore(token);
    } catch {
      return null;
    }
  };
  const urlAuthTokens = new Map();
  // Session -> login profile bindings (cookie token and desktop client id).
  // Read-only enrichment for GET /auth/session; never consulted by any
  // validation path.
  const sessionProfiles = new Map();

  const sweepSessionProfiles = (at) => {
    for (const [binding, entry] of sessionProfiles) {
      if (!entry || entry.expiresAt <= at) sessionProfiles.delete(binding);
    }
    while (sessionProfiles.size > SESSION_PROFILE_MAX_KEYS) {
      const oldest = sessionProfiles.keys().next();
      if (oldest.done) break;
      sessionProfiles.delete(oldest.value);
    }
  };

  const rememberSessionProfile = (bindings, record, ttlMs) => {
    if (record === null || bindings.length === 0) return;
    const at = Date.now();
    sweepSessionProfiles(at);
    const entry = { record, expiresAt: at + ttlMs };
    for (const binding of bindings) sessionProfiles.set(binding, entry);
  };

  const readSessionProfileFor = (binding) => {
    const entry = sessionProfiles.get(binding);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      sessionProfiles.delete(binding);
      return null;
    }
    return entry.record;
  };

  const profileAlcoreOf = (record) => {
    const alcore = { sub: record.sub };
    if (record.email !== undefined) alcore.email = record.email;
    if (record.name !== undefined) alcore.name = record.name;
    if (record.picture !== undefined) alcore.picture = record.picture;
    return alcore;
  };

  const sweepUrlAuthTokens = () => {
    const now = Date.now();
    for (const [token, entry] of urlAuthTokens.entries()) {
      if (!entry || entry.expiresAt <= now) {
        urlAuthTokens.delete(token);
      }
    }
  };

  const issueUrlAuthTokenForSession = (sessionToken, scope = null) => {
    sweepUrlAuthTokens();
    const token = `${URL_AUTH_TOKEN_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
    const expiresAt = Date.now() + URL_AUTH_TOKEN_TTL_MS;
    urlAuthTokens.set(token, { sessionToken, expiresAt, scope });
    return { token, expiresAt };
  };

  const authenticateUrlAuthToken = (req) => {
    const token = getUrlAuthTokenFromRequest(req);
    if (!token || !token.startsWith(URL_AUTH_TOKEN_PREFIX)) return null;
    const entry = urlAuthTokens.get(token);
    if (!entry || entry.expiresAt <= Date.now()) {
      urlAuthTokens.delete(token);
      return null;
    }
    if (!canUseUrlAuthTokenForRequest(req, entry.scope)) return null;
    return { ok: true, sessionToken: entry.sessionToken || 'url:authenticated' };
  };

  /** Scope requested on `POST /auth/url-token`: `?scope=guest:<id>` or `{ scope }` in the body. */
  const readRequestedUrlAuthScope = (req) => parseUrlAuthScope(req?.body?.scope ?? req?.query?.scope);

  const authenticateClientRequest = async (req, { allowUrlToken = true } = {}) => {
    if (allowUrlToken) {
      const urlAuth = authenticateUrlAuthToken(req);
      if (urlAuth) return urlAuth;
    }
    const token = getBearerTokenFromRequest(req);
    if (!token || typeof clientAuthController?.authenticateBearerToken !== 'function') {
      return null;
    }
    try {
      const result = await clientAuthController.authenticateBearerToken(token, req);
      if (result?.ok) {
        return result;
      }
      return null;
    } catch {
      return null;
    }
  };

  const clientSessionToken = (clientAuth) => {
    const raw = clientAuth?.sessionToken || clientAuth?.clientId || clientAuth?.id;
    if (typeof raw === 'string' && (raw.startsWith('client:') || raw.startsWith('url:'))) return raw;
    return typeof raw === 'string' && raw.length > 0 ? `client:${raw}` : 'client:authenticated';
  };

  const clientAuthClientId = (clientAuth) => {
    const raw = clientAuth?.client?.id || clientAuth?.clientId || clientAuth?.id || clientAuth?.sessionToken;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    return raw.startsWith('client:') ? raw.slice('client:'.length) : raw;
  };

  const clientAuthContext = (clientAuth) => ({
    type: 'client',
    token: clientSessionToken(clientAuth),
    clientId: clientAuthClientId(clientAuth),
    client: clientAuth?.client || null,
  });

  let jwtSecret = getOrCreateJwtSecret();
  let passwordBinding = crypto.createHmac('sha256', jwtSecret).update(`alcore:${alcoreIssuerValue}`).digest('hex');
  const resolveSessionTtlMs = (trustDevice) => (trustDevice ? trustedSessionTtlMs : sessionTtlMs);
  let passkeyController = createUiPasskeys({
    passwordBinding,
    readSettingsFromDiskMigrated,
  });

  const rebuildPasskeyController = () => {
    passkeyController.dispose();
    passwordBinding = crypto.createHmac('sha256', jwtSecret).update(`alcore:${alcoreIssuerValue}`).digest('hex');
    passkeyController = createUiPasskeys({
      passwordBinding,
      readSettingsFromDiskMigrated,
    });
  };

  const rotateJwtSecret = () => {
    const nextSecret = crypto.randomBytes(32).toString('hex');
    jwtSecret = persistJwtSecret(nextSecret);
    urlAuthTokens.clear();
    rebuildPasskeyController();
  };

  const getTokenFromRequest = (req) => {
    const cookies = parseCookies(req.headers.cookie);
    const name = sessionCookieNameForRequest(req, cookieName);
    if (cookies[name]) {
      return cookies[name];
    }
    return null;
  };

  const setSessionCookie = (req, res, token, ttlMs) => {
    const secure = isSecureRequest(req);
    const maxAgeSeconds = Math.floor(ttlMs / 1000);
    const header = buildCookie({
      name: sessionCookieNameForRequest(req, cookieName),
      value: encodeURIComponent(token),
      maxAge: maxAgeSeconds,
      secure,
    });
    res.setHeader('Set-Cookie', header);
  };

  const clearSessionCookie = (req, res) => {
    const secure = isSecureRequest(req);
    const header = buildCookie({
      name: sessionCookieNameForRequest(req, cookieName),
      value: '',
      maxAge: 0,
      secure,
    });
    res.setHeader('Set-Cookie', header);
  };

  const isSessionValid = async (token) => {
    if (!token) {
      return false;
    }
    try {
      const { jwtVerify } = await loadJose();
      await jwtVerify(token, jwtSecret);
      return true;
    } catch {
      return false;
    }
  };

  const issueSession = async (req, res, { trustDevice = false } = {}) => {
    const ttlMs = resolveSessionTtlMs(trustDevice);
    const { SignJWT } = await loadJose();
    const token = await new SignJWT({ type: 'ui-session' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(ttlMs / 1000 + 's')
      .sign(jwtSecret);
    setSessionCookie(req, res, token, ttlMs);
    return token;
  };

  startRateLimitCleanup();

  const respondUnauthorized = (req, res) => {
    res.status(401);
    const acceptsJson = req.headers.accept?.includes('application/json');
    if (acceptsJson || req.path?.startsWith('/api')) {
      res.json({ error: 'UI authentication required', locked: true });
    } else {
      res.type('text/plain').send('Authentication required');
    }
  };

  const alcoreSessionToken = (payload) => `alcore:${payload.sub}`;

  const alcoreAuthContext = (payload) => ({
    type: 'alcore',
    token: alcoreSessionToken(payload),
    sub: payload.sub,
    sid: payload.sid,
  });

  const requireAuth = async (req, res, next) => {
    if (req.method === 'OPTIONS') {
      return next();
    }
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      return next();
    }
    if (tryVerifyAlcore(getAlcoreTokenFromRequest(req))) {
      return next();
    }
    const clientAuth = await authenticateClientRequest(req);
    if (clientAuth) {
      return next();
    }
    if (requireClientAuth) {
      return res.status(401).json({ error: 'Client authentication required', locked: true, clientAuthRequired: true });
    }
    clearSessionCookie(req, res);
    return respondUnauthorized(req, res);
  };

  const requireSessionAuth = async (req, res, next) => {
    if (req.method === 'OPTIONS') {
      return next();
    }
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      return next();
    }
    if (tryVerifyAlcore(getAlcoreTokenFromRequest(req))) {
      return next();
    }
    clearSessionCookie(req, res);
    return respondUnauthorized(req, res);
  };

  const handleSessionStatus = async (req, res) => {
    // An explicit bearer credential decides the answer on its own. Native
    // clients probe with the token their runtime transport will actually use;
    // falling back to the ambient session cookie here masked revoked tokens
    // (cookie said "authenticated", every bearer-only API call then 401'd).
    const authorization = req.headers?.authorization;
    const hasBearer = typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ');
    if (hasBearer) {
      const alcore = tryVerifyAlcore(getAlcoreTokenFromRequest(req));
      if (alcore) {
        res.json({ authenticated: true, scope: 'alcore', sub: alcore.sub });
        return;
      }
      const clientAuth = await authenticateClientRequest(req, { allowUrlToken: false });
      if (clientAuth) {
        const bound = readSessionProfileFor(clientSessionToken(clientAuth));
        if (bound !== null) {
          res.json({ authenticated: true, scope: 'client', alcore: profileAlcoreOf(bound) });
          return;
        }
        res.json({ authenticated: true, scope: 'client' });
        return;
      }
      res.status(401).json({ authenticated: false, locked: true });
      return;
    }
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      const bound = readSessionProfileFor(token);
      if (bound !== null) {
        res.json({ authenticated: true, alcore: profileAlcoreOf(bound) });
        return;
      }
      res.json({ authenticated: true });
      return;
    }
    const clientAuth = await authenticateClientRequest(req);
    if (clientAuth) {
      const bound = readSessionProfileFor(clientSessionToken(clientAuth));
      if (bound !== null) {
        res.json({ authenticated: true, scope: 'client', alcore: profileAlcoreOf(bound) });
        return;
      }
      res.json({ authenticated: true, scope: 'client' });
      return;
    }
    if (requireClientAuth) {
      res.status(401).json({ authenticated: false, locked: true, clientAuthRequired: true });
      return;
    }
    clearSessionCookie(req, res);
    res.status(401).json({ authenticated: false, locked: true });
  };

  const resolveAuthenticatedSessionToken = async (req, { allowUrlToken = true } = {}) => {
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      return token;
    }
    const alcore = tryVerifyAlcore(getAlcoreTokenFromRequest(req));
    if (alcore) return alcoreSessionToken(alcore);
    const clientAuth = await authenticateClientRequest(req, { allowUrlToken });
    return clientAuth ? clientSessionToken(clientAuth) : null;
  };

  // Read-only subject for the caller's own Alcore identity: a Bearer
  // Alcore token verifies to its sub; a cookie session reads the sub bound
  // at issuance. Anything else answers ''. Mirrors exactly what
  // handleSessionStatus reports, so the quota proxy's self-only check and
  // the panel's subject agree. Additive: never consulted by validation,
  // and issuance/cookies/TTLs are untouched.
  const resolveRequestAlcoreSub = async (req) => {
    const alcore = tryVerifyAlcore(getAlcoreTokenFromRequest(req));
    if (alcore) return alcore.sub;
    const token = getTokenFromRequest(req);
    if (token && await isSessionValid(token)) {
      const bound = readSessionProfileFor(token);
      return z.string().safeParse(bound?.sub).data ?? '';
    }
    return '';
  };

  const resolveAuthContext = async (req, _res, { allowClientAuth = true, allowUrlToken = true } = {}) => {
    const token = getTokenFromRequest(req);
    if (await isSessionValid(token)) {
      return { type: 'session', token };
    }
    const alcore = tryVerifyAlcore(getAlcoreTokenFromRequest(req));
    if (alcore) return alcoreAuthContext(alcore);
    if (!allowClientAuth) return null;
    const clientAuth = await authenticateClientRequest(req, { allowUrlToken });
    return clientAuth ? clientAuthContext(clientAuth) : null;
  };

  const handleUrlAuthToken = async (req, res) => {
    const scope = readRequestedUrlAuthScope(req);
    if (scope === undefined) {
      return res.status(400).json({ error: 'Unknown URL token scope' });
    }
    const sessionToken = await resolveAuthenticatedSessionToken(req, { allowUrlToken: false });
    if (!sessionToken) {
      clearSessionCookie(req, res);
      return respondUnauthorized(req, res);
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json(issueUrlAuthTokenForSession(sessionToken, scope));
  };

  const handleSessionCreate = async (req, res) => {
    const rateLimitResult = await checkRateLimit(req);

    res.setHeader('X-RateLimit-Limit', rateLimitResult.limit);
    res.setHeader('X-RateLimit-Remaining', rateLimitResult.remaining);
    res.setHeader('X-RateLimit-Reset', rateLimitResult.reset);

    if (!rateLimitResult.allowed) {
      res.setHeader('Retry-After', rateLimitResult.retryAfter);
      res.status(429).json({ 
        error: 'Too many login attempts, please try again later',
        retryAfter: rateLimitResult.retryAfter 
      });
      return;
    }

    const alcore = tryVerifyAlcore(readAlcoreLoginToken(req));
    if (!alcore) {
      await recordFailedAttempt(req);
      clearSessionCookie(req, res);
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    await issueVerifiedAlcoreSession(req, res, alcore);
  };

  // Shared issuance tail for verified Alcore identities: session cookie,
  // TTLs, and optional client tokens stay on this one path no matter how
  // the identity was verified (local HMAC above, service introspection in
  // the desktop login below). A login-time profile in the session body is
  // bound to the issued session here (cookie token, plus the desktop client
  // id when one is minted alongside) for the status read-through above.
  const issueVerifiedAlcoreSession = async (req, res, alcore) => {
    await clearRateLimit(req);

    const trustDevice = isTrustedDeviceRequest(req.body?.trustDevice);
    const ttlMs = resolveSessionTtlMs(trustDevice);
    const sessionToken = await issueSession(req, res, { trustDevice });
    let clientTokenResult = null;
    if (req.body?.issueClientToken === true && typeof clientAuthController?.createClient === 'function') {
      clientTokenResult = await clientAuthController.createClient({
        fallbackLabel: req.body?.clientLabel,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        clientKind: req.body?.clientKind,
        dedupeKey: req.body?.dedupeKey,
        authMethod: 'alcore',
        deviceName: req.body?.deviceName,
        devicePlatform: req.body?.devicePlatform,
        deviceModel: req.body?.deviceModel,
        appVersion: req.body?.appVersion,
      });
    }
    const loginProfile = readSessionProfile(req);
    if (loginProfile !== null) {
      const bindings = [sessionToken];
      const clientBinding = clientBindingOf(clientTokenResult);
      if (clientBinding !== null) bindings.push(clientBinding);
      rememberSessionProfile(bindings, { sub: alcore.sub, ...loginProfile }, ttlMs);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      authenticated: true,
      alcore: { sub: alcore.sub, sid: alcore.sid },
      ...(clientTokenResult?.token ? { clientToken: clientTokenResult.token, client: clientTokenResult.client } : {}),
    });
  };

  // Desktop login without a local Alcore secret (packaged app): the caller
  // confirmed the service pair against the service itself (GET /auth/me
  // introspection over the service TLS connection) and passes the confirmed
  // identity in. Same rate limits and issuance as the local-verify path;
  // malformed identities fail closed without touching the session.
  const handleServiceVerifiedSessionCreate = async (req, res, verified) => {
    const rateLimitResult = await checkRateLimit(req);

    res.setHeader('X-RateLimit-Limit', rateLimitResult.limit);
    res.setHeader('X-RateLimit-Remaining', rateLimitResult.remaining);
    res.setHeader('X-RateLimit-Reset', rateLimitResult.reset);

    if (!rateLimitResult.allowed) {
      res.setHeader('Retry-After', rateLimitResult.retryAfter);
      res.status(429).json({
        error: 'Too many login attempts, please try again later',
        retryAfter: rateLimitResult.retryAfter
      });
      return;
    }

    const parsedIdentity = serviceVerifiedIdentitySchema.safeParse(verified);
    const sub = parsedIdentity.success ? parsedIdentity.data.sub.trim() : '';
    const sid = parsedIdentity.success ? parsedIdentity.data.sid.trim() : '';
    if (!sub || !sid) {
      await recordFailedAttempt(req);
      clearSessionCookie(req, res);
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    await issueVerifiedAlcoreSession(req, res, { sub, sid });
  };

  const respondPasskeyError = (res, error) => {
    const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : 400;
    res.status(statusCode).json({ error: error?.message || 'Passkey request failed' });
  };

  const handlePasskeyStatus = (req, res) => {
    try {
      res.json(passkeyController.getStatus(req));
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyRegistrationOptions = async (req, res) => {
    try {
      const label = typeof req.body?.label === 'string' ? req.body.label : '';
      const options = await passkeyController.beginRegistration(req, { label });
      res.json(options);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyRegistrationVerify = async (req, res) => {
    try {
      const result = await passkeyController.finishRegistration(req.body);
      res.json(result);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyAuthenticationOptions = async (req, res) => {
    try {
      const options = await passkeyController.beginAuthentication(req);
      res.json(options);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyAuthenticationVerify = async (req, res) => {
    try {
      await passkeyController.finishAuthentication(req.body);
      const trustDevice = isTrustedDeviceRequest(req.body?.trustDevice);
      const ttlMs = resolveSessionTtlMs(trustDevice);
      await issueSession(req, res, { trustDevice });
      let clientTokenResult = null;
      if (req.body?.issueClientToken === true && typeof clientAuthController?.createClient === 'function') {
        clientTokenResult = await clientAuthController.createClient({
          fallbackLabel: req.body?.clientLabel,
          expiresAt: new Date(Date.now() + ttlMs).toISOString(),
          clientKind: req.body?.clientKind,
          dedupeKey: req.body?.dedupeKey,
          authMethod: 'passkey',
          deviceName: req.body?.deviceName,
          devicePlatform: req.body?.devicePlatform,
          deviceModel: req.body?.deviceModel,
          appVersion: req.body?.appVersion,
        });
      }
      res.json({
        authenticated: true,
        ...(clientTokenResult?.token ? { clientToken: clientTokenResult.token, client: clientTokenResult.client } : {}),
      });
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyList = (req, res) => {
    try {
      res.json({ passkeys: passkeyController.listPasskeys(req) });
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handlePasskeyRevoke = (req, res) => {
    try {
      const result = passkeyController.revokePasskey(req, req.params?.id);
      res.json(result);
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const handleResetAuth = (req, res) => {
    try {
      const passkeyResult = passkeyController.clearAllPasskeys();
      sessionProfiles.clear();
      rotateJwtSecret();
      clearSessionCookie(req, res);
      res.json({
        cleared: true,
        clearedPasskeys: passkeyResult.clearedCount,
        signedOutEverywhere: true,
      });
    } catch (error) {
      respondPasskeyError(res, error);
    }
  };

  const dispose = () => {
    loginRateLimiter.clear();
    sessionProfiles.clear();
    if (rateLimitCleanupTimer) {
      clearInterval(rateLimitCleanupTimer);
      rateLimitCleanupTimer = null;
    }
    passkeyController.dispose();
  };

  return {
    enabled: true,
    requireAuth,
    requireSessionAuth,
    resolveAuthContext,
    resolveRequestAlcoreSub,
    handleSessionStatus,
    handleSessionCreate,
    handleServiceVerifiedSessionCreate,
    handleUrlAuthToken,
    handlePasskeyStatus,
    handlePasskeyRegistrationOptions,
    handlePasskeyRegistrationVerify,
    handlePasskeyAuthenticationOptions,
    handlePasskeyAuthenticationVerify,
    handlePasskeyList,
    handlePasskeyRevoke,
    handleResetAuth,
    ensureSessionToken: (req, _res) => {
      const urlAuth = authenticateUrlAuthToken(req);
      if (urlAuth) return clientSessionToken(urlAuth);
      return resolveAuthenticatedSessionToken(req);
    },
    dispose,
  };
};

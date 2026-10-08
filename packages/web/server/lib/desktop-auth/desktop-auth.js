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
// - Google: the system browser opens a loopback GIS page served here; the
//   Google credential returns to the loopback capture endpoint and the app
//   completes the login by polling. The renderer never sees credentials, and
//   no service URL is hardcoded in UI code (the server derives it from the
//   Alcore issuer it already verifies against).
//
// Privacy: request bodies may carry passwords and ID tokens. Nothing here
// logs them. Service `Set-Cookie` headers are never forwarded: every handler
// answers with its own `res.status().json()`, so no upstream header survives.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

import { readAlcoreIssuer, readAlcoreKeys } from '../ui-auth/ui-auth.js';

const SERVICE_TIMEOUT_MS = 15_000;
const GOOGLE_CAPTURE_TTL_MS = 5 * 60 * 1000;
const GOOGLE_CLIENT_CACHE_TTL_MS = 10 * 60 * 1000;
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
const idTokenSchema = z.string().min(1).max(8192);
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

const googleCaptureSchema = z.object({
  requestId: requestIdSchema,
  idToken: idTokenSchema,
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

  // Session-issuing handlers fail fast here so a login attempt never spends
  // a service round trip (and never sends the user's credential onward) when
  // this server could not verify the resulting pair anyway.

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

  // Convert a service session pair into an IDE UI session through the one
  // login path that owns cookies, TTLs, and client tokens. Fails closed when
  // this server cannot verify Alcore tokens (no shared secret configured).
  const completeWithServicePair = (req, res, pair, sessionOpts) => {
    if (!hasAlcoreSecret()) {
      return res.status(503).json({ error: 'alcore_not_configured' });
    }
    const token = pair && typeof pair.access_token === 'string' ? pair.access_token.trim() : '';
    if (token === '') {
      return res.status(502).json({ error: 'unavailable' });
    }
    req.body = {
      alcoreToken: token,
      ...(sessionOpts.trustDevice === true ? { trustDevice: true } : {}),
      ...(sessionOpts.issueClientToken === true ? { issueClientToken: true } : {}),
      ...optionalSessionFields(sessionOpts),
    };
    return uiAuthController.handleSessionCreate(req, res);
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

  const escapeJsonForHtml = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

  const googlePage = (requestId, clientId) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in with Google — OpenChamber</title>
<script src="https://accounts.google.com/gsi/client" async defer></script>
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#131110;color:#fafaf9}.card{text-align:center;max-width:22rem;padding:2rem}#status{margin-top:1rem;min-height:1.5rem;color:#a8a29e}#done{color:#4ade80}</style>
</head>
<body><div class="card">
<h1>Sign in with Google</h1>
<p>Choose the Google account for OpenChamber Desktop.</p>
<div id="button"></div>
<p id="status" role="status"></p>
</div><script>
const CONTEXT = ${escapeJsonForHtml({ requestId, clientId })};
const statusEl = document.getElementById('status');
const say = (text, done) => { statusEl.textContent = text; if (done) statusEl.id = 'done'; };
async function onCredential(response) {
  const credential = response && response.credential ? String(response.credential) : '';
  if (!credential) { say('Google did not return a credential. Close this tab and try again.'); return; }
  say('Verifying…');
  try {
    const res = await fetch('/api/auth/desktop/google-capture', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ requestId: CONTEXT.requestId, idToken: credential }),
    });
    if (!res.ok) throw new Error('capture ' + res.status);
    say('Signed in — return to the OpenChamber app.', true);
  } catch (error) {
    say('Could not reach the app. Keep it open and try again.');
  }
}
function boot() {
  if (!window.google || !google.accounts || !google.accounts.id) { setTimeout(boot, 200); return; }
  try {
    google.accounts.id.initialize({ client_id: CONTEXT.clientId, callback: onCredential });
    google.accounts.id.renderButton(document.getElementById('button'), { theme: 'filled_black', size: 'large', width: 280 });
  } catch (error) {
    say('Google sign-in failed to start. Close this tab and try again.');
  }
}
boot();
</script></body></html>`;

  const registerRoutes = ({ get, post }, { express, tunnelAuthController }) => {
    const json = express.json({ limit: JSON_BODY_LIMIT });

    get('/api/auth/desktop/config', async (req, res) => {
      const clientId = await fetchGoogleClientId();
      res.setHeader('Cache-Control', 'no-store');
      res.json({ googleConfigured: clientId !== '' });
    });

    post('/api/auth/desktop/email/login', json, async (req, res) => {
      if (isTunnelScope(tunnelAuthController, req)) return tunnelRefusal(res, 'Email login');
      if (!hasAlcoreSecret()) return res.status(503).json({ error: 'alcore_not_configured' });
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
      if (!hasAlcoreSecret()) return res.status(503).json({ error: 'alcore_not_configured' });
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
      sweepGoogle();
      const requestId = randomBytes(16).toString('hex');
      pendingGoogle.set(requestId, { idToken: null, expiresAt: now() + GOOGLE_CAPTURE_TTL_MS });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ requestId, pageUrl: `/auth/desktop-google?requestId=${requestId}` });
    });

    get('/auth/desktop-google', async (req, res) => {
      const requestId = typeof req?.query?.requestId === 'string' ? req.query.requestId : '';
      if (!requestIdSchema.safeParse(requestId).success) {
        return res.status(400).send('Invalid sign-in link. Restart Google login from the app.');
      }
      sweepGoogle();
      const pending = pendingGoogle.get(requestId);
      if (!pending) {
        return res.status(410).send('This sign-in link expired. Restart Google login from the app.');
      }
      const clientId = await fetchGoogleClientId();
      if (clientId === '') {
        return res.status(503).send('Google login is not configured. Restart Google login from the app later.');
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(googlePage(requestId, clientId));
    });

    post('/api/auth/desktop/google-capture', json, async (req, res) => {
      if (isTunnelScope(tunnelAuthController, req)) return tunnelRefusal(res, 'Google login');
      const parsed = googleCaptureSchema.safeParse(req?.body);
      if (!parsed.success) return badRequest(res, 'invalid_request');
      sweepGoogle();
      const pending = pendingGoogle.get(parsed.data.requestId);
      if (!pending || pending.idToken !== null) {
        return res.status(404).json({ error: 'unknown_request' });
      }
      pending.idToken = parsed.data.idToken;
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true });
    });

    post('/api/auth/desktop/google-complete', json, async (req, res) => {
      if (isTunnelScope(tunnelAuthController, req)) return tunnelRefusal(res, 'Google login');
      if (!hasAlcoreSecret()) return res.status(503).json({ error: 'alcore_not_configured' });
      const parsed = googleCompleteSchema.safeParse(req?.body);
      if (!parsed.success) return badRequest(res, 'invalid_request');
      sweepGoogle();
      const pending = pendingGoogle.get(parsed.data.requestId);
      // Single-use: consume before verifying so a replay races nothing.
      if (pending) pendingGoogle.delete(parsed.data.requestId);
      if (!pending || pending.idToken === null) {
        return res.status(404).json({ error: 'no_credential' });
      }
      let service;
      try {
        service = await callAuthService('/auth/google/verify', { idToken: pending.idToken });
      } catch {
        return res.status(502).json({ error: 'unavailable' });
      }
      if (service.status === 200) {
        return completeWithServicePair(req, res, service.data, sessionOptsOf(parsed.data));
      }
      return passthroughStatus(res, service.status, service.data, 'invalid_request');
    });
  };

  return {
    registerRoutes,
    serviceBase,
    // Test seams (not routes).
    _pendingGoogle: pendingGoogle,
    _sweepGoogle: sweepGoogle,
  };
};

import { describe, expect, test } from 'bun:test';

import { createDesktopAuthRuntime } from './desktop-auth.js';

// Desktop sign-in proxies translate Alcore auth-service pairs into IDE UI
// sessions through the existing session handler. The service is stubbed;
// session issuance is observed through a fake uiAuthController.
const SERVICE_PAIR = {
  access_token: 'svc-access-token',
  refresh_token: 'svc-refresh',
  token_type: 'Bearer',
  expires_in: 900,
};

const mockRes = () => {
  const headers = {};
  const res = {
    statusCode: 200,
    body: undefined,
    text: undefined,
    setHeader: (name, value) => {
      headers[String(name).toLowerCase()] = value;
    },
    status: (code) => {
      res.statusCode = code;
      return res;
    },
    json: (payload) => {
      res.body = payload;
      return res;
    },
    send: (payload) => {
      res.text = payload;
      return res;
    },
  };
  return { res, headers };
};

const fakeExpress = { json: () => (_req, _res, next) => (typeof next === 'function' ? next() : undefined) };

const createHarness = ({
  serviceImpl,
  tunnelScope = null,
  alcoreSecret = 'test-alcore-secret-32-chars-long!!',
} = {}) => {
  const routes = new Map();
  const seenSessions = [];
  const seenVerified = [];
  const serviceCalls = [];
  const serviceFetch = async (url, init) => {
    serviceCalls.push({ url, init });
    return serviceImpl(url, init);
  };
  const serviceJson = (status, data) => ({
    status,
    json: async () => data,
  });
  const runtime = createDesktopAuthRuntime({
    uiAuthController: {
      handleSessionCreate: async (req, res) => {
        seenSessions.push(req.body);
        return res.status(200).json({ authenticated: true, alcore: { sub: 'user-1', sid: 'sess-1' } });
      },
      handleServiceVerifiedSessionCreate: async (req, res, verified) => {
        seenSessions.push(req.body);
        seenVerified.push(verified);
        return res.status(200).json({ authenticated: true, alcore: { sub: verified.sub, sid: verified.sid } });
      },
    },
    alcoreSecret,
    serviceFetch,
  });
  runtime.registerRoutes(
    {
      get: (path, ...handlers) => routes.set(`GET ${path}`, handlers),
      post: (path, ...handlers) => routes.set(`POST ${path}`, handlers),
    },
    {
      express: fakeExpress,
      tunnelAuthController: { classifyRequestScope: () => tunnelScope },
    },
  );
  const call = async (method, path, { body, query, headers } = {}) => {
    const handlers = routes.get(`${method} ${path}`);
    if (!handlers) throw new Error(`no route ${method} ${path}`);
    const { res, headers: resHeaders } = mockRes();
    const mergedHeaders = { host: '127.0.0.1:57123', ...(headers ?? {}) };
    const req = {
      body,
      query: query ?? {},
      headers: mergedHeaders,
      get: (name) => mergedHeaders[String(name).toLowerCase()],
    };
    // Last handler is the route logic; earlier entries are body-parsing middleware.
    await handlers[handlers.length - 1](req, res);
    return { res, headers: resHeaders };
  };
  return { call, seenSessions, seenVerified, serviceCalls, serviceJson, runtime };
};

describe('desktop auth config', () => {
  test('reports Google configured when the service has a client id', async () => {
    const h = createHarness({
      serviceImpl: async () => h.serviceJson(200, { clientId: 'google-client-123' }),
    });
    const { res } = await h.call('GET', '/api/auth/desktop/config');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ googleConfigured: true });
  });

  test('reports Google unconfigured when the service is unreachable', async () => {
    const h = createHarness({
      serviceImpl: async () => { throw new Error('down'); },
    });
    const { res } = await h.call('GET', '/api/auth/desktop/config');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ googleConfigured: false });
  });
});

describe('desktop email proxies', () => {
  test('converts a service pair into the session login body', async () => {
    const h = createHarness({
      serviceImpl: async (url, init) => {
        expect(url).toBe('https://auth.alcore.io.vn/auth/login');
        expect(JSON.parse(init.body)).toEqual({ email: 'a@example.test', password: 's3cret!!' });
        return h.serviceJson(200, SERVICE_PAIR);
      },
    });
    const { res, headers } = await h.call('POST', '/api/auth/desktop/email/login', {
      body: {
        email: 'A@Example.Test ', password: 's3cret!!', trustDevice: true, issueClientToken: true, clientLabel: 'OpenChamber Desktop',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ authenticated: true });
    expect(h.seenSessions).toHaveLength(1);
    expect(h.seenSessions[0]).toMatchObject({
      alcoreToken: 'svc-access-token',
      trustDevice: true,
      issueClientToken: true,
      clientLabel: 'OpenChamber Desktop',
    });
    expect(headers['set-cookie']).toBeUndefined();
  });

  test('passes service login failures through with their status', async () => {
    for (const [serviceStatus, serviceBody] of [
      [401, { error: 'invalid_credentials' }],
      [403, { error: 'email_not_verified' }],
    ]) {
      const h = createHarness({
        serviceImpl: async () => h.serviceJson(serviceStatus, serviceBody),
      });
      const { res } = await h.call('POST', '/api/auth/desktop/email/login', {
        body: { email: 'a@example.test', password: 'wrong' },
      });
      expect(res.statusCode).toBe(serviceStatus);
      expect(res.body).toEqual(serviceBody);
      expect(h.seenSessions).toHaveLength(0);
    }
  });

  test('forwards rate limits with the retry hint', async () => {
    const h = createHarness({
      serviceImpl: async () => h.serviceJson(429, { error: 'slow_down', retryAfter: 42 }),
    });
    const { res, headers } = await h.call('POST', '/api/auth/desktop/email/login', {
      body: { email: 'a@example.test', password: 'x' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.body.retryAfter).toBe(42);
    expect(headers['retry-after']).toBe(42);
  });

  test('confirms the pair with the service when no Alcore secret is configured', async () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'user-7', sid: 'sess-9' })).toString('base64url');
    const token = `header.${payload}.sig`;
    const h = createHarness({
      alcoreSecret: '',
      serviceImpl: async (url, init) => {
        if (url === 'https://auth.alcore.io.vn/auth/login') {
          return h.serviceJson(200, { ...SERVICE_PAIR, access_token: token });
        }
        if (url === 'https://auth.alcore.io.vn/auth/me') {
          expect(init.method).toBe('GET');
          expect(init.headers.Authorization).toBe(`Bearer ${token}`);
          return h.serviceJson(200, { id: 'user-7', email: 'a@example.test', emailVerified: true });
        }
        throw new Error(`unexpected service call ${url}`);
      },
    });
    const { res } = await h.call('POST', '/api/auth/desktop/email/login', {
      body: { email: 'a@example.test', password: 'x', trustDevice: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ authenticated: true });
    expect(h.seenSessions).toHaveLength(1);
    expect(h.seenSessions[0]).toMatchObject({ trustDevice: true });
    expect(h.seenSessions[0].alcoreToken).toBeUndefined();
    expect(h.seenVerified).toEqual([{ sub: 'user-7', sid: 'sess-9' }]);
  });

  test('fails closed when the service cannot confirm the pair', async () => {
    const h = createHarness({
      alcoreSecret: '',
      serviceImpl: async (url) => {
        if (url === 'https://auth.alcore.io.vn/auth/login') return h.serviceJson(200, SERVICE_PAIR);
        return h.serviceJson(401, { error: 'unauthorized' });
      },
    });
    const { res } = await h.call('POST', '/api/auth/desktop/email/login', {
      body: { email: 'a@example.test', password: 'x' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'unavailable' });
    expect(h.seenSessions).toHaveLength(0);
  });

  test('rejects a pair without an access token instead of opening a session', async () => {
    const h = createHarness({
      serviceImpl: async () => h.serviceJson(200, { refresh_token: 'only' }),
    });
    const { res } = await h.call('POST', '/api/auth/desktop/email/login', {
      body: { email: 'a@example.test', password: 'x' },
    });
    expect(res.statusCode).toBe(502);
    expect(h.seenSessions).toHaveLength(0);
  });

  test('answers an unreachable service as unavailable', async () => {
    const h = createHarness({
      serviceImpl: async () => { throw new Error('down'); },
    });
    const { res } = await h.call('POST', '/api/auth/desktop/email/login', {
      body: { email: 'a@example.test', password: 'x' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'unavailable' });
  });

  test('rejects malformed login bodies', async () => {
    const h = createHarness({ serviceImpl: async () => h.serviceJson(200, SERVICE_PAIR) });
    for (const body of [{}, { email: 'a@example.test' }, { email: 'x', password: 'y' }]) {
      const { res } = await h.call('POST', '/api/auth/desktop/email/login', { body });
      expect(res.statusCode).toBe(400);
    }
    expect(h.serviceCalls).toHaveLength(0);
  });

  test('passes registration outcomes through without opening a session', async () => {
    for (const [serviceStatus, serviceBody] of [
      [202, { pending: true, otpRequired: true, email: 'n@example.test' }],
      [409, { error: 'email_taken' }],
    ]) {
      const h = createHarness({
        serviceImpl: async (url) => {
          expect(url).toBe('https://auth.alcore.io.vn/auth/register');
          return h.serviceJson(serviceStatus, serviceBody);
        },
      });
      const { res } = await h.call('POST', '/api/auth/desktop/email/register', {
        body: { email: 'n@example.test', password: 's3cret!!' },
      });
      expect(res.statusCode).toBe(serviceStatus);
      expect(res.body).toEqual(serviceBody);
      expect(h.seenSessions).toHaveLength(0);
    }
  });

  test('converts a verified OTP code into a session, rejects a bad code', async () => {
    const ok = createHarness({
      serviceImpl: async (url, init) => {
        expect(url).toBe('https://auth.alcore.io.vn/auth/verify-otp');
        expect(JSON.parse(init.body)).toEqual({ email: 'n@example.test', code: '123456' });
        return ok.serviceJson(200, SERVICE_PAIR);
      },
    });
    const good = await ok.call('POST', '/api/auth/desktop/email/verify-otp', {
      body: { email: 'n@example.test', code: '123456', trustDevice: true },
    });
    expect(good.res.statusCode).toBe(200);
    expect(ok.seenSessions).toHaveLength(1);
    expect(ok.seenSessions[0]).toMatchObject({ alcoreToken: 'svc-access-token', trustDevice: true });

    const bad = createHarness({
      serviceImpl: async () => bad.serviceJson(400, { error: 'invalid_code' }),
    });
    const denied = await bad.call('POST', '/api/auth/desktop/email/verify-otp', {
      body: { email: 'n@example.test', code: '000000' },
    });
    expect(denied.res.statusCode).toBe(400);
    expect(denied.res.body).toEqual({ error: 'invalid_code' });
    expect(bad.seenSessions).toHaveLength(0);
  });

  test('resends codes as a dumb pipe', async () => {
    const h = createHarness({
      serviceImpl: async (url) => {
        expect(url).toBe('https://auth.alcore.io.vn/auth/otp-resend');
        return h.serviceJson(200, { ok: true });
      },
    });
    const { res } = await h.call('POST', '/api/auth/desktop/email/otp-resend', {
      body: { email: 'n@example.test' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('desktop google loopback', () => {
  const LOOPBACK_REDIRECT = 'http://127.0.0.1:57123/auth/desktop-google/callback';

  const startOk = async (h) => {
    const started = await h.call('POST', '/api/auth/desktop/google/start', { body: {} });
    expect(started.res.statusCode).toBe(200);
    const { requestId, googleUrl } = started.res.body;
    expect(requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(started.res.body.pageUrl).toBeUndefined();
    const parsed = new URL(googleUrl);
    expect(parsed.origin).toBe('https://accounts.google.com');
    expect(parsed.pathname).toBe('/o/oauth2/v2/auth');
    expect(parsed.searchParams.get('client_id')).toBe('google-client-123');
    expect(parsed.searchParams.get('redirect_uri')).toBe(LOOPBACK_REDIRECT);
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('state')).toBe(requestId);
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge') ?? '').toMatch(/^[A-Za-z0-9-_]{43}$/);
    expect(parsed.searchParams.get('nonce') ?? '').toMatch(/^[0-9a-f]{32}$/);
    return { requestId };
  };

  const okJson = (data) => ({ status: 200, json: async () => data });

  const configService = () => async (url) => {
    expect(url).toBe('https://auth.alcore.io.vn/auth/google/config');
    return okJson({ clientId: 'google-client-123' });
  };

  const exchangeService = (seen) => async (url, init) => {
    if (url === 'https://auth.alcore.io.vn/auth/google/config') {
      return okJson({ clientId: 'google-client-123' });
    }
    expect(url).toBe('https://auth.alcore.io.vn/auth/google/desktop-code');
    const body = JSON.parse(init.body);
    expect(body.code).toBe('loopback-code');
    expect(body.redirect_uri).toBe(LOOPBACK_REDIRECT);
    expect(body.code_verifier).toMatch(/^[A-Za-z0-9\-._~]{43}$/);
    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
    seen.push(body);
    return okJson({ access_token: 'desktop-access-token' });
  };

  test('fails fast when Google is not configured', async () => {
    const h = createHarness({
      serviceImpl: async () => h.serviceJson(200, { clientId: '' }),
    });
    const { res } = await h.call('POST', '/api/auth/desktop/google/start', { body: {} });
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'google_not_configured' });
  });

  test('refuses non-loopback and missing hosts instead of minting a redirect', async () => {
    const h = createHarness({ serviceImpl: configService() });
    for (const headers of [{ host: 'example.com:443' }, { host: '' }, { host: undefined }]) {
      const { res } = await h.call('POST', '/api/auth/desktop/google/start', { body: {}, headers });
      expect(res.statusCode).toBe(500);
    }
    expect(h.serviceCalls).toHaveLength(1);
  });

  test('rejects malformed, declined, and unknown callbacks without exchanging', async () => {
    const h = createHarness({ serviceImpl: configService() });
    const { requestId } = await startOk(h);
    const callsBefore = h.serviceCalls.length;
    for (const [query, status, step, code] of [
      [{}, 400, 'callback', 'invalid_request'],
      [{ state: 'nope', code: 'x' }, 400, 'callback', 'invalid_request'],
      [{ state: requestId }, 400, 'callback', 'invalid_request'],
      [{ state: requestId, code: 'x', error: 'access_denied' }, 400, 'google', 'google_oauth_error'],
      [{ state: 'b'.repeat(32), code: 'x' }, 410, 'callback', 'invalid_state'],
    ]) {
      const { res } = await h.call('GET', '/auth/desktop-google/callback', { query });
      expect(res.statusCode).toBe(status);
      expect(res.text).toContain('Sign in with Google');
      expect(res.text).toContain(`data-auth-error="${code}"`);
      expect(res.text).toContain(`${step} · ${code}`);
    }
    expect(h.serviceCalls).toHaveLength(callsBefore);
  });

  test('captures the loopback code once and completes into a session', async () => {
    const seen = [];
    const h = createHarness({ serviceImpl: exchangeService(seen) });
    const { requestId } = await startOk(h);

    const landed = await h.call('GET', '/auth/desktop-google/callback', {
      query: { state: requestId, code: 'loopback-code' },
    });
    expect(landed.res.statusCode).toBe(200);
    expect(landed.res.text).toContain('return to the OpenChamber app');
    expect(seen).toHaveLength(1);

    // Double navigation after capture: idempotent success, no second exchange.
    const replay = await h.call('GET', '/auth/desktop-google/callback', {
      query: { state: requestId, code: 'loopback-code' },
    });
    expect(replay.res.statusCode).toBe(200);
    expect(seen).toHaveLength(1);

    const done = await h.call('POST', '/api/auth/desktop/google-complete', {
      body: { requestId, trustDevice: true, issueClientToken: true, clientLabel: 'OpenChamber Desktop' },
    });
    expect(done.res.statusCode).toBe(200);
    expect(h.seenSessions).toHaveLength(1);
    expect(h.seenSessions[0]).toMatchObject({
      alcoreToken: 'desktop-access-token',
      trustDevice: true,
      issueClientToken: true,
      clientLabel: 'OpenChamber Desktop',
    });

    const twice = await h.call('POST', '/api/auth/desktop/google-complete', { body: { requestId } });
    expect(twice.res.statusCode).toBe(404);
    expect(h.seenSessions).toHaveLength(1);
  });

  test('completing before the callback waits with 404 and never exchanges', async () => {
    const h = createHarness({ serviceImpl: configService() });
    const { requestId } = await startOk(h);
    const callsBefore = h.serviceCalls.length;
    const { res } = await h.call('POST', '/api/auth/desktop/google-complete', { body: { requestId } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'no_credential' });
    expect(h.serviceCalls).toHaveLength(callsBefore);
  });

  test('pre-callback polls retain the pending login until the callback lands', async () => {
    // Regression: the renderer polls every 2 s while the user is still
    // inside Google's dance, so polls arrive before the loopback callback.
    // Those still-waiting polls must answer 404 WITHOUT consuming the
    // single-use entry, or the later callback always misses (invalid_state).
    const seen = [];
    const h = createHarness({ serviceImpl: exchangeService(seen) });
    const { requestId } = await startOk(h);
    const callsBefore = h.serviceCalls.length;

    for (let poll = 0; poll < 2; poll += 1) {
      const waiting = await h.call('POST', '/api/auth/desktop/google-complete', { body: { requestId } });
      expect(waiting.res.statusCode).toBe(404);
      expect(waiting.res.body).toEqual({ error: 'no_credential' });
    }
    expect(h.serviceCalls).toHaveLength(callsBefore);

    const landed = await h.call('GET', '/auth/desktop-google/callback', {
      query: { state: requestId, code: 'loopback-code' },
    });
    expect(landed.res.statusCode).toBe(200);
    expect(landed.res.text).toContain('return to the OpenChamber app');
    expect(seen).toHaveLength(1);

    const done = await h.call('POST', '/api/auth/desktop/google-complete', { body: { requestId } });
    expect(done.res.statusCode).toBe(200);
    expect(h.seenSessions).toHaveLength(1);

    const replay = await h.call('POST', '/api/auth/desktop/google-complete', { body: { requestId } });
    expect(replay.res.statusCode).toBe(404);
    expect(replay.res.body).toEqual({ error: 'no_credential' });
    expect(h.seenSessions).toHaveLength(1);
  });

  test('expired and consumed logins fail closed with named errors', async () => {
    const seen = [];
    const h = createHarness({ serviceImpl: exchangeService(seen) });
    const { requestId } = await startOk(h);
    h.runtime._pendingGoogle.get(requestId).expiresAt = Date.now() - 1;

    const gone = await h.call('POST', '/api/auth/desktop/google-complete', { body: { requestId } });
    expect(gone.res.statusCode).toBe(404);
    expect(gone.res.body).toEqual({ error: 'no_credential' });

    const late = await h.call('GET', '/auth/desktop-google/callback', {
      query: { state: requestId, code: 'loopback-code' },
    });
    expect(late.res.statusCode).toBe(410);
    expect(late.res.text).toContain('callback · invalid_state');
    expect(seen).toHaveLength(0);
    expect(h.seenSessions).toHaveLength(0);
  });

  test('maps a refused exchange to a named failure the poll reads once', async () => {
    for (const [serviceStatus, serviceBody, pageStatus, code] of [
      [401, { error: 'invalid_google_credential' }, 401, 'invalid_google_credential'],
      [409, { error: 'identity_conflict' }, 409, 'identity_conflict'],
      [503, { error: 'google_not_configured' }, 503, 'google_not_configured'],
    ]) {
      const h = createHarness({
        serviceImpl: async (url) => {
          if (url.endsWith('/auth/google/config')) return h.serviceJson(200, { clientId: 'google-client-123' });
          return h.serviceJson(serviceStatus, serviceBody);
        },
      });
      const { requestId } = await startOk(h);
      const landed = await h.call('GET', '/auth/desktop-google/callback', {
        query: { state: requestId, code: 'loopback-code' },
      });
      expect(landed.res.statusCode).toBe(pageStatus);
      expect(landed.res.text).toContain('Sign in with Google');
      expect(landed.res.text).toContain(`data-auth-error="${code}"`);
      expect(landed.res.text).toContain(`exchange · ${code}`);
      // A repeat navigation re-renders the same named page, no second exchange.
      const again = await h.call('GET', '/auth/desktop-google/callback', {
        query: { state: requestId, code: 'loopback-code' },
      });
      expect(again.res.statusCode).toBe(pageStatus);
      expect(again.res.text).toContain(`exchange · ${code}`);
      // The app poll reads the terminal failure once, then waits again.
      const failed = await h.call('POST', '/api/auth/desktop/google-complete', { body: { requestId } });
      expect(failed.res.statusCode).toBe(pageStatus);
      expect(failed.res.body).toEqual({ error: code, step: 'exchange' });
      expect(h.seenSessions).toHaveLength(0);
      const after = await h.call('POST', '/api/auth/desktop/google-complete', { body: { requestId } });
      expect(after.res.statusCode).toBe(404);
      expect(after.res.body).toEqual({ error: 'no_credential' });
    }
  });

  test('names a missing desktop-code endpoint instead of blaming the credential', async () => {
    // The deployed service predates POST /auth/google/desktop-code: it
    // answers 404 with a non-JSON body. The callback must name the
    // endpoint gap (step exchange, service 404), not invalid credentials.
    const h = createHarness({
      serviceImpl: async (url) => {
        if (url.endsWith('/auth/google/config')) return h.serviceJson(200, { clientId: 'google-client-123' });
        return { status: 404, json: async () => { throw new Error('not json'); } };
      },
    });
    const { requestId } = await startOk(h);
    const landed = await h.call('GET', '/auth/desktop-google/callback', {
      query: { state: requestId, code: 'loopback-code' },
    });
    expect(landed.res.statusCode).toBe(502);
    expect(landed.res.text).toContain('data-auth-error="desktop_code_unavailable"');
    expect(landed.res.text).toContain('exchange · desktop_code_unavailable');
    expect(landed.res.text).toContain('service 404');
    const failed = await h.call('POST', '/api/auth/desktop/google-complete', { body: { requestId } });
    expect(failed.res.statusCode).toBe(502);
    expect(failed.res.body).toEqual({ error: 'desktop_code_unavailable', step: 'exchange' });
    expect(h.seenSessions).toHaveLength(0);
  });

  test('answers an unreachable service at the callback without a session', async () => {
    const h = createHarness({
      serviceImpl: async (url) => {
        if (url.endsWith('/auth/google/config')) return h.serviceJson(200, { clientId: 'google-client-123' });
        throw new Error('down');
      },
    });
    const { requestId } = await startOk(h);
    const landed = await h.call('GET', '/auth/desktop-google/callback', {
      query: { state: requestId, code: 'loopback-code' },
    });
    expect(landed.res.statusCode).toBe(502);
    expect(landed.res.text).toContain('data-auth-error="upstream_unavailable"');
    expect(landed.res.text).toContain('exchange · upstream_unavailable');
    const failed = await h.call('POST', '/api/auth/desktop/google-complete', { body: { requestId } });
    expect(failed.res.statusCode).toBe(502);
    expect(failed.res.body).toEqual({ error: 'upstream_unavailable', step: 'exchange' });
    expect(h.seenSessions).toHaveLength(0);
  });

  test('rejects hostile callback input with named errors and no markup echo', async () => {
    const h = createHarness({ serviceImpl: configService() });
    const { requestId } = await startOk(h);
    const callsBefore = h.serviceCalls.length;
    const oversized = await h.call('GET', '/auth/desktop-google/callback', {
      query: { state: requestId, code: `${'c'.repeat(2048)}x` },
    });
    expect(oversized.res.statusCode).toBe(400);
    expect(oversized.res.text).toContain('callback · invalid_request');
    const arrayState = await h.call('GET', '/auth/desktop-google/callback', {
      query: { state: [requestId], code: 'x' },
    });
    expect(arrayState.res.statusCode).toBe(400);
    expect(arrayState.res.text).toContain('callback · invalid_request');
    const hostile = await h.call('GET', '/auth/desktop-google/callback', {
      query: { state: requestId, code: 'x', error: '"><script>alert(1)</script>' },
    });
    expect(hostile.res.statusCode).toBe(400);
    expect(hostile.res.text).toContain('google · google_oauth_error');
    expect(hostile.res.text).not.toContain('<script>');
    expect(h.serviceCalls).toHaveLength(callsBefore);
  });

  test('completes without a local secret via service introspection', async () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'user-9', sid: 'sess-9' })).toString('base64url');
    const token = `header.${payload}.sig`;
    const h = createHarness({
      alcoreSecret: '',
      serviceImpl: async (url, init) => {
        if (url === 'https://auth.alcore.io.vn/auth/google/config') {
          return h.serviceJson(200, { clientId: 'google-client-123' });
        }
        if (url === 'https://auth.alcore.io.vn/auth/google/desktop-code') {
          return h.serviceJson(200, { access_token: token });
        }
        if (url === 'https://auth.alcore.io.vn/auth/me') {
          expect(init.headers.Authorization).toBe(`Bearer ${token}`);
          return h.serviceJson(200, { id: 'user-9', email: 'g@example.test', emailVerified: true });
        }
        throw new Error(`unexpected service call ${url}`);
      },
    });
    const { requestId } = await startOk(h);
    const landed = await h.call('GET', '/auth/desktop-google/callback', {
      query: { state: requestId, code: 'loopback-code' },
    });
    expect(landed.res.statusCode).toBe(200);
    const done = await h.call('POST', '/api/auth/desktop/google-complete', { body: { requestId } });
    expect(done.res.statusCode).toBe(200);
    expect(done.res.body).toMatchObject({ authenticated: true });
    expect(h.seenVerified).toEqual([{ sub: 'user-9', sid: 'sess-9' }]);
  });

  test('rejects malformed complete bodies', async () => {
    const h = createHarness({ serviceImpl: async () => h.serviceJson(200, SERVICE_PAIR) });
    for (const body of [{}, { requestId: 'short' }]) {
      const { res } = await h.call('POST', '/api/auth/desktop/google-complete', { body });
      expect(res.statusCode).toBe(400);
    }
    expect(h.serviceCalls).toHaveLength(0);
  });

  test('leaves the loopback callback public for the system browser under tunnel scope', async () => {
    const h = createHarness({
      tunnelScope: 'tunnel',
      serviceImpl: async () => h.serviceJson(200, SERVICE_PAIR),
    });
    // Start stays refused for tunnel scope; the callback itself answers the
    // browser navigation (unknown states fail closed, never 403-locked).
    const refused = await h.call('POST', '/api/auth/desktop/google/start', { body: {} });
    expect(refused.res.statusCode).toBe(403);
    const landed = await h.call('GET', '/auth/desktop-google/callback', {
      query: { state: 'b'.repeat(32), code: 'x' },
    });
    expect(landed.res.statusCode).toBe(410);
  });
});

describe('desktop auth tunnel scope', () => {
  test('refuses the mutation routes for tunnel scope', async () => {
    const h = createHarness({
      tunnelScope: 'tunnel',
      serviceImpl: async () => h.serviceJson(200, SERVICE_PAIR),
    });
    for (const [method, path, body] of [
      ['POST', '/api/auth/desktop/email/login', { body: { email: 'a@example.test', password: 'x' } }],
      ['POST', '/api/auth/desktop/email/register', { body: { email: 'a@example.test', password: 'x' } }],
      ['POST', '/api/auth/desktop/email/verify-otp', { body: { email: 'a@example.test', code: '1' } }],
      ['POST', '/api/auth/desktop/email/otp-resend', { body: { email: 'a@example.test' } }],
      ['POST', '/api/auth/desktop/google/start', { body: {} }],
      ['POST', '/api/auth/desktop/google-complete', { body: { requestId: 'a'.repeat(32) } }],
    ]) {
      const { res } = await h.call(method, path, body);
      expect(res.statusCode).toBe(403);
      expect(res.body.tunnelLocked).toBe(true);
    }
    expect(h.serviceCalls).toHaveLength(0);
    expect(h.seenSessions).toHaveLength(0);
  });
});

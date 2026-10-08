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
  const call = async (method, path, { body, query } = {}) => {
    const handlers = routes.get(`${method} ${path}`);
    if (!handlers) throw new Error(`no route ${method} ${path}`);
    const { res, headers } = mockRes();
    const req = { body, query: query ?? {} };
    // Last handler is the route logic; earlier entries are body-parsing middleware.
    await handlers[handlers.length - 1](req, res);
    return { res, headers };
  };
  return { call, seenSessions, serviceCalls, serviceJson, runtime };
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

  test('refuses session login without a configured Alcore secret before calling the service', async () => {
    const h = createHarness({
      alcoreSecret: '',
      serviceImpl: async () => h.serviceJson(200, SERVICE_PAIR),
    });
    const { res } = await h.call('POST', '/api/auth/desktop/email/login', {
      body: { email: 'a@example.test', password: 'x' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'alcore_not_configured' });
    expect(h.serviceCalls).toHaveLength(0);
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

describe('desktop google ferry', () => {
  const startOk = async (h) => {
    const started = await h.call('POST', '/api/auth/desktop/google/start', { body: {} });
    expect(started.res.statusCode).toBe(200);
    expect(started.res.body.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(started.res.body.pageUrl).toBe(`/auth/desktop-google?requestId=${started.res.body.requestId}`);
    return started.res.body.requestId;
  };

  test('serves a GIS page bound to the request', async () => {
    const h = createHarness({
      serviceImpl: async (url) => {
        expect(url).toBe('https://auth.alcore.io.vn/auth/google/config');
        return h.serviceJson(200, { clientId: 'google-client-123' });
      },
    });
    const requestId = await startOk(h);
    const { res } = await h.call('GET', '/auth/desktop-google', { query: { requestId } });
    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('https://accounts.google.com/gsi/client');
    expect(res.text).toContain('google-client-123');
    expect(res.text).toContain(requestId);
    expect(res.text).not.toContain('</script><script');
  });

  test('rejects unknown and malformed page links', async () => {
    const h = createHarness({ serviceImpl: async () => h.serviceJson(200, { clientId: 'x' }) });
    const bad = await h.call('GET', '/auth/desktop-google', { query: { requestId: 'nope' } });
    expect(bad.res.statusCode).toBe(400);
    const unknown = await h.call('GET', '/auth/desktop-google', { query: { requestId: 'a'.repeat(32) } });
    expect(unknown.res.statusCode).toBe(410);
  });

  test('captures once and completes into a session', async () => {
    const h = createHarness({
      serviceImpl: async (url, init) => {
        expect(url).toBe('https://auth.alcore.io.vn/auth/google/verify');
        expect(JSON.parse(init.body)).toEqual({ idToken: 'google-id-token' });
        return h.serviceJson(200, SERVICE_PAIR);
      },
    });
    const requestId = await startOk(h);
    const captured = await h.call('POST', '/api/auth/desktop/google-capture', {
      body: { requestId, idToken: 'google-id-token' },
    });
    expect(captured.res.statusCode).toBe(200);
    expect(captured.res.body).toEqual({ ok: true });

    const replay = await h.call('POST', '/api/auth/desktop/google-capture', {
      body: { requestId, idToken: 'google-id-token' },
    });
    expect(replay.res.statusCode).toBe(404);

    const done = await h.call('POST', '/api/auth/desktop/google-complete', {
      body: { requestId, trustDevice: true, issueClientToken: true, clientLabel: 'OpenChamber Desktop' },
    });
    expect(done.res.statusCode).toBe(200);
    expect(h.seenSessions).toHaveLength(1);
    expect(h.seenSessions[0]).toMatchObject({
      alcoreToken: 'svc-access-token',
      trustDevice: true,
      issueClientToken: true,
      clientLabel: 'OpenChamber Desktop',
    });

    const twice = await h.call('POST', '/api/auth/desktop/google-complete', { body: { requestId } });
    expect(twice.res.statusCode).toBe(404);
    expect(h.seenSessions).toHaveLength(1);
  });

  test('completing without a capture waits with 404 and never calls the service', async () => {
    const h = createHarness({
      serviceImpl: async () => h.serviceJson(200, SERVICE_PAIR),
    });
    const requestId = await startOk(h);
    const { res } = await h.call('POST', '/api/auth/desktop/google-complete', { body: { requestId } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'no_credential' });
    expect(h.serviceCalls).toHaveLength(0);
  });

  test('maps a rejected Google credential to its status', async () => {
    for (const [serviceStatus, serviceBody] of [
      [401, { error: 'invalid_credentials' }],
      [409, { error: 'identity_conflict' }],
    ]) {
      const h = createHarness({
        serviceImpl: async () => h.serviceJson(serviceStatus, serviceBody),
      });
      const requestId = await startOk(h);
      await h.call('POST', '/api/auth/desktop/google-capture', {
        body: { requestId, idToken: 'stale-google-token' },
      });
      const { res } = await h.call('POST', '/api/auth/desktop/google-complete', { body: { requestId } });
      expect(res.statusCode).toBe(serviceStatus);
      expect(res.body).toEqual(serviceBody);
      expect(h.seenSessions).toHaveLength(0);
    }
  });

  test('rejects malformed ferry bodies', async () => {
    const h = createHarness({ serviceImpl: async () => h.serviceJson(200, SERVICE_PAIR) });
    for (const [method, path, body] of [
      ['POST', '/api/auth/desktop/google-capture', {}],
      ['POST', '/api/auth/desktop/google-capture', { requestId: 'short', idToken: 'x' }],
      ['POST', '/api/auth/desktop/google-complete', {}],
    ]) {
      const { res } = await h.call(method, path, { body });
      expect(res.statusCode).toBe(400);
    }
    expect(h.serviceCalls).toHaveLength(0);
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
      ['POST', '/api/auth/desktop/google-capture', { body: { requestId: 'a'.repeat(32), idToken: 'x' } }],
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

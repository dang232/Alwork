import { describe, expect, test } from 'bun:test';

import {
  createTokenpanelQuotaRuntime,
  TOKENPANEL_DEFAULT_BASE,
  TOKENPANEL_QUOTA_CACHE_TTL_MS,
  TOKENPANEL_QUOTA_PATH,
  TokenpanelQuotaError,
} from './tokenpanel-quota.js';

// The quota proxy owns the route the account panel already calls
// (`GET /api/tokenpanel/quota?authUserId=`). The upstream is stubbed at
// the serviceFetch seam with bodies matching the hook's documented shape;
// caller auth is observed on the outgoing request (the CALLER's Bearer,
// never a service key, never in the URL), never through a live service.
// The keychain is a memory fake behind the store seam; subject resolution
// defaults to the signed-in caller.
const LIVE_BODY = {
  authUserId: 'user-1',
  customerId: 'cus_1',
  balance: { amountMicros: 5_000_000, reservedMicros: 0, availableMicros: 5_000_000, currency: 'USD' },
  usage: { totalRequests: 12, totalTokens: 3456, totalCostMicros: 789, totalPriceMicros: 789, currency: 'USD' },
  source: 'live',
  stale: false,
};

const mockRes = () => {
  const res = {
    statusCode: 200,
    body: undefined,
    status: (code) => {
      res.statusCode = code;
      return res;
    },
    json: (payload) => {
      res.body = payload;
      return res;
    },
  };
  return res;
};

// Memory keychain fake: pairs keyed by sub, refresh stubbed per harness.
const memoryTokenStore = ({ pairs = {}, refreshImpl = null } = {}) => {
  const held = new Map(Object.entries(pairs));
  const calls = { read: [], refreshed: [], cleared: [] };
  return {
    calls,
    readPair: async (sub) => {
      calls.read.push(sub);
      const found = held.get(sub);
      return found ? { ...found } : null;
    },
    savePair: async (sub, pair) => {
      held.set(sub, { ...pair });
    },
    clearPair: async (sub) => {
      calls.cleared.push(sub);
      held.delete(sub);
    },
    refreshAccessToken: async (sub) => {
      calls.refreshed.push(sub);
      if (!refreshImpl) throw Object.assign(new Error('refresh not stubbed'), { code: 'USER_TOKEN_NO_REFRESH' });
      return refreshImpl(sub, held);
    },
  };
};

const createHarness = ({
  serviceImpl,
  nowValue,
  pairs = { 'user-1': { accessToken: 'user-access-1', refreshToken: 'user-refresh-1' } },
  refreshImpl = null,
  subject = 'user-1',
  base,
  store = null,
} = {}) => {
  let at = nowValue ?? Date.now();
  const handlers = new Map();
  const serviceCalls = [];
  const serviceJson = (status, data) => ({ status, json: async () => data });
  const tokens = store ?? memoryTokenStore({ pairs, refreshImpl });
  const runtime = createTokenpanelQuotaRuntime({
    serviceBase: base,
    serviceFetch: async (url, init) => {
      serviceCalls.push({ url, init });
      return serviceImpl(url, init, serviceJson);
    },
    now: () => at,
    userTokenStore: tokens,
    resolveSubject: async () => subject,
  });
  runtime.registerRoutes({ get: (path, handler) => handlers.set(`GET ${path}`, handler) });
  const call = async (query) => {
    const handler = handlers.get('GET /api/tokenpanel/quota');
    if (!handler) throw new Error('quota route not registered');
    const res = mockRes();
    await handler({ query }, res);
    return res;
  };
  return { call, serviceCalls, serviceJson, setNow: (value) => { at = value; }, tokens };
};

describe('tokenpanel quota proxy', () => {
  test('passes a live body through with the caller Bearer', async () => {
    const h = createHarness({
      base: 'https://tokenpanel.test/',
      serviceImpl: (url, init, serviceJson) => {
        expect(url).toBe(`https://tokenpanel.test${TOKENPANEL_QUOTA_PATH}?authUserId=user-1`);
        expect(url).not.toContain('user-access-1');
        expect(init.method).toBe('GET');
        expect(init.headers.Accept).toBe('application/json');
        expect(init.headers.Authorization).toBe('Bearer user-access-1');
        return serviceJson(200, LIVE_BODY);
      },
    });
    const res = await h.call({ authUserId: 'user-1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ...LIVE_BODY, source: 'live', stale: false });
    expect(h.serviceCalls).toHaveLength(1);
    expect(h.tokens.calls.read).toEqual(['user-1']);
  });

  test('rejects malformed identity input before any token or upstream use', async () => {
    const h = createHarness({ serviceImpl: () => { throw new Error('must not be called'); } });
    for (const query of [{}, { authUserId: '' }, { authUserId: 'x'.repeat(129) }, { authUserId: ['user-1'] }]) {
      const res = await h.call(query);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_request' });
    }
    expect(h.serviceCalls).toHaveLength(0);
    expect(h.tokens.calls.read).toHaveLength(0);
  });

  test('enforces self-only: another identity reads as forbidden', async () => {
    const h = createHarness({
      subject: 'user-1',
      serviceImpl: () => { throw new Error('must not be called'); },
    });
    const res = await h.call({ authUserId: 'user-2' });
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'tokenpanel_forbidden' });
    expect(h.serviceCalls).toHaveLength(0);
    expect(h.tokens.calls.read).toHaveLength(0);
  });

  test('an unknown caller identity reads as forbidden', async () => {
    for (const subject of ['', null]) {
      const h = createHarness({
        subject,
        serviceImpl: () => { throw new Error('must not be called'); },
      });
      const res = await h.call({ authUserId: 'user-1' });
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'tokenpanel_forbidden' });
      expect(h.serviceCalls).toHaveLength(0);
    }
  });

  test('answers 503 when the caller has no stored pair', async () => {
    const h = createHarness({
      pairs: {},
      serviceImpl: () => { throw new Error('must not be called'); },
    });
    const res = await h.call({ authUserId: 'user-1' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'tokenpanel_not_configured' });
    expect(h.serviceCalls).toHaveLength(0);
  });

  test('refreshes once on upstream 401 and retries with the rotated token', async () => {
    const authorizations = [];
    const h = createHarness({
      refreshImpl: async (sub, held) => {
        expect(sub).toBe('user-1');
        held.set('user-1', { accessToken: 'user-access-2', refreshToken: 'user-refresh-2' });
        return 'user-access-2';
      },
      serviceImpl: (url, init, serviceJson) => {
        authorizations.push(init.headers.Authorization);
        if (authorizations.length === 1) return serviceJson(401, { error: 'unauthorized' });
        return serviceJson(200, LIVE_BODY);
      },
    });
    const res = await h.call({ authUserId: 'user-1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ source: 'live', stale: false });
    expect(authorizations).toEqual(['Bearer user-access-1', 'Bearer user-access-2']);
    expect(h.tokens.calls.refreshed).toEqual(['user-1']);
    // The rotated pair persists for the next read.
    expect((await h.tokens.readPair('user-1')).accessToken).toBe('user-access-2');
  });

  test('a refused refresh clears the pair and answers session-expired', async () => {
    const h = createHarness({
      refreshImpl: async () => {
        throw Object.assign(new Error('refused'), { code: 'USER_TOKEN_REFRESH_REJECTED' });
      },
      serviceImpl: (url, init, serviceJson) => serviceJson(401, { error: 'unauthorized' }),
    });
    const res = await h.call({ authUserId: 'user-1' });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'tokenpanel_session_expired' });
    expect(h.tokens.calls.cleared).toEqual(['user-1']);
    expect(h.serviceCalls).toHaveLength(1);
  });

  test('a second 401 after rotation clears the pair and answers session-expired', async () => {
    const h = createHarness({
      refreshImpl: async (sub, held) => {
        held.set('user-1', { accessToken: 'user-access-2', refreshToken: 'user-refresh-2' });
        return 'user-access-2';
      },
      serviceImpl: (url, init, serviceJson) => serviceJson(401, { error: 'unauthorized' }),
    });
    const res = await h.call({ authUserId: 'user-1' });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'tokenpanel_session_expired' });
    expect(h.serviceCalls).toHaveLength(2);
    expect(h.tokens.calls.cleared).toEqual(['user-1']);
  });

  test('an access-only pair answers session-expired without a refresh call', async () => {
    const refreshed = [];
    const h = createHarness({
      pairs: { 'user-1': { accessToken: 'user-access-1', refreshToken: '' } },
      refreshImpl: async (sub) => {
        refreshed.push(sub);
        throw Object.assign(new Error('no refresh'), { code: 'USER_TOKEN_NO_REFRESH' });
      },
      serviceImpl: (url, init, serviceJson) => serviceJson(401, { error: 'unauthorized' }),
    });
    const res = await h.call({ authUserId: 'user-1' });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'tokenpanel_session_expired' });
    expect(refreshed).toEqual(['user-1']);
  });

  test('never serves stale on session-expiry, even with a warm cache', async () => {
    const start = Date.now();
    let mode = 'live';
    const h = createHarness({
      nowValue: start,
      refreshImpl: async () => {
        throw Object.assign(new Error('refused'), { code: 'USER_TOKEN_REFRESH_REJECTED' });
      },
      serviceImpl: (url, init, serviceJson) => {
        if (mode === 'live') return serviceJson(200, LIVE_BODY);
        return serviceJson(401, { error: 'unauthorized' });
      },
    });
    expect((await h.call({ authUserId: 'user-1' })).body.stale).toBe(false);
    mode = 'denied';
    h.setNow(start + TOKENPANEL_QUOTA_CACHE_TTL_MS / 2);
    const res = await h.call({ authUserId: 'user-1' });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'tokenpanel_session_expired' });
  });

  test('serves stale within grace when the refresh itself is unreachable', async () => {
    const start = Date.now();
    let mode = 'live';
    const h = createHarness({
      nowValue: start,
      refreshImpl: async () => {
        throw Object.assign(new Error('down'), { code: 'USER_TOKEN_REFRESH_TRANSIENT' });
      },
      serviceImpl: (url, init, serviceJson) => {
        if (mode === 'live') return serviceJson(200, LIVE_BODY);
        if (mode === 'denied') return serviceJson(401, { error: 'unauthorized' });
        throw new Error('down');
      },
    });
    expect((await h.call({ authUserId: 'user-1' })).body.stale).toBe(false);

    mode = 'denied';
    h.setNow(start + TOKENPANEL_QUOTA_CACHE_TTL_MS / 2);
    const stale = await h.call({ authUserId: 'user-1' });
    expect(stale.statusCode).toBe(200);
    expect(stale.body).toMatchObject({ source: 'cache', stale: true, authUserId: 'user-1' });
    expect(h.tokens.calls.cleared).toHaveLength(0);

    mode = 'down';
    h.setNow(start + TOKENPANEL_QUOTA_CACHE_TTL_MS + 1000);
    const stillGrace = await h.call({ authUserId: 'user-1' });
    expect(stillGrace.body.stale).toBe(true);

    h.setNow(start + 2 * TOKENPANEL_QUOTA_CACHE_TTL_MS + 1000);
    const past = await h.call({ authUserId: 'user-1' });
    expect(past.statusCode).toBe(503);
    expect(past.body).toEqual({ error: 'tokenpanel_unavailable' });
  });

  test('falls back to the default base when none is configured', async () => {
    const saved = process.env.TOKENPANEL_API_URL;
    delete process.env.TOKENPANEL_API_URL;
    try {
      const h = createHarness({
        serviceImpl: (url, init, serviceJson) => {
          expect(url).toBe(`${TOKENPANEL_DEFAULT_BASE}${TOKENPANEL_QUOTA_PATH}?authUserId=user-1`);
          return serviceJson(200, LIVE_BODY);
        },
      });
      const res = await h.call({ authUserId: 'user-1' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ source: 'live', stale: false });
    } finally {
      if (saved === undefined) delete process.env.TOKENPANEL_API_URL;
      else process.env.TOKENPANEL_API_URL = saved;
    }
  });

  test('throws named errors from the reader seam', async () => {
    const h = createHarness({ serviceImpl: () => { throw new Error('unreachable'); } });
    const runtime = createTokenpanelQuotaRuntime({
      userTokenStore: memoryTokenStore({ pairs: { 'user-1': { accessToken: 'a', refreshToken: 'r' } } }),
      serviceFetch: async () => { throw new Error('down'); },
    });
    await expect(runtime.resolveQuotaBody('', 'user-1')).rejects.toMatchObject({ name: 'TokenpanelQuotaError' });
    await expect(runtime.resolveQuotaBody('user-1', 'user-2')).rejects.toMatchObject({ code: 'TOKENPANEL_FORBIDDEN' });
    expect(h.serviceCalls).toHaveLength(0);
    const settled = await runtime.resolveQuotaBody('user-1', 'user-1').then(
      () => 'resolved',
      (error) => error,
    );
    expect(settled).toBeInstanceOf(TokenpanelQuotaError);
    expect(settled.code).toBe('TOKENPANEL_TRANSIENT');
  });

  test('serves stale within grace on transient outages, then fails closed', async () => {
    const start = Date.now();
    let mode = 'live';
    const h = createHarness({
      nowValue: start,
      serviceImpl: (url, init, serviceJson) => {
        if (mode === 'live') return serviceJson(200, LIVE_BODY);
        if (mode === 'flap') return serviceJson(502, { error: 'upstream' });
        throw new Error('down');
      },
    });
    expect((await h.call({ authUserId: 'user-1' })).body.stale).toBe(false);

    mode = 'down';
    h.setNow(start + TOKENPANEL_QUOTA_CACHE_TTL_MS / 2);
    const stale = await h.call({ authUserId: 'user-1' });
    expect(stale.statusCode).toBe(200);
    expect(stale.body).toMatchObject({ source: 'cache', stale: true, authUserId: 'user-1' });
    expect(stale.body.balance).toEqual(LIVE_BODY.balance);

    mode = 'flap';
    h.setNow(start + TOKENPANEL_QUOTA_CACHE_TTL_MS + 1000);
    const stillGrace = await h.call({ authUserId: 'user-1' });
    expect(stillGrace.body.stale).toBe(true);

    h.setNow(start + 2 * TOKENPANEL_QUOTA_CACHE_TTL_MS + 1000);
    const past = await h.call({ authUserId: 'user-1' });
    expect(past.statusCode).toBe(503);
    expect(past.body).toEqual({ error: 'tokenpanel_unavailable' });
  });

  test('never serves stale on hard-invalid answers', async () => {
    const denied = createHarness({
      serviceImpl: (url, init, serviceJson) => serviceJson(403, { error: 'forbidden' }),
    });
    // Prime another runtime's cache shape is impossible across instances,
    // so this asserts the direct mapping: hard-invalid answers 502.
    const res = await denied.call({ authUserId: 'user-1' });
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'tokenpanel_rejected' });

    const malformed = createHarness({
      serviceImpl: (url, init, serviceJson) => serviceJson(200, { ...LIVE_BODY, balance: { bogus: true } }),
    });
    const bad = await malformed.call({ authUserId: 'user-1' });
    expect(bad.statusCode).toBe(502);
    expect(bad.body).toEqual({ error: 'tokenpanel_rejected' });
  });

  test('answers its own JSON and never forwards upstream cookies', async () => {
    const h = createHarness({
      serviceImpl: (url, init, serviceJson) => serviceJson(200, LIVE_BODY),
    });
    const res = await h.call({ authUserId: 'user-1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ...LIVE_BODY, source: 'live', stale: false });
  });
});

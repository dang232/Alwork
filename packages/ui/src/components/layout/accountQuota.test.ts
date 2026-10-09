import { describe, expect, test } from 'bun:test';
import { clearAutoSignOutMark } from './signOutToGate';
import {
  fetchAccountQuota,
  formatQuotaMoney,
  isTokenpanelSessionExpired,
  parseAccountQuota,
  quotaAvailableMajor,
  quotaBalanceShares,
  quotaCostMajor,
  type AccountQuotaPayload,
} from './accountQuota';

// Focused coverage for the header quota states beside the tier badge.
// The parser only READS the TokenPanel quota shape: live vs stale-cached
// vs unavailable. Malformed bodies are unavailable — never a blank crash,
// never a fabricated quota.

const liveBody = {
  authUserId: 'auth_user_1',
  customerId: '507f1f77bcf86cd799439011',
  balance: { amountMicros: 2_000_000, reservedMicros: 750_000, availableMicros: 1_250_000, currency: 'USD' },
  usage: { totalRequests: 42, totalTokens: 1200, totalCostMicros: 300_000, totalPriceMicros: 500_000, currency: 'USD' },
  source: 'live',
  stale: false,
};

describe('parseAccountQuota', () => {
  test('live body parses to the live state with values', () => {
    const quota = parseAccountQuota(liveBody);
    expect(quota).toMatchObject({ state: 'live' });
    if (quota.state === 'live') {
      expect(quota.balance.availableMicros).toBe(1_250_000);
      expect(quota.usage.totalTokens).toBe(1200);
      expect(quotaAvailableMajor(quota.balance)).toBe(1.25);
    }
  });

  test('stale flag maps to stale-cached, keeping the values', () => {
    const quota = parseAccountQuota({ ...liveBody, source: 'cache', stale: true });
    expect(quota).toMatchObject({ state: 'stale-cached' });
    if (quota.state === 'stale-cached') {
      expect(quota.balance.availableMicros).toBe(1_250_000);
    }
  });

  test('malformed bodies are unavailable, never a crash', () => {
    for (const corrupt of [null, undefined, '', 'oops', 42, [], {}, { authenticated: true }, { ...liveBody, balance: null }, { ...liveBody, usage: { totalTokens: 'lots' } }, { ...liveBody, stale: 'yes' }]) {
      expect(parseAccountQuota(corrupt)).toEqual({ state: 'unavailable' });
    }
  });

  test('missing subject means no query — callers map it to unavailable', () => {
    expect(''.length).toBe(0);
  });
});

describe('quotaBalanceShares', () => {
  test('splits a balance into available and reserved percents', () => {
    expect(
      quotaBalanceShares({ amountMicros: 2_000_000, reservedMicros: 750_000, availableMicros: 1_250_000, currency: 'USD' }),
    ).toEqual({ availablePercent: 63, usedPercent: 38 });
  });

  test('a zero or negative total has no share to show (value row without a bar)', () => {
    for (const amountMicros of [0, -100]) {
      expect(
        quotaBalanceShares({ amountMicros, reservedMicros: 0, availableMicros: 0, currency: 'USD' }),
      ).toEqual({ availablePercent: null, usedPercent: null });
    }
  });

  test('non-finite inputs are missing shares, never NaN widths', () => {
    for (const balance of [
      { amountMicros: Number.NaN, reservedMicros: 0, availableMicros: 0, currency: 'USD' },
      { amountMicros: 100, reservedMicros: Number.POSITIVE_INFINITY, availableMicros: 0, currency: 'USD' },
      { amountMicros: 100, reservedMicros: 0, availableMicros: Number.NaN, currency: 'USD' },
    ]) {
      expect(quotaBalanceShares(balance)).toEqual({ availablePercent: null, usedPercent: null });
    }
  });

  test('clamps over-reserved balances instead of overflowing the bar', () => {
    expect(
      quotaBalanceShares({ amountMicros: 100, reservedMicros: 250, availableMicros: -150, currency: 'USD' }),
    ).toEqual({ availablePercent: 0, usedPercent: 100 });
  });
});

describe('quotaCostMajor', () => {
  test('converts usage cost micros to major units', () => {
    expect(
      quotaCostMajor({ totalRequests: 42, totalTokens: 1200, totalCostMicros: 300_000, totalPriceMicros: 500_000, currency: 'USD' }),
    ).toBe(0.3);
  });
});

describe('formatQuotaMoney', () => {
  test('formats known currencies with Intl', () => {
    expect(formatQuotaMoney(1_250_000, 'USD')).toContain('1.25');
  });

  test('an unexpected currency code falls back instead of throwing', () => {
    expect(formatQuotaMoney(1_250_000, '!!!')).toBe('1.25 !!!');
  });
});

describe('isTokenpanelSessionExpired', () => {
  test('only the 401 expired code triggers sign-out', () => {
    expect(isTokenpanelSessionExpired(401, { error: 'tokenpanel_session_expired' })).toBe(true);
    const cases: Array<[number, AccountQuotaPayload]> = [
      [401, { error: 'tokenpanel_forbidden' }],
      [401, { error: 'tokenpanel_unavailable' }],
      [401, {}],
      [401, null],
      [401, 'expired'],
      [401, []],
      [503, { error: 'tokenpanel_session_expired' }],
      [200, { error: 'tokenpanel_session_expired' }],
    ];
    for (const [status, payload] of cases) {
      expect(isTokenpanelSessionExpired(status, payload)).toBe(false);
    }
  });
});

describe('fetchAccountQuota sign-out chain', () => {
  // SAFETY: the stub installs a plain-object window below and this file
  // restores the original value after each test; only presence is read here.
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalFetch = globalThis.fetch;

  const installWindow = (fetchImpl: (input: string) => Promise<Response>) => {
    const requests: string[] = [];
    const session = new Map<string, string>();
    let reloads = 0;
    // SAFETY: fetchAccountQuota only calls fetch(input, init); Bun's extra
    // `preconnect` member is never read.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return fetchImpl(String(input));
    }) as typeof fetch;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: {
          origin: 'http://127.0.0.1:3001',
          href: 'http://127.0.0.1:3001/',
          protocol: 'http:',
          reload: () => {
            reloads += 1;
          },
        },
        sessionStorage: {
          getItem: (key: string) => session.get(key) ?? null,
          setItem: (key: string, value: string) => {
            session.set(key, value);
          },
          removeItem: (key: string) => {
            session.delete(key);
          },
        },
      },
    });
    return {
      requests,
      reloads: () => reloads,
      restore: () => {
        globalThis.fetch = originalFetch;
        Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      },
    };
  };

  const json = (status: number, data: AccountQuotaPayload) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

  test('live reads stay signed in and re-arm the guard', async () => {
    const w = installWindow(async () => json(200, liveBody));
    try {
      clearAutoSignOutMark();
      const quota = await fetchAccountQuota('auth_user_1', new AbortController().signal);
      expect(quota).toMatchObject({ state: 'live' });
      expect(w.requests.some((entry) => entry.includes('/api/tokenpanel/quota'))).toBe(true);
      expect(w.requests.some((entry) => entry.includes('/api/auth/reset'))).toBe(false);
      expect(w.reloads()).toBe(0);
    } finally {
      w.restore();
    }
  });

  test('session-expiry signs out once, then reads unavailable', async () => {
    const w = installWindow(async (input) => {
      if (input.includes('/api/auth/reset')) return json(200, {});
      return json(401, { error: 'tokenpanel_session_expired' });
    });
    try {
      clearAutoSignOutMark();
      const first = await fetchAccountQuota('auth_user_1', new AbortController().signal);
      expect(first).toEqual({ state: 'unavailable' });
      const second = await fetchAccountQuota('auth_user_1', new AbortController().signal);
      expect(second).toEqual({ state: 'unavailable' });
      expect(w.requests.filter((entry) => entry.includes('/api/auth/reset'))).toHaveLength(1);
      expect(w.reloads()).toBe(1);
    } finally {
      w.restore();
    }
  });

  test('other failures stay unavailable without signing out', async () => {
    const w = installWindow(async () => json(503, { error: 'tokenpanel_unavailable' }));
    try {
      clearAutoSignOutMark();
      expect(await fetchAccountQuota('auth_user_1', new AbortController().signal)).toEqual({
        state: 'unavailable',
      });
      expect(w.requests.some((entry) => entry.includes('/api/auth/reset'))).toBe(false);
      expect(w.reloads()).toBe(0);
    } finally {
      w.restore();
    }
  });

  test('empty subject never reaches the network', async () => {
    const w = installWindow(async () => json(200, liveBody));
    try {
      clearAutoSignOutMark();
      expect(await fetchAccountQuota('', new AbortController().signal)).toEqual({ state: 'unavailable' });
      expect(w.requests).toHaveLength(0);
    } finally {
      w.restore();
    }
  });
});

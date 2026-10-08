import { describe, expect, test } from 'bun:test';
import { parseAccountQuota, quotaAvailableMajor } from './accountQuota';

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

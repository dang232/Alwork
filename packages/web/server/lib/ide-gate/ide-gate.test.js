// Fixture-driven tests for the capability-based IDE account gate.
// No TokenPanel is installed: a fixture stub with the task-9 documented
// bodies stands in, a manual clock seam replaces sleeps, and every
// per-invocation assertion counts stub calls (must stay 0 on the local path).
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  IDE_GATE_DEFAULT_TTL_MINUTES,
  createIdeGate,
  loadTierMatrixFixture,
} from './ide-gate.js';

const GATE_SECRET = 'ide-gate-test-secret-0123456789abcdef';

const readFixtureTiers = () => {
  const text = readFileSync(new URL('./ide-tier-matrix.fixture.json', import.meta.url), 'utf8');
  return loadTierMatrixFixture(text).tiers;
};

const byTier = (tiers) => {
  const map = new Map();
  for (const row of tiers) map.set(row.tier, row);
  return map;
};

// Stub whose getGate answers the exact task-9 GET /gate body shape.
// `mode` flips failure semantics: live | transient | hard-invalid.
const createFixtureTokenPanel = (rows, hooks = {}) => {
  const state = {
    calls: 0,
    mode: 'live',
    rows: byTier(rows),
  };
  const getGate = async (tier) => {
    state.calls += 1;
    if (hooks.onCall) hooks.onCall(tier);
    if (state.mode === 'transient') {
      throw { code: 'TOKENPANEL_TRANSIENT', message: 'simulated outage' };
    }
    if (state.mode === 'hard-invalid') {
      throw { code: 'TOKENPANEL_INVALID', message: 'simulated hard failure' };
    }
    const row = state.rows.get(tier);
    if (!row) {
      throw { code: 'TOKENPANEL_INVALID', message: `unknown tier ${tier}` };
    }
    return {
      tier: row.tier,
      allowed: row.ideAccess === 'allow',
      ideAccess: row.ideAccess,
      features: [...row.features],
      ttlMinutes: row.ttlMinutes,
      source: 'live',
      stale: false,
    };
  };
  return { state, getGate };
};

const createClock = (start = 1_700_000_000_000) => {
  const clock = { now: start };
  return clock;
};

describe('ide gate fixture', () => {
  it('loads the vendored tier matrix with a 15-minute TTL', () => {
    const tiers = readFixtureTiers();
    expect(tiers.length).toBe(3);
    for (const row of tiers) {
      expect(row.ttlMinutes).toBe(15);
    }
    expect(IDE_GATE_DEFAULT_TTL_MINUTES).toBe(15);
  });

  it('matches the Alwork matrix fixture tier-for-tier', () => {
    const vendored = readFixtureTiers();
    const upstream = loadTierMatrixFixture(
      readFileSync('I:/migration/Alwork/config/ide-tier-matrix.json', 'utf8'),
    ).tiers;
    expect(upstream).toEqual(vendored);
  });

  it('rejects malformed fixtures by field', () => {
    expect(() => loadTierMatrixFixture('not json')).toThrow();
    expect(() => loadTierMatrixFixture(JSON.stringify({ tiers: [] }))).toThrow();
    expect(() => loadTierMatrixFixture(JSON.stringify({
      tiers: [{ tier: 'evil-tier', ideAccess: 'allow', features: [], ttlMinutes: 15 }],
    }))).toThrow();
    expect(() => loadTierMatrixFixture(JSON.stringify({
      tiers: [{ tier: 'paid', ideAccess: 'allow', features: [], ttlMinutes: 0 }],
    }))).toThrow();
  });
});

describe('ide gate login -> WHO -> customer -> tier -> gate', () => {
  it('mints a login capability with the fixture TTL', async () => {
    const tiers = readFixtureTiers();
    const panel = createFixtureTokenPanel(tiers);
    const clock = createClock();
    const gate = createIdeGate({ secret: GATE_SECRET, tokenPanel: panel, now: () => clock.now });

    const minted = await gate.mintAtLogin({
      whoSession: { sub: 'user-1', sid: 'sess-1' },
      customerTier: 'paid',
    });

    expect(panel.state.calls).toBe(1);
    expect(minted.gateBody).toMatchObject({
      tier: 'paid', allowed: true, ideAccess: 'allow', stale: false, source: 'live',
    });
    expect(minted.capability.features).toEqual(['full-access']);
    expect(minted.capability.exp - minted.capability.iat).toBe(15 * 60_000);
    expect(minted.capability.sub).toBe('user-1');
  });

  it('denies pending-payment at login without minting access', async () => {
    const panel = createFixtureTokenPanel(readFixtureTiers());
    const clock = createClock();
    const gate = createIdeGate({ secret: GATE_SECRET, tokenPanel: panel, now: () => clock.now });

    const minted = await gate.mintAtLogin({
      whoSession: { sub: 'user-2', sid: 'sess-2' },
      customerTier: 'pending-payment',
    });

    expect(minted.capability.allowed).toBe(false);
    expect(minted.capability.features).toEqual([]);
    expect(gate.checkInvocation(minted.capability)).toMatchObject({ allowed: false });
  });

  it('denies malformed login identity and unknown tiers', async () => {
    const panel = createFixtureTokenPanel(readFixtureTiers());
    const gate = createIdeGate({ secret: GATE_SECRET, tokenPanel: panel, now: () => createClock().now });
    await expect(gate.mintAtLogin({ whoSession: { sub: '', sid: '' }, customerTier: 'paid' })).rejects.toThrow();
    await expect(gate.mintAtLogin({ whoSession: { sub: 'u', sid: 's' }, customerTier: 'evil-tier' })).rejects.toThrow();
  });
});

describe('ide gate per-invocation local verification', () => {
  it('passes locally with zero TokenPanel calls', async () => {
    const panel = createFixtureTokenPanel(readFixtureTiers());
    const clock = createClock();
    const gate = createIdeGate({ secret: GATE_SECRET, tokenPanel: panel, now: () => clock.now });
    const minted = await gate.mintAtLogin({
      whoSession: { sub: 'user-1', sid: 'sess-1' },
      customerTier: 'free-tier',
    });
    const callsAfterLogin = panel.state.calls;

    for (let index = 0; index < 3; index += 1) {
      const verdict = gate.checkInvocation(minted.capability);
      expect(verdict).toMatchObject({ allowed: true, reason: 'ok' });
    }
    expect(panel.state.calls).toBe(callsAfterLogin);
  });

  it('denies tampered capabilities without a TokenPanel call', async () => {
    const panel = createFixtureTokenPanel(readFixtureTiers());
    const clock = createClock();
    const gate = createIdeGate({ secret: GATE_SECRET, tokenPanel: panel, now: () => clock.now });
    const minted = await gate.mintAtLogin({
      whoSession: { sub: 'user-1', sid: 'sess-1' },
      customerTier: 'paid',
    });
    const callsAfterLogin = panel.state.calls;

    const tampered = { ...minted.capability, features: ['full-access', 'admin'] };
    expect(gate.checkInvocation(tampered)).toMatchObject({ allowed: false, reason: 'tampered' });
    expect(panel.state.calls).toBe(callsAfterLogin);
  });

  it('denies expired capabilities locally', async () => {
    const panel = createFixtureTokenPanel(readFixtureTiers());
    const clock = createClock();
    const gate = createIdeGate({ secret: GATE_SECRET, tokenPanel: panel, now: () => clock.now });
    const minted = await gate.mintAtLogin({
      whoSession: { sub: 'user-1', sid: 'sess-1' },
      customerTier: 'paid',
    });

    clock.now += 15 * 60_000 + 1;
    expect(gate.checkInvocation(minted.capability)).toMatchObject({ allowed: false, reason: 'expired' });
  });
});

describe('ide gate async refresh and tier flips', () => {
  it('reflects a tier flip within the TTL with no rebuild', async () => {
    const panel = createFixtureTokenPanel(readFixtureTiers());
    const clock = createClock();
    const gate = createIdeGate({ secret: GATE_SECRET, tokenPanel: panel, now: () => clock.now });
    const minted = await gate.mintAtLogin({
      whoSession: { sub: 'user-1', sid: 'sess-1' },
      customerTier: 'paid',
    });
    expect(minted.capability.features).toEqual(['full-access']);

    // Operator tier flip: same process, no restart, no rebuild.
    panel.state.rows.set('paid', { tier: 'paid', ideAccess: 'allow', features: ['full-access', 'wave2-probe'], ttlMinutes: 15 });
    clock.now += 60_000;

    const refreshed = await gate.refresh(minted.capability);
    expect(refreshed.stale).toBe(false);
    expect(refreshed.capability.features).toEqual(['full-access', 'wave2-probe']);
    expect(gate.checkInvocation(refreshed.capability)).toMatchObject({ allowed: true });
  });

  it('serves cached capability with stale:true inside one TTL of grace, then denies closed', async () => {
    const panel = createFixtureTokenPanel(readFixtureTiers());
    const clock = createClock();
    const gate = createIdeGate({ secret: GATE_SECRET, tokenPanel: panel, now: () => clock.now });
    const minted = await gate.mintAtLogin({
      whoSession: { sub: 'user-1', sid: 'sess-1' },
      customerTier: 'paid',
    });

    panel.state.mode = 'transient';
    clock.now += 5 * 60_000;
    const served = await gate.refresh(minted.capability);
    expect(served.stale).toBe(true);
    expect(served.gateBody).toMatchObject({ tier: 'paid', stale: true, source: 'cache' });
    expect(served.capability.features).toEqual(['full-access']);

    clock.now += 60 * 60_000;
    await expect(gate.refresh(minted.capability)).rejects.toThrow('deny-closed');
  });

  it('denies closed on hard-invalid TokenPanel failures', async () => {
    const panel = createFixtureTokenPanel(readFixtureTiers());
    const clock = createClock();
    const gate = createIdeGate({ secret: GATE_SECRET, tokenPanel: panel, now: () => clock.now });
    const minted = await gate.mintAtLogin({
      whoSession: { sub: 'user-1', sid: 'sess-1' },
      customerTier: 'paid',
    });

    panel.state.mode = 'hard-invalid';
    await expect(gate.refresh(minted.capability)).rejects.toThrow();
  });
});

describe('ide gate pane chrome', () => {
  it('shows tier badges and locked features', async () => {
    const panel = createFixtureTokenPanel(readFixtureTiers());
    const clock = createClock();
    const gate = createIdeGate({ secret: GATE_SECRET, tokenPanel: panel, now: () => clock.now });

    const paid = await gate.mintAtLogin({ whoSession: { sub: 'u', sid: 's' }, customerTier: 'paid' });
    expect(gate.chromeForCapability(paid.capability)).toMatchObject({
      badge: 'IDE · paid', allowed: true, tier: 'paid', locked: ['basic-ide'],
    });

    const free = await gate.mintAtLogin({ whoSession: { sub: 'u', sid: 's' }, customerTier: 'free-tier' });
    expect(gate.chromeForCapability(free.capability)).toMatchObject({
      badge: 'IDE · free-tier', allowed: true, locked: ['full-access'],
    });

    const denied = await gate.mintAtLogin({ whoSession: { sub: 'u', sid: 's' }, customerTier: 'pending-payment' });
    expect(gate.chromeForCapability(denied.capability)).toMatchObject({
      badge: 'IDE · locked', allowed: false,
    });

    expect(gate.chromeForCapability({ ...paid.capability, sig: 'tampered' })).toMatchObject({
      badge: 'IDE · locked', allowed: false,
    });
  });
});

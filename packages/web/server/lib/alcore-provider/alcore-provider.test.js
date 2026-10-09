import { describe, expect, test } from 'bun:test';

import {
  ALCORE_ENV_CREDENTIAL,
  ALCORE_PROVIDER_ID,
  ALCORE_PROVIDER_PACKAGE,
  AlcoreProviderError,
  buildAlcoreProviderConfig,
  createAlcoreProviderRuntime,
  resolveAlcoreBase,
} from './alcore-provider.js';
import { TOKENPANEL_DEFAULT_BASE } from '../tokenpanel/tokenpanel-quota.js';

// The Alcore card is fed by the live platform catalog, reached with the
// CALLER's own keychained Bearer. The platform is stubbed at the
// serviceFetch seam with OpenAI-shaped bodies; caller auth is observed on
// the outgoing request (Bearer, never in the URL), never through a live
// service. Nothing here invents a catalog: a stub that answers malformed
// or empty bodies must read as a clean skip, never a fabricated list.
const OPENAI_LIST = { data: [{ id: 'alcore-fast' }, { id: 'alcore-deep', name: 'Alcore Deep' }] };

const okResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

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
      if (!refreshImpl) throw Object.assign(new Error('no refresh'), { code: 'USER_TOKEN_NO_REFRESH' });
      return refreshImpl(sub, held);
    },
  };
};

const createHarness = ({
  catalogImpl = async () => okResponse(OPENAI_LIST),
  pairs = { 'user-1': { accessToken: 'user-access-1', refreshToken: 'user-refresh-1' } },
  refreshImpl = null,
  upsertImpl = null,
  removeImpl = null,
  isEnterprise = () => false,
  envBase = null,
} = {}) => {
  const requests = [];
  const serviceFetch = async (url, init) => {
    requests.push({ url: String(url), authorization: init?.headers?.Authorization });
    return catalogImpl(url, init);
  };
  const upserts = [];
  const removals = [];
  const env = {};
  if (envBase !== null) env.TOKENPANEL_API_URL = envBase;
  const store = memoryTokenStore({ pairs, refreshImpl });
  const runtime = createAlcoreProviderRuntime({
    userTokenStore: store,
    upsertProviderConfig: upsertImpl === null
      ? (...args) => {
        upserts.push(args);
        return { providerId: args[0], path: 'user-config', config: args[1] };
      }
      : upsertImpl,
    removeProviderConfig: removeImpl === null
      ? (...args) => {
        removals.push(args);
        return true;
      }
      : removeImpl,
    serviceFetch,
    env,
    isEnterprise,
  });
  return { runtime, requests, upserts, removals, env, store };
};

describe('alcore provider base', () => {
  test('derives the OpenAI-compatible base from the TokenPanel base of record', () => {
    expect(resolveAlcoreBase(undefined, {})).toBe(`${TOKENPANEL_DEFAULT_BASE}/v1`);
  });

  test('honors TOKENPANEL_API_URL and strips trailing slashes', () => {
    expect(resolveAlcoreBase(undefined, { TOKENPANEL_API_URL: 'https://panel.test///' }))
      .toBe('https://panel.test/v1');
  });

  test('rejects a non-http base without touching the network', () => {
    expect(() => resolveAlcoreBase('ftp://panel.test', {})).toThrow(AlcoreProviderError);
  });
});

describe('alcore catalog fetch', () => {
  test('reads the live OpenAI-shaped catalog with the caller Bearer', async () => {
    const { runtime, requests } = createHarness();
    const catalog = await runtime.fetchAlcoreCatalog('user-1');
    expect(catalog.base).toBe(`${TOKENPANEL_DEFAULT_BASE}/v1`);
    // Discovery normalizes to id-sorted order, like the Settings flow.
    expect(catalog.models.map((model) => model.modelID)).toEqual(['alcore-deep', 'alcore-fast']);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`${TOKENPANEL_DEFAULT_BASE}/v1/models`);
    expect(requests[0].authorization).toBe('Bearer user-access-1');
  });

  test('accepts a bare array catalog', async () => {
    const { runtime } = createHarness({ catalogImpl: async () => okResponse([{ id: 'solo' }]) });
    const catalog = await runtime.fetchAlcoreCatalog('user-1');
    expect(catalog.models).toEqual([{ modelID: 'solo', name: 'solo' }]);
  });

  test('malformed catalog answers a clean rejection, never a crash', async () => {
    const { runtime, upserts } = createHarness({ catalogImpl: async () => okResponse({ nope: true }) });
    await expect(runtime.fetchAlcoreCatalog('user-1')).rejects.toMatchObject({ code: 'ALCORE_REJECTED' });
    expect(await runtime.syncOnLogin('user-1')).toEqual({ ok: false, reason: 'ALCORE_REJECTED' });
    expect(upserts).toHaveLength(0);
  });

  test('missing pair reads as not configured without a network call', async () => {
    const { runtime, requests } = createHarness({ pairs: {} });
    await expect(runtime.fetchAlcoreCatalog('user-1')).rejects.toMatchObject({ code: 'ALCORE_NOT_CONFIGURED' });
    expect(requests).toHaveLength(0);
  });

  test('a 401 refreshes once and retries with the fresh token', async () => {
    let calls = 0;
    const { runtime, requests, store } = createHarness({
      catalogImpl: async (url, init) => {
        calls += 1;
        return calls === 1 ? okResponse({ error: 'unauthorized' }, 401) : okResponse(OPENAI_LIST);
      },
      refreshImpl: (sub, held) => {
        held.set(sub, { accessToken: 'fresh-access', refreshToken: 'rotated-refresh' });
        return 'fresh-access';
      },
    });
    const catalog = await runtime.fetchAlcoreCatalog('user-1');
    expect(catalog.models).toHaveLength(2);
    expect(catalog.access).toBe('fresh-access');
    expect(store.calls.refreshed).toEqual(['user-1']);
    expect(requests.map((request) => request.authorization))
      .toEqual(['Bearer user-access-1', 'Bearer fresh-access']);
  });

  test('a refused refresh rejects without clearing the stored pair', async () => {
    const { runtime, store } = createHarness({
      catalogImpl: async () => okResponse({ error: 'unauthorized' }, 401),
      refreshImpl: () => {
        throw Object.assign(new Error('refused'), { code: 'USER_TOKEN_REFRESH_REJECTED' });
      },
    });
    await expect(runtime.fetchAlcoreCatalog('user-1')).rejects.toMatchObject({ code: 'ALCORE_REJECTED' });
    // Login-time catalog reads never nuke credentials the quota path owns.
    expect(store.calls.cleared).toHaveLength(0);
  });

  test('a second 401 after refresh rejects without clearing the pair', async () => {
    const { runtime, store } = createHarness({
      catalogImpl: async () => okResponse({ error: 'unauthorized' }, 401),
      refreshImpl: (sub, held) => {
        held.set(sub, { accessToken: 'fresh-access', refreshToken: 'r' });
        return 'fresh-access';
      },
    });
    await expect(runtime.fetchAlcoreCatalog('user-1')).rejects.toMatchObject({ code: 'ALCORE_REJECTED' });
    expect(store.calls.cleared).toHaveLength(0);
  });

  test('a transport failure reads as transient', async () => {
    const { runtime } = createHarness({
      catalogImpl: async () => { throw new TypeError('fetch failed'); },
    });
    await expect(runtime.fetchAlcoreCatalog('user-1')).rejects.toMatchObject({ code: 'ALCORE_TRANSIENT' });
  });

  test('an invalid subject never reaches the store or network', async () => {
    const { runtime, requests, store } = createHarness();
    await expect(runtime.fetchAlcoreCatalog('')).rejects.toMatchObject({ code: 'ALCORE_INVALID_REQUEST' });
    expect(store.calls.read).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });
});

describe('alcore login sync', () => {
  test('registers the provider through the shared registry with live models', async () => {
    const { runtime, upserts, env } = createHarness();
    const outcome = await runtime.syncOnLogin('user-1');
    expect(outcome).toEqual({ ok: true, models: 2 });
    expect(upserts).toHaveLength(1);
    const [providerId, config, workingDirectory, scope, options] = upserts[0];
    expect(providerId).toBe(ALCORE_PROVIDER_ID);
    expect(workingDirectory).toBeNull();
    expect(scope).toBe('user');
    expect(options).toEqual({});
    expect(config).toMatchObject({
      package: 'aisdk:@ai-sdk/openai-compatible',
      name: 'Alcore',
      env: [ALCORE_ENV_CREDENTIAL],
      settings: { baseURL: `${TOKENPANEL_DEFAULT_BASE}/v1` },
    });
    expect(Object.keys(config.models).sort()).toEqual(['alcore-deep', 'alcore-fast']);
    // The ambient credential is memory-only: the config names the variable,
    // the value never touches disk or logs.
    expect(env[ALCORE_ENV_CREDENTIAL]).toBe('user-access-1');
  });

  test('an empty catalog skips registration instead of writing no models', async () => {
    const { runtime, upserts } = createHarness({ catalogImpl: async () => okResponse({ data: [] }) });
    expect(await runtime.syncOnLogin('user-1')).toEqual({ ok: false, reason: 'empty_catalog' });
    expect(upserts).toHaveLength(0);
  });

  test('enterprise mode skips registration without a network call', async () => {
    const { runtime, requests, upserts } = createHarness({ isEnterprise: () => true });
    expect(await runtime.syncOnLogin('user-1')).toEqual({ ok: false, reason: 'enterprise_mode' });
    expect(requests).toHaveLength(0);
    expect(upserts).toHaveLength(0);
  });

  test('a failing config write never rejects the login', async () => {
    const { runtime, env } = createHarness({
      upsertImpl: () => { throw Object.assign(new Error('disk full'), { statusCode: 500 }); },
    });
    const outcome = await runtime.syncOnLogin('user-1');
    expect(outcome.ok).toBe(false);
    expect(env[ALCORE_ENV_CREDENTIAL]).toBeUndefined();
  });

  test('an invalid subject is a clean skip', async () => {
    const { runtime, upserts } = createHarness();
    expect(await runtime.syncOnLogin('')).toEqual({ ok: false, reason: 'invalid_request' });
    expect(upserts).toHaveLength(0);
  });
});

describe('alcore sign-out cleanup', () => {
  test('clears the pair, removes the entry, and drops the ambient credential', async () => {
    const { runtime, removals, env, store } = createHarness();
    env[ALCORE_ENV_CREDENTIAL] = 'stale-access';
    const outcome = await runtime.clearOnSignOut('user-1');
    expect(outcome).toEqual({ cleared: true, removed: true });
    expect(store.calls.cleared).toEqual(['user-1']);
    expect(removals).toEqual([[ALCORE_PROVIDER_ID, null, 'user']]);
    expect(env[ALCORE_ENV_CREDENTIAL]).toBeUndefined();
  });

  test('an unknown subject still drops the ambient credential', async () => {
    const { runtime, removals, env } = createHarness();
    env[ALCORE_ENV_CREDENTIAL] = 'stale-access';
    const outcome = await runtime.clearOnSignOut('');
    expect(outcome).toEqual({ cleared: false, removed: false });
    expect(removals).toHaveLength(0);
    expect(env[ALCORE_ENV_CREDENTIAL]).toBeUndefined();
  });

  test('missing store and registry never reject sign-out', async () => {
    const runtime = createAlcoreProviderRuntime({ env: {} });
    await expect(runtime.clearOnSignOut('user-1')).resolves.toEqual({ cleared: false, removed: false });
    await expect(runtime.syncOnLogin('user-1')).resolves.toEqual({ ok: false, reason: 'not_wired' });
  });
});

describe('alcore provider constants', () => {
  test('pins the registry contract values', () => {
    // The provider id, package, and display name are on-disk/UI compat:
    // a rename strands configs and cards, so it fails loudly here.
    expect(ALCORE_PROVIDER_ID).toBe('alcore');
    expect(ALCORE_PROVIDER_PACKAGE).toBe('aisdk:@ai-sdk/openai-compatible');
    expect(ALCORE_ENV_CREDENTIAL).toBe('ALCORE_USER_TOKEN');
  });
});

describe('alcore provider config shape', () => {
  test('keys models by model id with the registry spelling', () => {
    const config = buildAlcoreProviderConfig('https://panel.test/v1', [
      { modelID: 'b', name: 'B' },
      { modelID: 'a', name: 'A', limit: { context: 1000 } },
    ]);
    expect(config.models).toEqual({
      b: { modelID: 'b', name: 'B' },
      a: { modelID: 'a', name: 'A', limit: { context: 1000 } },
    });
  });
});

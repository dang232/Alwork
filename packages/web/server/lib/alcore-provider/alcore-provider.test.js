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

const memoryOpenCodeCredentials = ({
  existingIds = [],
  connectImpl = null,
  listImpl = null,
  removeImpl = null,
} = {}) => {
  const calls = { listed: 0, connected: [], removed: [], waited: [] };
  return {
    calls,
    listCredentialIDs: listImpl ?? (async () => {
      calls.listed += 1;
      return [...existingIds];
    }),
    connectKey: connectImpl ?? (async (key) => {
      calls.connected.push(key);
    }),
    removeCredential: removeImpl ?? (async (id) => {
      calls.removed.push(id);
    }),
  };
};

const memoryPersonalKeys = ({ mintImpl = null } = {}) => {
  const calls = { minted: [], revoked: [] };
  const keyIds = new Map();
  return {
    calls,
    keyIds,
    mintPersonalKey: async (sub) => {
      calls.minted.push(sub);
      if (mintImpl) return mintImpl(sub, keyIds);
      const minted = { key: 'personal-key-1', keyId: 'key-id-1', prefix: 'tp_live_personal0001' };
      keyIds.set(sub, minted.keyId);
      return minted;
    },
    revokePersonalKey: async (sub, keyId) => {
      calls.revoked.push([sub, keyId ?? null]);
      keyIds.delete(sub);
      return { revoked: keyId === undefined ? ['key-id-1'] : [keyId] };
    },
    readKeyId: async (sub) => keyIds.get(sub) ?? null,
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
  openCodeCredentials = null,
  personalKeys = 'memory',
  credentialWait = async () => undefined,
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
  const openCode = openCodeCredentials === 'memory'
    ? memoryOpenCodeCredentials()
    : openCodeCredentials;
  const personal = personalKeys === 'memory' ? memoryPersonalKeys() : personalKeys;
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
    openCodeCredentials: openCode,
    personalKeys: personal,
    credentialWait,
  });
  return { runtime, requests, upserts, removals, env, store, openCode, personalKeys: personal };
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
    const { runtime, upserts, env, personalKeys } = createHarness();
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
    // the value never touches disk or logs. The value is the MINTED personal
    // key — never the rotating login Bearer, so rotation/expiry cannot
    // touch the stored provider key.
    expect(env[ALCORE_ENV_CREDENTIAL]).toBe('personal-key-1');
    expect(personalKeys.calls.minted).toEqual(['user-1']);
  });

  test('an empty catalog skips registration instead of writing no models', async () => {
    const { runtime, upserts } = createHarness({ catalogImpl: async () => okResponse({ data: [] }) });
    expect(await runtime.syncOnLogin('user-1')).toEqual({ ok: false, reason: 'empty_catalog' });
    expect(upserts).toHaveLength(0);
  });

  test('enterprise mode skips registration without a network or mint call', async () => {
    const { runtime, requests, upserts, personalKeys } = createHarness({ isEnterprise: () => true });
    expect(await runtime.syncOnLogin('user-1')).toEqual({ ok: false, reason: 'enterprise_mode' });
    expect(requests).toHaveLength(0);
    expect(upserts).toHaveLength(0);
    // No key is ever minted while the mode is on.
    expect(personalKeys.calls.minted).toHaveLength(0);
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

describe('alcore OpenCode credential sync (task 48 — badge flip, task 51 — personal key)', () => {
  test('stores the minted personal key as the integration key after the config write', async () => {
    const openCode = memoryOpenCodeCredentials();
    const { runtime, upserts } = createHarness({ openCodeCredentials: openCode });
    const outcome = await runtime.syncOnLogin('user-1');
    expect(outcome).toEqual({ ok: true, models: 2 });
    expect(upserts).toHaveLength(1);
    // The minted customer API key powers the credential: never the rotating
    // login Bearer, never a service key, never from config, never in a URL.
    expect(openCode.calls.connected).toEqual(['personal-key-1']);
    expect(openCode.calls.listed).toBe(1);
  });

  test('sweeps stale credentials first so one login never accumulates accounts', async () => {
    const openCode = memoryOpenCodeCredentials({ existingIds: ['cred-old-1', 'cred-old-2'] });
    const { runtime } = createHarness({ openCodeCredentials: openCode });
    expect(await runtime.syncOnLogin('user-1')).toEqual({ ok: true, models: 2 });
    expect(openCode.calls.removed).toEqual(['cred-old-1', 'cred-old-2']);
    expect(openCode.calls.connected).toEqual(['personal-key-1']);
  });

  test('stores the minted key — not the refreshed Bearer — when the catalog 401s once', async () => {
    let calls = 0;
    const openCode = memoryOpenCodeCredentials();
    const { runtime } = createHarness({
      catalogImpl: async (url, init) => {
        calls += 1;
        return calls === 1 ? okResponse({ error: 'unauthorized' }, 401) : okResponse(OPENAI_LIST);
      },
      refreshImpl: (sub, held) => {
        held.set(sub, { accessToken: 'fresh-access', refreshToken: 'rotated-refresh' });
        return 'fresh-access';
      },
      openCodeCredentials: openCode,
    });
    // Login-token rotation must not affect the stored provider key: the
    // credential is the minted key even though the catalog Bearer rotated.
    expect(await runtime.syncOnLogin('user-1')).toEqual({ ok: true, models: 2 });
    expect(openCode.calls.connected).toEqual(['personal-key-1']);
  });

  test('retries the key after a not-found until OpenCode picks up the config', async () => {
    const waited = [];
    let attempts = 0;
    const openCode = memoryOpenCodeCredentials({
      connectImpl: async (key) => {
        attempts += 1;
        if (attempts === 1) throw new Error('Integration not found');
        openCode.calls.connected.push(key);
      },
    });
    const { runtime } = createHarness({
      openCodeCredentials: openCode,
      credentialWait: async (ms) => { waited.push(ms); },
    });
    expect(await runtime.syncOnLogin('user-1')).toEqual({ ok: true, models: 2 });
    expect(attempts).toBe(2);
    expect(waited).toEqual([250]);
    expect(openCode.calls.connected).toEqual(['personal-key-1']);
  });

  test('a failing credential sync never breaks the proven login', async () => {
    const openCode = memoryOpenCodeCredentials({
      connectImpl: async () => { throw Object.assign(new Error('openCode down'), { code: 'unavailable' }); },
    });
    const { runtime, upserts, env } = createHarness({ openCodeCredentials: openCode });
    expect(await runtime.syncOnLogin('user-1')).toEqual({ ok: true, models: 2 });
    expect(upserts).toHaveLength(1);
    expect(env[ALCORE_ENV_CREDENTIAL]).toBe('personal-key-1');
  });

  test('unwired OpenCode keeps the task-42 block-only behavior', async () => {
    const { runtime } = createHarness();
    expect(await runtime.syncOnLogin('user-1')).toEqual({ ok: true, models: 2 });
  });

  test('enterprise mode skips credential work without store, mint, or network calls', async () => {
    const openCode = memoryOpenCodeCredentials();
    const { runtime, requests, store, personalKeys } = createHarness({
      isEnterprise: () => true,
      openCodeCredentials: openCode,
    });
    expect(await runtime.syncOnLogin('user-1')).toEqual({ ok: false, reason: 'enterprise_mode' });
    expect(requests).toHaveLength(0);
    expect(store.calls.read).toHaveLength(0);
    expect(personalKeys.calls.minted).toHaveLength(0);
    expect(openCode.calls.listed).toBe(0);
    expect(openCode.calls.connected).toHaveLength(0);
  });

  test('an invalid subject never touches store, network, or credentials', async () => {
    const openCode = memoryOpenCodeCredentials();
    const { runtime, requests, store } = createHarness({ openCodeCredentials: openCode });
    expect(await runtime.syncOnLogin('')).toEqual({ ok: false, reason: 'invalid_request' });
    expect(store.calls.read).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(openCode.calls.listed).toBe(0);
  });

  test('sign-out revokes the minted id, then removes every alcore credential beside the pair and entry', async () => {
    const openCode = memoryOpenCodeCredentials({ existingIds: ['cred-1', 'cred-2'] });
    const { runtime, removals, env, store, personalKeys } = createHarness({ openCodeCredentials: openCode });
    env[ALCORE_ENV_CREDENTIAL] = 'stale-access';
    personalKeys.keyIds.set('user-1', 'key-id-1');
    expect(await runtime.clearOnSignOut('user-1')).toEqual({ cleared: true, removed: true });
    // The recorded id revokes exactly that row — the sign-out kills the key.
    expect(personalKeys.calls.revoked).toEqual([['user-1', 'key-id-1']]);
    expect(openCode.calls.removed).toEqual(['cred-1', 'cred-2']);
    expect(store.calls.cleared).toEqual(['user-1']);
    expect(removals).toEqual([[ALCORE_PROVIDER_ID, null, 'user']]);
    expect(env[ALCORE_ENV_CREDENTIAL]).toBeUndefined();
  });

  test('sign-out with an unknown subject still removes orphan credentials', async () => {
    const openCode = memoryOpenCodeCredentials({ existingIds: ['cred-orphan'] });
    const { runtime, env } = createHarness({ openCodeCredentials: openCode });
    env[ALCORE_ENV_CREDENTIAL] = 'stale-access';
    expect(await runtime.clearOnSignOut('')).toEqual({ cleared: false, removed: false });
    expect(openCode.calls.removed).toEqual(['cred-orphan']);
    expect(env[ALCORE_ENV_CREDENTIAL]).toBeUndefined();
  });

  test('sign-out credential failures never reject', async () => {
    const openCode = memoryOpenCodeCredentials({
      listImpl: async () => { throw new Error('openCode down'); },
    });
    const { runtime } = createHarness({ openCodeCredentials: openCode });
    await expect(runtime.clearOnSignOut('user-1')).resolves.toEqual({ cleared: true, removed: true });
  });

  test('a refused mint keeps the block but stores no secret (Not signed in, login stands)', async () => {
    const openCode = memoryOpenCodeCredentials();
    const personalKeys = memoryPersonalKeys({
      mintImpl: () => { throw Object.assign(new Error('no link'), { code: 'PERSONAL_KEY_REJECTED' }); },
    });
    const { runtime, upserts, env } = createHarness({ openCodeCredentials: openCode, personalKeys });
    env[ALCORE_ENV_CREDENTIAL] = 'stale-access';
    const outcome = await runtime.syncOnLogin('user-1');
    expect(outcome).toEqual({ ok: false, reason: 'PERSONAL_KEY_REJECTED' });
    // Live models listed, but no secret anywhere: the card reads
    // Not signed in while the proven login stands.
    expect(upserts).toHaveLength(1);
    expect(openCode.calls.connected).toHaveLength(0);
    expect(openCode.calls.listed).toBe(0);
    expect(env[ALCORE_ENV_CREDENTIAL]).toBeUndefined();
  });

  test('unwired personal keys keep the block-only behavior without secrets', async () => {
    const openCode = memoryOpenCodeCredentials();
    const { runtime, upserts, env } = createHarness({ openCodeCredentials: openCode, personalKeys: null });
    expect(await runtime.syncOnLogin('user-1')).toEqual({ ok: false, reason: 'not_wired' });
    expect(upserts).toHaveLength(1);
    expect(openCode.calls.connected).toHaveLength(0);
    expect(env[ALCORE_ENV_CREDENTIAL]).toBeUndefined();
  });

  test('relogin mints again and stores the fresh key (server rotates-with-revoke-old)', async () => {
    const openCode = memoryOpenCodeCredentials();
    let rotations = 0;
    const personalKeys = memoryPersonalKeys({
      mintImpl: (sub, keyIds) => {
        rotations += 1;
        const minted = { key: `personal-key-${rotations}`, keyId: `key-id-${rotations}`, prefix: 'tp_live_personal0001' };
        keyIds.set(sub, minted.keyId);
        return minted;
      },
    });
    const { runtime, env } = createHarness({ openCodeCredentials: openCode, personalKeys });
    expect(await runtime.syncOnLogin('user-1')).toEqual({ ok: true, models: 2 });
    expect(await runtime.syncOnLogin('user-1')).toEqual({ ok: true, models: 2 });
    expect(personalKeys.calls.minted).toEqual(['user-1', 'user-1']);
    // The stored credential is always a minted key — a login Bearer never
    // lands there, so rotation/expiry of login tokens cannot touch it.
    expect(openCode.calls.connected).toEqual(['personal-key-1', 'personal-key-2']);
    expect(env[ALCORE_ENV_CREDENTIAL]).toBe('personal-key-2');
    expect(personalKeys.keyIds.get('user-1')).toBe('key-id-2');
  });

  test('no stored pair mints nothing and stores nothing', async () => {
    const openCode = memoryOpenCodeCredentials();
    const { runtime, upserts, env, personalKeys } = createHarness({
      pairs: {},
      openCodeCredentials: openCode,
    });
    expect(await runtime.syncOnLogin('user-1')).toEqual({ ok: false, reason: 'ALCORE_NOT_CONFIGURED' });
    expect(upserts).toHaveLength(0);
    expect(personalKeys.calls.minted).toHaveLength(0);
    expect(openCode.calls.connected).toHaveLength(0);
    expect(env[ALCORE_ENV_CREDENTIAL]).toBeUndefined();
  });

  test('sign-out without a recorded id revokes every personal row for the caller', async () => {
    const { runtime, personalKeys } = createHarness();
    await expect(runtime.clearOnSignOut('user-1')).resolves.toEqual({ cleared: true, removed: true });
    expect(personalKeys.calls.revoked).toEqual([['user-1', null]]);
  });

  test('a refused revoke still clears, removes, and resolves', async () => {
    const openCode = memoryOpenCodeCredentials({ existingIds: ['cred-1'] });
    const personalKeys = memoryPersonalKeys();
    personalKeys.revokePersonalKey = async (sub, keyId) => {
      personalKeys.calls.revoked.push([sub, keyId ?? null]);
      throw Object.assign(new Error('panel down'), { code: 'PERSONAL_KEY_UNAVAILABLE' });
    };
    const { runtime, env, store } = createHarness({ openCodeCredentials: openCode, personalKeys });
    env[ALCORE_ENV_CREDENTIAL] = 'stale-access';
    await expect(runtime.clearOnSignOut('user-1')).resolves.toEqual({ cleared: true, removed: true });
    expect(personalKeys.calls.revoked).toEqual([['user-1', null]]);
    expect(openCode.calls.removed).toEqual(['cred-1']);
    expect(store.calls.cleared).toEqual(['user-1']);
    expect(env[ALCORE_ENV_CREDENTIAL]).toBeUndefined();
  });

  test('enterprise sign-out still revokes (removal only narrows access)', async () => {
    const { runtime, personalKeys } = createHarness({ isEnterprise: () => true });
    personalKeys.keyIds.set('user-1', 'key-id-9');
    await expect(runtime.clearOnSignOut('user-1')).resolves.toEqual({ cleared: true, removed: true });
    expect(personalKeys.calls.revoked).toEqual([['user-1', 'key-id-9']]);
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

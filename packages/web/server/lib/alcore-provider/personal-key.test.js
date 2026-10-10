import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PERSONAL_KEY_MINT_PATH,
  PersonalKeyError,
  createFileKeyIdStore,
  createPersonalKeyRuntime,
  memoryKeyIdStore,
  resolvePersonalKeyBase,
} from './personal-key.js';
import { TOKENPANEL_DEFAULT_BASE } from '../tokenpanel/tokenpanel-quota.js';

// The provider credential is a minted personal API key, never the login
// token. The TokenPanel surface is stubbed at the serviceFetch seam;
// caller auth is observed on the outgoing request (Bearer, never in the
// URL), never through a live service. Nothing here mints a real key.
const MINT_ANSWER = { keyId: 'key-id-1', key: 'tp_live_personal0001secret', prefix: 'tp_live_personal' };

const okResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const stubFetch = (handler) => {
  const requests = [];
  const serviceFetch = async (url, init) => {
    requests.push({
      url: String(url),
      method: init?.method,
      authorization: init?.headers?.Authorization,
      body: init?.body,
    });
    return handler(url, init, requests.length);
  };
  return { requests, serviceFetch };
};

const memoryTokenStore = ({ pairs = {}, refreshImpl = null } = {}) => {
  const held = new Map(Object.entries(pairs));
  const calls = { read: [], refreshed: [] };
  return {
    calls,
    readPair: async (sub) => {
      calls.read.push(sub);
      const found = held.get(sub);
      return found ? { ...found } : null;
    },
    refreshAccessToken: async (sub) => {
      calls.refreshed.push(sub);
      if (!refreshImpl) throw Object.assign(new Error('no refresh'), { code: 'USER_TOKEN_NO_REFRESH' });
      return refreshImpl(sub, held);
    },
  };
};

const createHarness = ({
  handler = async () => okResponse(MINT_ANSWER, 201),
  pairs = { 'user-1': { accessToken: 'user-access-1', refreshToken: 'user-refresh-1' } },
  refreshImpl = null,
  keyIds = null,
  serviceBase,
  env = {},
} = {}) => {
  const { requests, serviceFetch } = stubFetch(handler);
  const store = memoryTokenStore({ pairs, refreshImpl });
  const keyIdStore = keyIds === 'memory' ? memoryKeyIdStore() : keyIds;
  const runtime = createPersonalKeyRuntime({
    serviceBase,
    serviceFetch,
    userTokenStore: store,
    keyIdStore,
    env,
  });
  return { runtime, requests, store, keyIdStore };
};

describe('personal-key base', () => {
  test('derives the TokenPanel origin (no /v1: the surface is /admin/ide)', () => {
    expect(resolvePersonalKeyBase(undefined, {})).toBe(TOKENPANEL_DEFAULT_BASE);
  });

  test('honors TOKENPANEL_API_URL and strips trailing slashes', () => {
    expect(resolvePersonalKeyBase(undefined, { TOKENPANEL_API_URL: 'https://panel.test///' }))
      .toBe('https://panel.test');
  });

  test('rejects a non-http base without touching the network', () => {
    expect(() => resolvePersonalKeyBase('ftp://panel.test', {})).toThrow(PersonalKeyError);
  });
});

describe('personal-key mint', () => {
  test('mints with the caller Bearer and persists the key id', async () => {
    const { runtime, requests, keyIdStore } = createHarness({ keyIds: 'memory' });
    const minted = await runtime.mintPersonalKey('user-1');
    expect(minted).toEqual({ key: MINT_ANSWER.key, keyId: 'key-id-1', prefix: MINT_ANSWER.prefix });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`${TOKENPANEL_DEFAULT_BASE}${PERSONAL_KEY_MINT_PATH}`);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].authorization).toBe('Bearer user-access-1');
    expect(await keyIdStore.readKeyId('user-1')).toBe('key-id-1');
  });

  test('missing pair reads as not configured without a network call', async () => {
    const { runtime, requests } = createHarness({ pairs: {} });
    await expect(runtime.mintPersonalKey('user-1')).rejects.toMatchObject({ code: 'PERSONAL_KEY_NOT_CONFIGURED' });
    expect(requests).toHaveLength(0);
  });

  test('an invalid subject never reaches the store or network', async () => {
    const { runtime, requests, store } = createHarness();
    await expect(runtime.mintPersonalKey('')).rejects.toMatchObject({ code: 'PERSONAL_KEY_INVALID_REQUEST' });
    expect(store.calls.read).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  test('a 401 refreshes once and retries with the fresh token', async () => {
    let calls = 0;
    const { runtime, requests, store, keyIdStore } = createHarness({
      handler: async () => {
        calls += 1;
        return calls === 1 ? okResponse({ error: 'x' }, 401) : okResponse(MINT_ANSWER, 201);
      },
      refreshImpl: (sub, held) => {
        held.set(sub, { accessToken: 'fresh-access', refreshToken: 'rotated-refresh' });
        return 'fresh-access';
      },
      keyIds: 'memory',
    });
    const minted = await runtime.mintPersonalKey('user-1');
    expect(minted.key).toBe(MINT_ANSWER.key);
    expect(store.calls.refreshed).toEqual(['user-1']);
    expect(requests.map((request) => request.authorization))
      .toEqual(['Bearer user-access-1', 'Bearer fresh-access']);
    expect(await keyIdStore.readKeyId('user-1')).toBe('key-id-1');
  });

  test('a second 401 reads as session-expired without clearing the pair', async () => {
    const store = memoryTokenStore({
      pairs: { 'user-1': { accessToken: 'user-access-1', refreshToken: 'r' } },
      refreshImpl: (sub, held) => {
        held.set(sub, { accessToken: 'fresh-access', refreshToken: 'r2' });
        return 'fresh-access';
      },
    });
    const cleared = [];
    store.clearPair = async (sub) => { cleared.push(sub); };
    const { serviceFetch } = stubFetch(async () => okResponse({ error: 'x' }, 401));
    const runtime = createPersonalKeyRuntime({ serviceFetch, userTokenStore: store, env: {} });
    await expect(runtime.mintPersonalKey('user-1')).rejects.toMatchObject({ code: 'PERSONAL_KEY_SESSION_EXPIRED' });
    // Provisioning never mutates the token store: dead-session discipline
    // stays with the quota path, and the proven login stands.
    expect(cleared).toHaveLength(0);
  });

  test('a refused refresh reads as session-expired', async () => {
    const { runtime } = createHarness({
      handler: async () => okResponse({ error: 'x' }, 401),
      refreshImpl: () => {
        throw Object.assign(new Error('refused'), { code: 'USER_TOKEN_REFRESH_REJECTED' });
      },
    });
    await expect(runtime.mintPersonalKey('user-1')).rejects.toMatchObject({ code: 'PERSONAL_KEY_SESSION_EXPIRED' });
  });

  test('unlinked (404) and ambiguous/suspended (403) read as rejected', async () => {
    for (const status of [403, 404]) {
      const { runtime, keyIdStore } = createHarness({
        handler: async () => okResponse({ error: 'x' }, status),
        keyIds: 'memory',
      });
      await expect(runtime.mintPersonalKey('user-1')).rejects.toMatchObject({ code: 'PERSONAL_KEY_REJECTED' });
      expect(await keyIdStore.readKeyId('user-1')).toBeNull();
    }
  });

  test('transient answers read as unavailable', async () => {
    for (const status of [429, 500, 503]) {
      const { runtime } = createHarness({ handler: async () => okResponse({ error: 'x' }, status) });
      await expect(runtime.mintPersonalKey('user-1')).rejects.toMatchObject({ code: 'PERSONAL_KEY_UNAVAILABLE' });
    }
  });

  test('a transport failure reads as unavailable', async () => {
    const { runtime } = createHarness({
      handler: async () => { throw new TypeError('fetch failed'); },
    });
    await expect(runtime.mintPersonalKey('user-1')).rejects.toMatchObject({ code: 'PERSONAL_KEY_UNAVAILABLE' });
  });

  test('a malformed mint body reads as rejected and never leaks the secret', async () => {
    const { runtime } = createHarness({
      // A 200 carrying key material but no usable shape: the failure must
      // name the step, never the secret.
      handler: async () => okResponse({ key: MINT_ANSWER.key }),
    });
    const failure = await runtime.mintPersonalKey('user-1').then(
      () => null,
      (error) => error,
    );
    expect(failure).toMatchObject({ code: 'PERSONAL_KEY_REJECTED' });
    expect(String(failure.message)).not.toContain(MINT_ANSWER.key);
  });

  test('a failing key-id persist still resolves (sign-out falls back to revoke-all)', async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
    try {
      const { runtime } = createHarness({
        keyIds: { saveKeyId: async () => { throw new Error('disk full'); }, readKeyId: async () => null, clearKeyId: async () => undefined },
      });
      const minted = await runtime.mintPersonalKey('user-1');
      expect(minted.key).toBe(MINT_ANSWER.key);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toHaveLength(1);
    for (const warning of warnings) {
      expect(warning).not.toContain(MINT_ANSWER.key);
      expect(warning).not.toContain(MINT_ANSWER.keyId);
    }
  });
});

describe('personal-key revoke', () => {
  test('revokes the recorded id with the caller Bearer and clears the ref', async () => {
    const { runtime, requests, keyIdStore } = createHarness({
      handler: async () => okResponse({ ok: true, revoked: ['key-id-1'] }),
      keyIds: 'memory',
    });
    await keyIdStore.saveKeyId('user-1', 'key-id-1');
    const outcome = await runtime.revokePersonalKey('user-1', 'key-id-1');
    expect(outcome).toEqual({ revoked: ['key-id-1'] });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('DELETE');
    expect(requests[0].authorization).toBe('Bearer user-access-1');
    expect(JSON.parse(requests[0].body)).toEqual({ keyId: 'key-id-1' });
    expect(await keyIdStore.readKeyId('user-1')).toBeNull();
  });

  test('revoke without an id asks the server to drop every personal row', async () => {
    const { runtime, requests } = createHarness({
      handler: async () => okResponse({ ok: true, revoked: ['key-id-1', 'key-id-2'] }),
    });
    const outcome = await runtime.revokePersonalKey('user-1');
    expect(outcome).toEqual({ revoked: ['key-id-1', 'key-id-2'] });
    expect(JSON.parse(requests[0].body)).toEqual({});
  });

  test('a 404 reads as an empty success (the row is already gone)', async () => {
    const { runtime, keyIdStore } = createHarness({
      handler: async () => okResponse({ error: 'not_found' }, 404),
      keyIds: 'memory',
    });
    await keyIdStore.saveKeyId('user-1', 'key-id-1');
    await expect(runtime.revokePersonalKey('user-1', 'key-id-1')).resolves.toEqual({ revoked: [] });
    expect(await keyIdStore.readKeyId('user-1')).toBeNull();
  });

  test('a 401 refreshes once and retries', async () => {
    let calls = 0;
    const { runtime, requests, store } = createHarness({
      handler: async () => {
        calls += 1;
        return calls === 1
          ? okResponse({ error: 'x' }, 401)
          : okResponse({ ok: true, revoked: ['key-id-1'] });
      },
      refreshImpl: (sub, held) => {
        held.set(sub, { accessToken: 'fresh-access', refreshToken: 'r2' });
        return 'fresh-access';
      },
    });
    await expect(runtime.revokePersonalKey('user-1', 'key-id-1')).resolves.toEqual({ revoked: ['key-id-1'] });
    expect(store.calls.refreshed).toEqual(['user-1']);
    expect(requests.map((request) => request.authorization))
      .toEqual(['Bearer user-access-1', 'Bearer fresh-access']);
  });

  test('transient answers read as unavailable', async () => {
    const { runtime } = createHarness({ handler: async () => okResponse({ error: 'x' }, 503) });
    await expect(runtime.revokePersonalKey('user-1', 'key-id-1')).rejects.toMatchObject({ code: 'PERSONAL_KEY_UNAVAILABLE' });
  });

  test('an invalid key id never reaches the network', async () => {
    const { runtime, requests } = createHarness();
    await expect(runtime.revokePersonalKey('user-1', '')).rejects.toMatchObject({ code: 'PERSONAL_KEY_INVALID_REQUEST' });
    expect(requests).toHaveLength(0);
  });

  test('missing pair reads as not configured', async () => {
    const { runtime, requests } = createHarness({ pairs: {} });
    await expect(runtime.revokePersonalKey('user-1', 'key-id-1')).rejects.toMatchObject({ code: 'PERSONAL_KEY_NOT_CONFIGURED' });
    expect(requests).toHaveLength(0);
  });
});

describe('personal-key readKeyId', () => {
  test('answers null without a store and on store failure', async () => {
    const { runtime } = createHarness();
    await expect(runtime.readKeyId('user-1')).resolves.toBeNull();
    const failing = createPersonalKeyRuntime({
      serviceFetch: async () => okResponse({}),
      keyIdStore: { readKeyId: async () => { throw new Error('disk gone'); } },
      env: {},
    });
    await expect(failing.readKeyId('user-1')).resolves.toBeNull();
  });
});

describe('key-id stores', () => {
  test('memory store round-trips and rejects invalid refs', async () => {
    const store = memoryKeyIdStore();
    await expect(store.readKeyId('user-1')).resolves.toBeNull();
    await store.saveKeyId('user-1', 'key-id-1');
    await expect(store.readKeyId('user-1')).resolves.toBe('key-id-1');
    await store.clearKeyId('user-1');
    await expect(store.readKeyId('user-1')).resolves.toBeNull();
    await expect(store.saveKeyId('', 'key-id-1')).rejects.toMatchObject({ code: 'PERSONAL_KEY_INVALID' });
    await expect(store.saveKeyId('user-1', '')).rejects.toMatchObject({ code: 'PERSONAL_KEY_INVALID' });
  });

  test('file store survives a re-create (restart-safe) and tolerates corruption', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alcore-personal-keys-'));
    const filePath = path.join(dir, 'alcore-personal-keys.json');
    try {
      const first = createFileKeyIdStore({ filePath });
      await first.saveKeyId('user-1', 'key-id-1');
      expect(fs.existsSync(filePath)).toBe(true);
      // A second instance over the same file sees the ref: restart-safe.
      const second = createFileKeyIdStore({ filePath });
      await expect(second.readKeyId('user-1')).resolves.toBe('key-id-1');
      await second.clearKeyId('user-1');
      await expect(createFileKeyIdStore({ filePath }).readKeyId('user-1')).resolves.toBeNull();
      fs.writeFileSync(filePath, 'not json{{{');
      await expect(createFileKeyIdStore({ filePath }).readKeyId('user-1')).resolves.toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

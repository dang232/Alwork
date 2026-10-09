import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createUserTokenStore,
  memoryUserTokenPersist,
  UserTokenStoreError,
} from './user-token-store.js';

// The store holds the login-captured pair (access JWT + opaque refresh
// token) behind a seam shaped EXACTLY like Electron safeStorage, so these
// fakes stand where the OS keychain stands in production. The fake cipher
// is a tagged prefix, not encryption: assertions check that the persisted
// form passed through the keychain (never the raw token assignment) and
// that a foreign key cannot decrypt — real secrecy comes from safeStorage
// on the desktop runtime, which plain-Node tests cannot reach.
const fakeKeychain = (secret = 'k1') => {
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    calls,
    isEncryptionAvailable: () => true,
    encryptString: (plain) => {
      calls.encrypt += 1;
      return Buffer.from(`enc:${secret}:${plain}`, 'utf8');
    },
    decryptString: (buffer) => {
      calls.decrypt += 1;
      const text = Buffer.from(buffer).toString('utf8');
      const prefix = `enc:${secret}:`;
      if (!text.startsWith(prefix)) throw new Error('decrypt failed');
      return text.slice(prefix.length);
    },
  };
};

const lockedKeychain = () => ({
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error('must not be called'); },
  decryptString: () => { throw new Error('must not be called'); },
});

const jsonResponse = (status, data) => ({ status, json: async () => data });

describe('user-token keychain store', () => {
  test('saves and reads a pair through the keychain seam', async () => {
    const keychain = fakeKeychain();
    const persist = memoryUserTokenPersist();
    const store = createUserTokenStore({ keychain, persist });
    await store.savePair('user-1', { accessToken: 'access-abc', refreshToken: 'refresh-xyz' });
    expect(keychain.calls.encrypt).toBe(2);
    const read = await store.readPair('user-1');
    expect(read).toEqual({ accessToken: 'access-abc', refreshToken: 'refresh-xyz' });
    const raw = persist.readAll()['user-1'];
    // The persisted form passed through the keychain: never the raw token.
    expect(raw.access).not.toBe('access-abc');
    expect(raw.refresh).not.toBe('refresh-xyz');
    expect(Buffer.from(raw.access, 'base64').toString('utf8')).toBe('enc:k1:access-abc');
  });

  test('an unknown subject reads as signed-out, never a crash', async () => {
    const store = createUserTokenStore({ keychain: fakeKeychain(), persist: memoryUserTokenPersist() });
    expect(await store.readPair('nobody')).toBeNull();
    expect(await store.readPair('')).toBeNull();
    expect(await store.readPair(null)).toBeNull();
    await store.clearPair('');
    await store.clearPair('nobody');
  });

  test('invalid pairs throw without storing', async () => {
    const store = createUserTokenStore({ keychain: fakeKeychain(), persist: memoryUserTokenPersist() });
    for (const [sub, pair] of [
      ['', { accessToken: 'a', refreshToken: 'r' }],
      ['user-1', { accessToken: '', refreshToken: 'r' }],
      ['user-1', { refreshToken: 'r' }],
      ['user-1', { accessToken: 'a', refreshToken: 42 }],
    ]) {
      const settled = await store.savePair(sub, pair).then(() => 'stored', (error) => error);
      expect(settled).toBeInstanceOf(UserTokenStoreError);
      expect(settled.code).toBe('USER_TOKEN_INVALID');
    }
    expect(await store.readPair('user-1')).toBeNull();
  });

  test('an access-only pair stores with an empty refresh slot', async () => {
    const store = createUserTokenStore({ keychain: fakeKeychain(), persist: memoryUserTokenPersist() });
    await store.savePair('user-1', { accessToken: 'access-only' });
    expect(await store.readPair('user-1')).toEqual({ accessToken: 'access-only', refreshToken: '' });
  });

  test('ciphertext survives a restart through the file persist', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-user-tokens-'));
    try {
      const filePath = path.join(dir, 'user-tokens.json');
      const first = createUserTokenStore({ keychain: fakeKeychain(), dataFilePath: filePath });
      await first.savePair('user-9', { accessToken: 'restart-access', refreshToken: 'restart-refresh' });
      const onDisk = fs.readFileSync(filePath, 'utf8');
      expect(onDisk).not.toContain('restart-access');
      expect(onDisk).not.toContain('restart-refresh');
      // POSIX-only: Windows does not honor the 0o600 mode bits.
      if (process.platform !== 'win32') {
        expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      }
      // Fresh instance, empty memory: the pair comes back from ciphertext.
      const second = createUserTokenStore({ keychain: fakeKeychain(), dataFilePath: filePath });
      expect(await second.readPair('user-9')).toEqual({
        accessToken: 'restart-access',
        refreshToken: 'restart-refresh',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a foreign key cannot decrypt: entry drops to signed-out', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-user-tokens-'));
    try {
      const filePath = path.join(dir, 'user-tokens.json');
      await createUserTokenStore({ keychain: fakeKeychain('k1'), dataFilePath: filePath })
        .savePair('user-1', { accessToken: 'a1', refreshToken: 'r1' });
      const foreign = createUserTokenStore({ keychain: fakeKeychain('k2'), dataFilePath: filePath });
      expect(await foreign.readPair('user-1')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a corrupt ciphertext file reads as empty and heals on save', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-user-tokens-'));
    try {
      const filePath = path.join(dir, 'user-tokens.json');
      fs.writeFileSync(filePath, '{not json');
      const store = createUserTokenStore({ keychain: fakeKeychain(), dataFilePath: filePath });
      expect(await store.readPair('user-1')).toBeNull();
      await store.savePair('user-1', { accessToken: 'a', refreshToken: 'r' });
      expect(await store.readPair('user-1')).toEqual({ accessToken: 'a', refreshToken: 'r' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a locked keychain degrades to memory without touching disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-user-tokens-'));
    try {
      const filePath = path.join(dir, 'user-tokens.json');
      const store = createUserTokenStore({ keychain: lockedKeychain(), dataFilePath: filePath });
      await store.savePair('user-1', { accessToken: 'mem-only', refreshToken: 'mem-refresh' });
      expect(await store.readPair('user-1')).toEqual({ accessToken: 'mem-only', refreshToken: 'mem-refresh' });
      expect(fs.existsSync(filePath)).toBe(false);
      const restarted = createUserTokenStore({ keychain: lockedKeychain(), dataFilePath: filePath });
      expect(await restarted.readPair('user-1')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('clearPair removes the serving copy and the ciphertext', async () => {
    const persist = memoryUserTokenPersist();
    const store = createUserTokenStore({ keychain: fakeKeychain(), persist });
    await store.savePair('user-1', { accessToken: 'a', refreshToken: 'r' });
    expect(persist.readAll()['user-1']).toBeDefined();
    await store.clearPair('user-1');
    expect(await store.readPair('user-1')).toBeNull();
    expect(persist.readAll()['user-1']).toBeUndefined();
  });

  test('refresh rotates the pair through the auth-service endpoint', async () => {
    const seen = [];
    const store = createUserTokenStore({
      keychain: fakeKeychain(),
      persist: memoryUserTokenPersist(),
      serviceBase: 'https://auth.test',
      serviceFetch: async (url, init) => {
        seen.push({ url, init });
        expect(url).toBe('https://auth.test/auth/token/refresh');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ refresh_token: 'refresh-old' });
        expect(url).not.toContain('refresh-old');
        return jsonResponse(200, { access_token: 'access-new', refresh_token: 'refresh-new' });
      },
    });
    await store.savePair('user-1', { accessToken: 'access-old', refreshToken: 'refresh-old' });
    const rotated = await store.refreshAccessToken('user-1');
    expect(rotated).toBe('access-new');
    expect(seen).toHaveLength(1);
    expect(await store.readPair('user-1')).toEqual({ accessToken: 'access-new', refreshToken: 'refresh-new' });
  });

  test('refresh keeps the old refresh value when the service omits rotation', async () => {
    const store = createUserTokenStore({
      keychain: fakeKeychain(),
      persist: memoryUserTokenPersist(),
      serviceBase: 'https://auth.test/',
      serviceFetch: async () => jsonResponse(200, { access_token: 'access-new' }),
    });
    await store.savePair('user-1', { accessToken: 'access-old', refreshToken: 'refresh-old' });
    expect(await store.refreshAccessToken('user-1')).toBe('access-new');
    expect(await store.readPair('user-1')).toEqual({ accessToken: 'access-new', refreshToken: 'refresh-old' });
  });

  test('refresh failures are named: refused, transient, or nothing to rotate', async () => {
    const storeFor = (serviceFetch) => createUserTokenStore({
      keychain: fakeKeychain(),
      persist: memoryUserTokenPersist(),
      serviceBase: 'https://auth.test',
      serviceFetch,
    });
    const saved = createUserTokenStore({
      keychain: fakeKeychain(),
      persist: memoryUserTokenPersist(),
      serviceBase: 'https://auth.test',
      serviceFetch: async () => jsonResponse(200, { access_token: 'x' }),
    });
    await saved.savePair('user-1', { accessToken: 'a', refreshToken: 'r' });

    const refused = storeFor(async () => jsonResponse(401, { error: 'invalid_grant' }));
    await refused.savePair('user-1', { accessToken: 'a', refreshToken: 'r' });
    await expect(refused.refreshAccessToken('user-1')).rejects.toMatchObject({ code: 'USER_TOKEN_REFRESH_REJECTED' });

    const malformed = storeFor(async () => jsonResponse(200, { access_token: '' }));
    await malformed.savePair('user-1', { accessToken: 'a', refreshToken: 'r' });
    await expect(malformed.refreshAccessToken('user-1')).rejects.toMatchObject({ code: 'USER_TOKEN_REFRESH_REJECTED' });

    for (const transient of [
      storeFor(async () => jsonResponse(503, { error: 'busy' })),
      storeFor(async () => jsonResponse(429, { error: 'slow' })),
      storeFor(async () => { throw new Error('down'); }),
    ]) {
      await transient.savePair('user-1', { accessToken: 'a', refreshToken: 'r' });
      await expect(transient.refreshAccessToken('user-1')).rejects.toMatchObject({ code: 'USER_TOKEN_REFRESH_TRANSIENT' });
    }

    const bare = storeFor(async () => { throw new Error('must not be called'); });
    await bare.savePair('user-1', { accessToken: 'access-only' });
    await expect(bare.refreshAccessToken('user-1')).rejects.toMatchObject({ code: 'USER_TOKEN_NO_REFRESH' });
    await expect(bare.refreshAccessToken('ghost')).rejects.toMatchObject({ code: 'USER_TOKEN_NO_REFRESH' });
    await expect(bare.refreshAccessToken('')).rejects.toMatchObject({ code: 'USER_TOKEN_NO_REFRESH' });
  });
});

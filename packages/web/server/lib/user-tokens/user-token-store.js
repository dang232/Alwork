// User-token keychain store (project-ide task 39).
//
// What this owns: the Alcore user-token pair captured at desktop login
// completion — the short-lived access JWT (10-min, claims sub+scope) plus
// the opaque rotating refresh token — held so the TokenPanel quota proxy
// can present the CALLER's own Bearer without the renderer ever seeing a
// token. Only storage and presentation live here: issuance and validation
// stay with the auth-service and the session owner (ui-auth).
//
// Where secrets rest:
// - OS keychain via Electron safeStorage when available (packaged and dev
//   desktop run the server in-process with Electron main, so safeStorage
//   is reachable here): ciphertext persists to
//   `<dataDir>/user-tokens.json` (mode 0o600, same precedent as the JWT
//   secret file); plaintext exists only in process memory while an entry
//   is encrypted, decrypted, or held as the working set.
// - Any runtime without Electron safeStorage (plain web server): process
//   memory only, lost on restart — fail-safe toward re-login.
// Never localStorage, never disk plaintext, never URLs, never logs: every
// error below names the step, never the secret.
//
// Seams (all optional, production resolves its own defaults per call):
// `keychain` mirrors safeStorage's shape exactly
// (`{ isEncryptionAvailable, encryptString, decryptString }`), so the mock
// boundary in tests IS the safeStorage boundary; `persist` is
// `{ readAll, writeAll }` over ciphertext entries (file-backed by
// default); `dataFilePath` pins the ciphertext file (tests use a temp
// dir, mirroring the ui-auth test precedent).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { readAlcoreIssuer } from '../ui-auth/ui-auth.js';

const USER_TOKEN_FILE_NAME = 'user-tokens.json';
const USER_TOKEN_FILE_MODE = 0o600;
const USER_TOKEN_REFRESH_PATH = '/auth/token/refresh';
const USER_TOKEN_SERVICE_TIMEOUT_MS = 15_000;

const subSchema = z.string().trim().min(1).max(128);
const accessTokenSchema = z.string().trim().min(1).max(8192);
const refreshTokenSchema = z.string().trim().min(1).max(4096);
const base64Schema = z.string().min(1);
const storedEntriesSchema = z.record(
  z.string(),
  z.object({
    access: base64Schema,
    refresh: base64Schema.nullable().optional(),
    updatedAt: z.number(),
  }),
);
// The auth-service refresh answer: a fresh access JWT plus the rotated
// refresh token (kept optional — when the service omits it the previous
// refresh value stays, best-effort, rather than stranding the session).
const refreshAnswerSchema = z.object({
  access_token: accessTokenSchema,
  refresh_token: refreshTokenSchema.optional(),
});

export class UserTokenStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UserTokenStoreError';
    this.code = code;
  }
}

const defaultDataFilePath = () => {
  const root = process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber');
  return path.join(root, USER_TOKEN_FILE_NAME);
};

const readCipherFile = (filePath) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const entries = storedEntriesSchema.safeParse(parsed?.entries).data;
    return entries ?? {};
  } catch {
    // Missing or corrupt ciphertext reads as empty: the next successful
    // save overwrites it, and callers fail toward re-login, never a crash.
    return {};
  }
};

const writeCipherFile = (filePath, entries) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, entries }), { mode: USER_TOKEN_FILE_MODE });
};

const filePersist = (filePath) => ({
  readAll: () => readCipherFile(filePath),
  writeAll: (entries) => writeCipherFile(filePath, entries),
});

const memoryPersist = () => {
  let entries = {};
  return {
    readAll: () => ({ ...entries }),
    writeAll: (next) => { entries = { ...next }; },
  };
};

// Electron safeStorage, resolved per operation so a keychain that locks
// (or unlocks) mid-run takes effect without a restart. Plain Node has no
// Electron runtime: `require('electron')` there answers the binary path,
// which fails the shape check below and reads as unavailable.
const electronKeychainSchema = z.object({
  isEncryptionAvailable: z.function(),
  encryptString: z.function(),
  decryptString: z.function(),
});
const resolveOsKeychain = () => {
  try {
    const versions = z.object({ electron: z.string() }).safeParse(globalThis.process?.versions).data;
    if (!versions) return null;
    const candidate = electronKeychainSchema.safeParse(
      createRequire(import.meta.url)('electron')?.safeStorage,
    ).data;
    if (!candidate) return null;
    return candidate.isEncryptionAvailable() === true ? candidate : null;
  } catch {
    return null;
  }
};

const defaultAuthServiceBase = () => {
  try {
    return new URL(readAlcoreIssuer(undefined)).origin;
  } catch {
    return 'https://auth.alcore.io.vn';
  }
};

export const createUserTokenStore = ({
  keychain,
  persist,
  dataFilePath,
  serviceBase,
  serviceFetch = (...args) => fetch(...args),
} = {}) => {
  // Plaintext working set: process memory only. Ciphertext (when the OS
  // keychain is available) additionally persists through `persist`.
  const live = new Map();
  const filePath = dataFilePath ?? defaultDataFilePath();
  const store = persist ?? filePersist(filePath);

  const resolveKeychain = () => {
    if (keychain !== undefined) {
      try {
        return keychain !== null && keychain.isEncryptionAvailable() === true ? keychain : null;
      } catch {
        return null;
      }
    }
    return resolveOsKeychain();
  };

  const persistCipherEntries = () => {
    const active = resolveKeychain();
    if (active === null) return false;
    try {
      const entries = {};
      for (const [sub, pair] of live) {
        entries[sub] = {
          access: active.encryptString(pair.accessToken).toString('base64'),
          refresh: pair.refreshToken === '' ? null : active.encryptString(pair.refreshToken).toString('base64'),
          updatedAt: pair.updatedAt,
        };
      }
      store.writeAll(entries);
      return true;
    } catch {
      // A locked or failing keychain must never break the login that just
      // succeeded: the memory working set keeps serving until restart.
      // The message names the step only — never the secret.
      console.warn('[user-tokens] keychain persist failed; holding tokens in memory');
      return false;
    }
  };

  const readCipherEntries = () => {
    const active = resolveKeychain();
    if (active === null) return {};
    try {
      return store.readAll();
    } catch {
      return {};
    }
  };

  const decryptEntry = (sub, entry) => {
    const active = resolveKeychain();
    if (active === null) return null;
    try {
      const accessToken = active.decryptString(Buffer.from(entry.access, 'base64'));
      const refreshToken = entry.refresh === null || entry.refresh === undefined
        ? ''
        : active.decryptString(Buffer.from(entry.refresh, 'base64'));
      const access = accessTokenSchema.safeParse(accessToken).data;
      if (access === undefined) return null;
      const refresh = refreshToken === '' ? '' : (refreshTokenSchema.safeParse(refreshToken).data ?? '');
      return { accessToken: access, refreshToken: refresh, updatedAt: entry.updatedAt ?? Date.now() };
    } catch {
      // Rekeyed OS keychain, foreign file, or corrupt entry: drop it and
      // read as signed-out rather than serving a half-decrypted secret.
      return null;
    }
  };

  // Stores the pair captured at login completion. Invalid input throws
  // `USER_TOKEN_INVALID` (callers treat it as "no tokens stored"); a
  // failing keychain degrades to memory and still resolves.
  const savePair = async (sub, pair) => {
    const id = subSchema.safeParse(sub).data;
    const access = accessTokenSchema.safeParse(pair?.accessToken).data;
    if (id === undefined || access === undefined) {
      throw new UserTokenStoreError('USER_TOKEN_INVALID', 'Invalid user-token pair.');
    }
    const refreshRaw = pair?.refreshToken === undefined || pair?.refreshToken === null || pair?.refreshToken === ''
      ? ''
      : refreshTokenSchema.safeParse(pair.refreshToken).data;
    if (refreshRaw === undefined) {
      throw new UserTokenStoreError('USER_TOKEN_INVALID', 'Invalid user-token pair.');
    }
    live.set(id, { accessToken: access, refreshToken: refreshRaw, updatedAt: Date.now() });
    persistCipherEntries();
  };

  const readPair = async (sub) => {
    const id = subSchema.safeParse(sub).data;
    if (id === undefined) return null;
    const held = live.get(id);
    if (held) return { accessToken: held.accessToken, refreshToken: held.refreshToken };
    const entry = readCipherEntries()[id];
    if (!entry) return null;
    const decrypted = decryptEntry(id, entry);
    if (!decrypted) return null;
    live.set(id, decrypted);
    return { accessToken: decrypted.accessToken, refreshToken: decrypted.refreshToken };
  };

  const clearPair = async (sub) => {
    const id = subSchema.safeParse(sub).data;
    if (id === undefined) return;
    live.delete(id);
    try {
      const entries = readCipherEntries();
      if (entries[id] !== undefined) {
        delete entries[id];
        store.writeAll(entries);
      }
    } catch {
      // Best-effort: the memory working set (the serving path) is clear.
    }
  };

  const resolveRefreshBase = () => {
    const direct = z.string().min(1).optional().safeParse(serviceBase).data?.trim();
    const raw = direct && direct !== '' ? direct : defaultAuthServiceBase();
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('bad protocol');
      return parsed.origin;
    } catch {
      throw new UserTokenStoreError('USER_TOKEN_REFRESH_TRANSIENT', 'User-token refresh is misconfigured.');
    }
  };

  // Rotates the access token through the auth-service refresh endpoint
  // (`POST {authBase}/auth/token/refresh`, opaque refresh token in,
  // fresh pair out). Resolves the new access token. Throws
  // `USER_TOKEN_NO_REFRESH` (nothing to rotate with),
  // `USER_TOKEN_REFRESH_TRANSIENT` (unreachable/throttled auth-service —
  // callers may serve stale cache), or `USER_TOKEN_REFRESH_REJECTED`
  // (refresh refused — the session is dead).
  const refreshAccessToken = async (sub) => {
    const id = subSchema.safeParse(sub).data;
    if (id === undefined) {
      throw new UserTokenStoreError('USER_TOKEN_NO_REFRESH', 'No user-token pair to refresh.');
    }
    const held = await readPair(id);
    if (!held || held.refreshToken === '') {
      throw new UserTokenStoreError('USER_TOKEN_NO_REFRESH', 'No user-token pair to refresh.');
    }
    const base = resolveRefreshBase();
    let response;
    try {
      response = await serviceFetch(`${base}${USER_TOKEN_REFRESH_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ refresh_token: held.refreshToken }),
        signal: AbortSignal.timeout(USER_TOKEN_SERVICE_TIMEOUT_MS),
      });
    } catch {
      throw new UserTokenStoreError('USER_TOKEN_REFRESH_TRANSIENT', 'User-token refresh is unavailable.');
    }
    if (response.status === 429 || response.status >= 500) {
      throw new UserTokenStoreError('USER_TOKEN_REFRESH_TRANSIENT', 'User-token refresh is unavailable.');
    }
    if (response.status !== 200) {
      throw new UserTokenStoreError('USER_TOKEN_REFRESH_REJECTED', 'User-token refresh was refused.');
    }
    const answer = refreshAnswerSchema.safeParse(await response.json().catch(() => null));
    if (!answer.success) {
      throw new UserTokenStoreError('USER_TOKEN_REFRESH_REJECTED', 'User-token refresh was refused.');
    }
    await savePair(id, {
      accessToken: answer.data.access_token,
      refreshToken: answer.data.refresh_token ?? held.refreshToken,
    });
    return answer.data.access_token;
  };

  return { savePair, readPair, clearPair, refreshAccessToken };
};

let sharedStore = null;

// The production instance shared by the desktop-login capture path and
// the TokenPanel quota proxy: one keychain, one ciphertext file, so a
// pair stored at loopback completion is the pair the proxy presents.
export const sharedUserTokenStore = () => {
  sharedStore ??= createUserTokenStore();
  return sharedStore;
};

// Test seam: in-memory persist with no filesystem touch.
export const memoryUserTokenPersist = () => memoryPersist();

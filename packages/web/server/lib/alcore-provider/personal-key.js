// Personal API-key provisioning client (task 51).
//
// What this owns: the TokenPanel `POST/DELETE /admin/ide/personal-key`
// calls that turn a desktop login into a long-lived provider credential.
// On login the Alcore provider sync mints ONE customer API key with the
// CALLER's own keychained Bearer and stores that key (never the rotating
// login token) as the OpenCode `alcore` credential; on global sign-out it
// revokes the minted key id, then the existing removal runs. The minted
// secret crosses exactly two seams — the mint response into the OpenCode
// credential + ambient env — and is never logged, never placed in a URL,
// never written to disk: only the non-secret key id persists (per subject,
// `<dataDir>/alcore-personal-keys.json`, mode 0o600) so a restart still
// knows which row to revoke. The login pair itself is untouched here:
// refresh/clear discipline stays with `user-token-store`.
//
// Caller auth: the mint/revoke calls present the caller's own access Bearer
// (`Authorization: Bearer`, never a service/management key). A 401
// refreshes ONCE through the store's auth-service rotation and retries; a
// second 401 (or a refused/missing refresh) throws SESSION_EXPIRED without
// clearing the pair — mint/revoke never mutate the token store, so a
// provisioning failure can never break the proven login nor sign the user
// out (the quota path owns dead-session discipline). Anything still failing
// resolves a PersonalKeyError and the provider sync degrades to
// "Not signed in" with the login standing.
//
// Base URL contract: the TokenPanel origin (`TOKENPANEL_API_URL` override,
// else the base of record) — the SAME origin the quota proxy and the
// catalog sync already use. No second hardcoded platform URL lives here.
// The personal-key surface hangs directly under it (`/admin/ide/...`),
// never under `/v1`.
//
// Enterprise boundary (provider-entry class): the provider runtime checks
// enterprise mode BEFORE minting, so no key is ever minted while the mode
// is on; removal (revoke + credential wipe) always runs. This module does
// no mode check itself — it is the transport the gated caller uses.
//
// Surfaces (ui-api-decoupling): web and Electron desktop share these server
// paths (desktop-login sync, reset cleanup); VS Code runs no such server
// (no Alcore card there); hosted/Capacitor mobile inherit the shared-UI
// behavior wherever this server runs.
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TOKENPANEL_DEFAULT_BASE } from '../tokenpanel/tokenpanel-quota.js';

export const PERSONAL_KEY_MINT_PATH = '/admin/ide/personal-key';
const PERSONAL_KEY_SERVICE_TIMEOUT_MS = 15_000;
const PERSONAL_KEY_FILE_NAME = 'alcore-personal-keys.json';
const PERSONAL_KEY_FILE_MODE = 0o600;

export class PersonalKeyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PersonalKeyError';
    this.code = code;
  }
}

const subSchema = z.string().trim().min(1).max(128);
const keyIdSchema = z.string().trim().min(1).max(128);
// The mint answer carries the full secret exactly once: parsed at this
// boundary, never passed on raw.
const mintAnswerSchema = z.object({
  keyId: keyIdSchema,
  key: z.string().trim().min(1).max(8192),
  prefix: z.string().trim().min(1).max(64),
}).passthrough();
const revokeAnswerSchema = z.object({
  revoked: z.array(z.string()).optional(),
}).passthrough();
const storedEntriesSchema = z.record(
  z.string(),
  z.object({
    keyId: keyIdSchema,
    updatedAt: z.number(),
  }),
);

const defaultKeyIdFilePath = () => {
  const root = process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber');
  return path.join(root, PERSONAL_KEY_FILE_NAME);
};

// Test seam: process-memory key-id refs, no filesystem touch.
export const memoryKeyIdStore = () => {
  const held = new Map();
  const check = (sub, keyId) => {
    const id = subSchema.safeParse(sub).data;
    const key = keyIdSchema.safeParse(keyId).data;
    if (id === undefined || key === undefined) {
      throw new PersonalKeyError('PERSONAL_KEY_INVALID', 'Invalid personal-key reference.');
    }
    return { id, key };
  };
  return {
    saveKeyId: async (sub, keyId) => {
      const { id, key } = check(sub, keyId);
      held.set(id, { keyId: key, updatedAt: Date.now() });
    },
    readKeyId: async (sub) => {
      const id = subSchema.safeParse(sub).data;
      if (id === undefined) return null;
      return held.get(id)?.keyId ?? null;
    },
    clearKeyId: async (sub) => {
      const id = subSchema.safeParse(sub).data;
      if (id === undefined) return;
      held.delete(id);
    },
  };
};

// Restart-safe key-id refs: `{ sub: { keyId, updatedAt } }` JSON beside the
// other server stores. The key id is a non-secret row reference, but the
// file still gets the 0o600 treatment. A missing or corrupt file reads as
// empty: the next login mints fresh and revoke-all covers the orphan.
export const createFileKeyIdStore = ({ filePath } = {}) => {
  const resolved = filePath ?? defaultKeyIdFilePath();
  const readAll = () => {
    try {
      const raw = fs.readFileSync(resolved, 'utf8');
      return storedEntriesSchema.safeParse(JSON.parse(raw)?.entries).data ?? {};
    } catch {
      return {};
    }
  };
  const writeAll = (entries) => {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, JSON.stringify({ version: 1, entries }), { mode: PERSONAL_KEY_FILE_MODE });
  };
  return {
    saveKeyId: async (sub, keyId) => {
      const id = subSchema.safeParse(sub).data;
      const key = keyIdSchema.safeParse(keyId).data;
      if (id === undefined || key === undefined) {
        throw new PersonalKeyError('PERSONAL_KEY_INVALID', 'Invalid personal-key reference.');
      }
      const entries = readAll();
      entries[id] = { keyId: key, updatedAt: Date.now() };
      writeAll(entries);
    },
    readKeyId: async (sub) => {
      const id = subSchema.safeParse(sub).data;
      if (id === undefined) return null;
      return readAll()[id]?.keyId ?? null;
    },
    clearKeyId: async (sub) => {
      const id = subSchema.safeParse(sub).data;
      if (id === undefined) return;
      const entries = readAll();
      if (entries[id] !== undefined) {
        delete entries[id];
        writeAll(entries);
      }
    },
  };
};

const readConfiguredBase = (explicit, env) => {
  const direct = z.string().min(1).optional().safeParse(explicit).data?.trim().replace(/\/+$/, '');
  if (direct) return direct;
  const fromEnv = z.string().optional().safeParse(env?.TOKENPANEL_API_URL).data?.trim().replace(/\/+$/, '');
  return fromEnv && fromEnv !== '' ? fromEnv : TOKENPANEL_DEFAULT_BASE;
};

export const resolvePersonalKeyBase = (explicit, env = process.env) => {
  const raw = readConfiguredBase(explicit, env);
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('bad protocol');
    return parsed.origin;
  } catch {
    throw new PersonalKeyError('PERSONAL_KEY_MISCONFIGURED', 'TokenPanel base URL is misconfigured.');
  }
};

export const createPersonalKeyRuntime = ({
  serviceBase,
  serviceFetch = (...args) => fetch(...args),
  // Shared keychain store (production wiring passes the singleton; tests
  // inject a memory fake). Null reads as "no stored pairs".
  userTokenStore = null,
  // Key-id refs (production: file-backed; tests: memory). Null disables
  // persistence without touching mint/revoke — sign-out then falls back
  // to the server's revoke-all for the caller.
  keyIdStore = null,
  env = process.env,
} = {}) => {
  const readStoredAccess = async (sub) => {
    if (userTokenStore === null || userTokenStore === undefined) return '';
    try {
      const pair = await userTokenStore.readPair(sub);
      const access = z.object({ accessToken: z.string() }).safeParse(pair).data?.accessToken ?? '';
      return access.trim();
    } catch {
      return '';
    }
  };

  const postMint = (base, accessToken) => serviceFetch(`${base}${PERSONAL_KEY_MINT_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(PERSONAL_KEY_SERVICE_TIMEOUT_MS),
  });

  const deleteKey = (base, accessToken, keyId) => serviceFetch(`${base}${PERSONAL_KEY_MINT_PATH}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(keyId === undefined ? {} : { keyId }),
    signal: AbortSignal.timeout(PERSONAL_KEY_SERVICE_TIMEOUT_MS),
  });

  // One auth-service rotation for a 401, then exactly one retry. Resolves
  // the live response, or throws PERSONAL_KEY_SESSION_EXPIRED when the
  // session is dead. Never clears the pair: provisioning must not sign
  // the user out from under a proven login.
  const withOneRefresh = async (sub, attempt) => {
    let first;
    try {
      first = await attempt(await readStoredAccess(sub));
    } catch {
      throw new PersonalKeyError('PERSONAL_KEY_UNAVAILABLE', 'TokenPanel personal-key service is unavailable.');
    }
    if (first.status !== 401) return first;
    if (userTokenStore === null || userTokenStore === undefined) {
      throw new PersonalKeyError('PERSONAL_KEY_SESSION_EXPIRED', 'TokenPanel session has expired.');
    }
    let fresh = '';
    try {
      fresh = String(await userTokenStore.refreshAccessToken(sub) ?? '').trim();
    } catch {
      throw new PersonalKeyError('PERSONAL_KEY_SESSION_EXPIRED', 'TokenPanel session has expired.');
    }
    if (fresh === '') {
      throw new PersonalKeyError('PERSONAL_KEY_SESSION_EXPIRED', 'TokenPanel session has expired.');
    }
    try {
      return await attempt(fresh);
    } catch {
      throw new PersonalKeyError('PERSONAL_KEY_UNAVAILABLE', 'TokenPanel personal-key service is unavailable.');
    }
  };

  const isTransientStatus = (status) => status === 429 || status >= 500;

  // Mint one personal API key for the caller's own link. Resolves
  // `{ key, keyId, prefix }` (the secret, exactly once — callers store it
  // as the provider credential and never log it) or throws
  // PersonalKeyError. The key-id ref persists best-effort: a failing store
  // still resolves, and sign-out's revoke-all covers the unrecorded row.
  const mintPersonalKey = async (sub) => {
    const id = subSchema.safeParse(sub).data;
    if (id === undefined) {
      throw new PersonalKeyError('PERSONAL_KEY_INVALID_REQUEST', 'Invalid Alcore subject.');
    }
    const base = resolvePersonalKeyBase(serviceBase, env);
    if (userTokenStore === null || userTokenStore === undefined) {
      throw new PersonalKeyError('PERSONAL_KEY_NOT_CONFIGURED', 'No Alcore user token is stored for this session.');
    }
    const access = await readStoredAccess(id);
    if (access === '') {
      throw new PersonalKeyError('PERSONAL_KEY_NOT_CONFIGURED', 'No Alcore user token is stored for this session.');
    }
    const response = await withOneRefresh(id, (token) => postMint(base, token));
    if (response.status === 401) {
      throw new PersonalKeyError('PERSONAL_KEY_SESSION_EXPIRED', 'TokenPanel session has expired.');
    }
    if (isTransientStatus(response.status)) {
      throw new PersonalKeyError('PERSONAL_KEY_UNAVAILABLE', 'TokenPanel personal-key service is unavailable.');
    }
    if (response.status !== 200 && response.status !== 201) {
      throw new PersonalKeyError('PERSONAL_KEY_REJECTED', 'TokenPanel refused the personal-key mint.');
    }
    const answer = mintAnswerSchema.safeParse(await response.json().catch(() => null));
    if (!answer.success) {
      throw new PersonalKeyError('PERSONAL_KEY_REJECTED', 'TokenPanel answered an unusable mint body.');
    }
    if (keyIdStore !== null && keyIdStore !== undefined) {
      try {
        await keyIdStore.saveKeyId(id, answer.data.keyId);
      } catch {
        // Best-effort: the secret is already issued and usable; sign-out
        // revokes every personal row when no id was recorded.
        console.warn('[personal-key] key-id persist failed; sign-out falls back to revoke-all');
      }
    }
    return { key: answer.data.key, keyId: answer.data.keyId, prefix: answer.data.prefix };
  };

  // Revoke the caller's personal key(s): the minted id when known, else
  // every active personal row. Resolves `{ revoked }` (a 404 reads as an
  // empty success — the row is already gone, which is the goal) or throws
  // PersonalKeyError. The stored ref clears best-effort on any settled
  // answer (200 or 404): re-revoking is idempotent.
  const revokePersonalKey = async (sub, keyId) => {
    const id = subSchema.safeParse(sub).data;
    if (id === undefined) {
      throw new PersonalKeyError('PERSONAL_KEY_INVALID_REQUEST', 'Invalid Alcore subject.');
    }
    const key = keyId === undefined ? undefined : keyIdSchema.safeParse(keyId).data;
    if (keyId !== undefined && key === undefined) {
      throw new PersonalKeyError('PERSONAL_KEY_INVALID_REQUEST', 'Invalid personal-key reference.');
    }
    const base = resolvePersonalKeyBase(serviceBase, env);
    if (userTokenStore === null || userTokenStore === undefined) {
      throw new PersonalKeyError('PERSONAL_KEY_NOT_CONFIGURED', 'No Alcore user token is stored for this session.');
    }
    const probe = await readStoredAccess(id);
    if (probe === '') {
      throw new PersonalKeyError('PERSONAL_KEY_NOT_CONFIGURED', 'No Alcore user token is stored for this session.');
    }
    const response = await withOneRefresh(id, (token) => deleteKey(base, token, key));
    if (response.status === 401) {
      throw new PersonalKeyError('PERSONAL_KEY_SESSION_EXPIRED', 'TokenPanel session has expired.');
    }
    if (isTransientStatus(response.status)) {
      throw new PersonalKeyError('PERSONAL_KEY_UNAVAILABLE', 'TokenPanel personal-key service is unavailable.');
    }
    if (response.status === 404) {
      if (keyIdStore !== null && keyIdStore !== undefined) {
        try {
          await keyIdStore.clearKeyId(id);
        } catch {
          // Best-effort: nothing live survives under this subject.
        }
      }
      return { revoked: [] };
    }
    if (response.status !== 200) {
      throw new PersonalKeyError('PERSONAL_KEY_REJECTED', 'TokenPanel refused the personal-key revoke.');
    }
    const answer = revokeAnswerSchema.safeParse(await response.json().catch(() => null));
    // The boundary schema already narrows `revoked` to strings: branch on
    // the domain value, never re-narrow the representation.
    const revoked = answer.success ? (answer.data.revoked ?? []) : [];
    if (keyIdStore !== null && keyIdStore !== undefined) {
      try {
        await keyIdStore.clearKeyId(id);
      } catch {
        // Best-effort: the server already revoked the row(s).
      }
    }
    return { revoked };
  };

  const readKeyId = async (sub) => {
    if (keyIdStore === null || keyIdStore === undefined) return null;
    try {
      return await keyIdStore.readKeyId(sub) ?? null;
    } catch {
      return null;
    }
  };

  return { resolveBase: (explicit) => resolvePersonalKeyBase(explicit, env), mintPersonalKey, revokePersonalKey, readKeyId };
};

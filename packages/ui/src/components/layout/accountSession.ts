import { z } from 'zod';

// Session-shape parser for the header account surface. The desktop session
// shape is owned by desktop-auth/ui-auth and is only READ here: GET
// /auth/session answers `{ authenticated: true }` for cookie sessions and
// adds `scope`/`sub`/`alcore` for Alcore identities. No token, cookie, or
// issuance behavior changes in this module.
//
// Envelope rule: anything that is not an object with `authenticated: true`
// is signed-out (expired, corrupt, or unexpected payloads never get stuck
// on a loading state). Identity fields are parsed leniently on top: a live
// session with unfamiliar extras still signs in, with the unknown parts
// left blank. Tier/capability data renders only when the payload carries
// it — its absence is not an error.

const cleanText = z.string().trim().min(1).max(256);
// Avatar URLs follow the product profile contract (customer_profiles:
// name, avatar_url, updated_at — picture URLs up to 2048 chars), so they
// get the wider bound; over-long values are still dropped, never forged.
const cleanAvatarUrl = z.string().trim().min(1).max(2048);
const cleanTier = z.string().trim().min(1).max(64);

// Identity fields parse per-field leniently: each value is validated by
// its own single-key schema, so a malformed value (wrong type, blank,
// over-long) or a malformed container drops only that read — it never
// fails the whole identity or signs out a live session. Unknown extras
// are stripped by the object schemas and ignored.
const textOf = (holder: SessionStatusPayload, key: string, schema: z.ZodString): string => {
  const parsed = z.object({ [key]: schema }).safeParse(holder);
  if (!parsed.success) return '';
  return parsed.data[key] ?? '';
};

const nestedTextOf = (
  holder: SessionStatusPayload,
  key: string,
  nestedKey: string,
  schema: z.ZodString,
): string => {
  const parsed = z.object({ [key]: z.object({ [nestedKey]: schema }) }).safeParse(holder);
  if (!parsed.success) return '';
  return parsed.data[key]?.[nestedKey] ?? '';
};

const deepTextOf = (
  holder: SessionStatusPayload,
  key: string,
  nestedKey: string,
  deepKey: string,
  schema: z.ZodString,
): string => {
  const parsed = z
    .object({ [key]: z.object({ [nestedKey]: z.object({ [deepKey]: schema }) }) })
    .safeParse(holder);
  if (!parsed.success) return '';
  return parsed.data[key]?.[nestedKey]?.[deepKey] ?? '';
};

const sessionEnvelopeSchema = z.object({
  authenticated: z.boolean(),
});

export type AccountSession =
  | {
      status: 'signed-in';
      displayName: string;
      email: string;
      avatarUrl: string;
      initials: string;
      tier: string;
      /** Raw identity link (alcore sub) for TokenPanel quota reads; empty when the payload carries none. */
      subject: string;
    }
  | { status: 'signed-out' };

// Unvalidated JSON as the session-status endpoint can answer it. The parser
// below turns this into the trusted AccountSession contract.
export interface SessionStatusPayloadObject {
  [key: string]: SessionStatusPayload;
}

export type SessionStatusPayload =
  | string
  | number
  | boolean
  | null
  | undefined
  | SessionStatusPayload[]
  | SessionStatusPayloadObject;

const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const firstPresent = (values: Array<string | undefined>): string => {
  for (const value of values) {
    if (value !== undefined && value !== '') return value;
  }
  return '';
};

export const initialsOf = (displayName: string): string => {
  const match = displayName.trim().match(/[\p{L}\p{N}]/u);
  const first = match?.[0] ?? '';
  return first === '' ? '' : first.toUpperCase();
};

const tierKeys = ['tier', 'plan', 'planName'] as const;
const tierScopes = ['capabilities', 'matrix'] as const;

const tierOfHolder = (holder: SessionStatusPayload, prefix: string): string =>
  firstPresent([
    ...tierKeys.map((key) =>
      prefix === '' ? textOf(holder, key, cleanTier) : nestedTextOf(holder, prefix, key, cleanTier),
    ),
    ...tierScopes.flatMap((scope) =>
      tierKeys.map((key) =>
        prefix === ''
          ? nestedTextOf(holder, scope, key, cleanTier)
          : deepTextOf(holder, prefix, scope, key, cleanTier),
      ),
    ),
  ]);

export const parseAccountSession = (payload: SessionStatusPayload): AccountSession => {
  const envelope = sessionEnvelopeSchema.safeParse(payload);
  if (!envelope.success || envelope.data.authenticated !== true) {
    return { status: 'signed-out' };
  }
  const top = payload;

  const sub = firstPresent([nestedTextOf(payload, 'alcore', 'sub', cleanText), textOf(top, 'sub', cleanText)]);
  const email = firstPresent([
    nestedTextOf(payload, 'alcore', 'email', cleanText),
    textOf(top, 'email', cleanText),
    EMAIL_LIKE.test(sub) ? sub : undefined,
  ]);
  const displayName = firstPresent([
    nestedTextOf(payload, 'alcore', 'name', cleanText),
    nestedTextOf(payload, 'alcore', 'displayName', cleanText),
    textOf(top, 'name', cleanText),
    textOf(top, 'displayName', cleanText),
    email,
    sub,
  ]);
  // Product profile shape (customer_profiles) uses snake_case avatar_url;
  // updated_at carries no display value and is ignored.
  const avatarUrl = firstPresent([
    nestedTextOf(payload, 'alcore', 'avatarUrl', cleanAvatarUrl),
    nestedTextOf(payload, 'alcore', 'picture', cleanAvatarUrl),
    nestedTextOf(payload, 'alcore', 'avatar_url', cleanAvatarUrl),
    textOf(top, 'avatarUrl', cleanAvatarUrl),
    textOf(top, 'picture', cleanAvatarUrl),
    textOf(top, 'avatar_url', cleanAvatarUrl),
  ]);
  const tier = firstPresent([tierOfHolder(payload, 'alcore'), tierOfHolder(top, '')]);

  return {
    status: 'signed-in',
    displayName,
    email,
    avatarUrl,
    initials: initialsOf(displayName),
    tier,
    subject: sub,
  };
};

// Capability-based IDE account gate (project-ide todo 10).
//
// Check order: login -> WHO (auth-service session) -> customer lookup (tier
// string) -> tier (TokenPanel read API, task-9 contract) -> gate. A
// short-lived capability is minted at login (TTL from the tier matrix
// fixture, default 15 minutes); every engine invocation verifies the
// capability LOCALLY with zero TokenPanel calls; an async refresh re-reads
// the tier in the background so a tier flip lands within one TTL, no rebuild.
//
// TokenPanel contract (API of record: .omo/evidence/task-9-project-ide.md):
//   GET /gate?tier= -> 200 {tier, allowed, ideAccess, features, ttlMinutes,
//     source: "live", stale: false}
//   TTL cache default 15 min; transient failures serve the last-known
//     capability within one TTL of grace with stale:true; past grace -> 503
//     deny-closed; unknown tier / non-transient failure -> deny, never escalate.
// The live reader is injected (`tokenPanel.getGate(tier)`), so this module
// never imports TokenPanel code; tests drive it with a fixture stub whose
// bodies match the documented shapes.
//
// Surfaces (ui-api-decoupling): web + Electron desktop enforce the gate in
// the server invocation path (same server); VS Code / hosted-mobile /
// Capacitor-mobile pane rendering is explicitly unsupported in this plan
// (mobile ships with the pane excluded, CLI is text-only) - the pure
// `chromeForCapability` helper still answers for any caller, and the server
// gate answers identically wherever it runs. No localhost/port/credential
// assumptions live here; capability signing uses the gate secret only and
// never touches pairing crypto (out of scope, untouched).
import crypto from 'node:crypto';
import { z } from 'zod';

export const IDE_GATE_CAPABILITY_VERSION = 1;
export const IDE_GATE_DEFAULT_TTL_MINUTES = 15;
export const IDE_GATE_MINUTE_MS = 60_000;
export const IDE_GATE_ALL_FEATURES = ['basic-ide', 'full-access'];

const tierSchema = z.enum(['free-tier', 'pending-payment', 'paid']);
const ideAccessSchema = z.enum(['allow', 'deny']);

const gateBodySchema = z.object({
  tier: tierSchema,
  allowed: z.boolean(),
  ideAccess: ideAccessSchema,
  features: z.array(z.string().min(1)),
  ttlMinutes: z.number().int().min(1).max(1440),
  source: z.enum(['live', 'cache']).optional(),
  stale: z.boolean().optional(),
});

const whoSessionSchema = z.object({
  sub: z.string().min(1),
  sid: z.string().min(1),
});

const capabilitySchema = z.object({
  v: z.literal(IDE_GATE_CAPABILITY_VERSION),
  sub: z.string().min(1),
  sid: z.string().min(1),
  tier: tierSchema,
  allowed: z.boolean(),
  ideAccess: ideAccessSchema,
  features: z.array(z.string().min(1)),
  iat: z.number().int().min(0),
  exp: z.number().int().min(0),
});

const fixtureTierSchema = z.object({
  tier: tierSchema,
  ideAccess: ideAccessSchema,
  features: z.array(z.string().min(1)),
  ttlMinutes: z.number().int().min(1).max(1440),
});

const fixtureSchema = z.object({
  tiers: z.array(fixtureTierSchema).min(1),
});

export class IdeGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IdeGateError';
    this.code = code;
  }
}

const isRecord = (value) => value instanceof Object && !Array.isArray(value);

export const ttlMsForMinutes = (minutes, fallback = IDE_GATE_DEFAULT_TTL_MINUTES) => {
  const parsed = z.number().int().min(1).max(1440).safeParse(minutes);
  const valid = parsed.success ? parsed.data : fallback;
  return valid * IDE_GATE_MINUTE_MS;
};

// Validates the tier-matrix fixture text (todo 3 shape). Returns the parsed
// tiers; throws IdeGateError on malformed input (bad tier, negative TTL).
export const loadTierMatrixFixture = (jsonText) => {
  let raw = null;
  try {
    raw = JSON.parse(String(jsonText));
  } catch {
    throw new IdeGateError('IDE_FIXTURE_MALFORMED', 'Tier matrix fixture is not valid JSON.');
  }
  const parsed = fixtureSchema.safeParse(raw);
  if (!parsed.success) {
    throw new IdeGateError('IDE_FIXTURE_MALFORMED', 'Tier matrix fixture failed schema validation.');
  }
  return parsed.data;
};

const canonicalForSig = (capability) => JSON.stringify([
  capability.v,
  capability.sub,
  capability.sid,
  capability.tier,
  capability.allowed,
  capability.ideAccess,
  capability.features,
  capability.iat,
  capability.exp,
]);

const signCanonical = (secret, canonical) => {
  const key = Buffer.from(String(secret), 'utf8');
  return crypto.createHmac('sha256', key).update(canonical, 'utf8').digest('hex');
};

const signatureFor = (secret, capability) => signCanonical(secret, canonicalForSig(capability));

const signaturesEqual = (presented, expected) => {
  const a = Buffer.from(String(presented), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// A TokenPanel failure is transient only when the reader says so
// (code TOKENPANEL_TRANSIENT). Every other rejection - including unknown
// tier and schema violations - is hard-invalid and denies closed.
const isTransientFailure = (error) => isRecord(error) && error.code === 'TOKENPANEL_TRANSIENT';

export const createIdeGate = (options) => {
  const parsed = z.object({
    secret: z.string().min(8),
    tokenPanel: z.object({ getGate: z.function() }),
    now: z.function().optional(),
    ttlMinutesFallback: z.number().int().min(1).max(1440).optional(),
  }).safeParse(options);
  if (!parsed.success) {
    throw new IdeGateError('IDE_GATE_MISCONFIGURED', 'createIdeGate needs { secret, tokenPanel.getGate }.');
  }
  const secret = parsed.data.secret;
  const tokenPanel = parsed.data.tokenPanel;
  const nowFn = parsed.data.now ?? Date.now;
  const fallbackMinutes = parsed.data.ttlMinutesFallback ?? IDE_GATE_DEFAULT_TTL_MINUTES;
  const cache = new Map();

  const ttlMsForBody = (body) => ttlMsForMinutes(body.ttlMinutes, fallbackMinutes);

  // Tier read with task-9 fallback. Returns { body, stale } where body keeps
  // the documented GET /gate shape. Transient outage + warm cache within one
  // TTL of grace -> cached body with stale:true. Past grace -> throws
  // IdeGateError IDE_GATE_UNAVAILABLE (caller maps to 503 deny-closed).
  // Hard-invalid (unknown tier, validation failure, non-transient) -> throws
  // IdeGateError IDE_GATE_DENIED (caller denies, never serves stale).
  const resolveTierBody = async (tier) => {
    const tierParsed = tierSchema.safeParse(tier);
    if (!tierParsed.success) {
      throw new IdeGateError('IDE_GATE_DENIED', 'Unknown tier denied.');
    }
    const validTier = tierParsed.data;
    let live = null;
    try {
      const raw = await tokenPanel.getGate(validTier);
      const bodyParsed = gateBodySchema.safeParse(raw);
      if (!bodyParsed.success) {
        throw new IdeGateError('IDE_GATE_DENIED', 'TokenPanel answered an invalid gate body; denied.');
      }
      live = { ...bodyParsed.data, source: 'live', stale: false };
    } catch (error) {
      if (error instanceof IdeGateError) throw error;
      if (!isTransientFailure(error)) {
        throw new IdeGateError('IDE_GATE_DENIED', 'TokenPanel hard failure; denied.');
      }
      const cached = cache.get(validTier);
      const now = nowFn();
      if (cached && now - cached.fetchedAt <= 2 * ttlMsForBody(cached.body)) {
        return { body: { ...cached.body, source: 'cache', stale: true }, stale: true };
      }
      throw new IdeGateError('IDE_GATE_UNAVAILABLE', 'TokenPanel unavailable past grace; deny-closed.');
    }
    cache.set(validTier, { body: live, fetchedAt: nowFn() });
    return { body: live, stale: false };
  };

  const mintFromBody = (who, body) => {
    const iat = nowFn();
    const unsigned = {
      v: IDE_GATE_CAPABILITY_VERSION,
      sub: who.sub,
      sid: who.sid,
      tier: body.tier,
      allowed: body.allowed,
      ideAccess: body.ideAccess,
      features: [...body.features],
      iat,
      exp: iat + ttlMsForBody(body),
    };
    const sig = signatureFor(secret, unsigned);
    return { ...unsigned, sig };
  };

  // login -> WHO -> customer tier -> tier -> gate. `whoSession` is the
  // auth-service WHO shape { sub, sid }; `customerTier` is the customer
  // lookup result (tier string). Mints the login capability. Malformed WHO,
  // bad tier, or denied tier surface as IdeGateError (login must not mint).
  const mintAtLogin = async (login) => {
    const loginParsed = z.object({
      whoSession: whoSessionSchema,
      customerTier: z.string().min(1),
    }).safeParse(login);
    if (!loginParsed.success) {
      throw new IdeGateError('IDE_GATE_DENIED', 'Malformed login identity denied.');
    }
    const tierParsed = tierSchema.safeParse(loginParsed.data.customerTier);
    if (!tierParsed.success) {
      throw new IdeGateError('IDE_GATE_DENIED', 'Unknown tier denied.');
    }
    const resolved = await resolveTierBody(tierParsed.data);
    const capability = mintFromBody(loginParsed.data.whoSession, resolved.body);
    return { capability, gateBody: resolved.body, stale: resolved.stale };
  };

  // Pure local verification: signature + shape + expiry. Makes no
  // TokenPanel call by construction (no reader reference on this path).
  const verifyLocally = (capability) => {
    const decoded = z.object({
      v: z.literal(IDE_GATE_CAPABILITY_VERSION),
      sub: z.string().min(1),
      sid: z.string().min(1),
      tier: tierSchema,
      allowed: z.boolean(),
      ideAccess: ideAccessSchema,
      features: z.array(z.string().min(1)),
      iat: z.number().int().min(0),
      exp: z.number().int().min(0),
      sig: z.string().min(1),
    }).safeParse(capability);
    if (!decoded.success) {
      return { ok: false, reason: 'malformed' };
    }
    const candidate = decoded.data;
    const expected = signatureFor(secret, candidate);
    if (!signaturesEqual(candidate.sig, expected)) {
      return { ok: false, reason: 'tampered' };
    }
    if (candidate.exp <= nowFn() || candidate.iat > candidate.exp) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, capability: candidate };
  };

  // Per-invocation gate: local only. Tampered/expired/malformed -> denied;
  // valid capability -> its own allowed flag decides. Zero TokenPanel calls.
  const checkInvocation = (capability) => {
    const verdict = verifyLocally(capability);
    if (!verdict.ok) {
      return { allowed: false, reason: verdict.reason };
    }
    if (!verdict.capability.allowed || verdict.capability.ideAccess !== 'allow') {
      return { allowed: false, reason: 'tier-denied' };
    }
    return { allowed: true, reason: 'ok', capability: verdict.capability };
  };

  // Async refresh: re-reads the tier so a tier flip lands within one TTL
  // without a rebuild. Tampered input denies without a TokenPanel call;
  // expired-but-intact input still refreshes (expiry denies invocation, not
  // refresh). Transient outage follows the same grace rule; past grace or
  // hard-invalid denies closed.
  const refresh = async (capability) => {
    const decodedRefresh = z.object({
      v: z.literal(IDE_GATE_CAPABILITY_VERSION),
      sub: z.string().min(1),
      sid: z.string().min(1),
      tier: tierSchema,
      allowed: z.boolean(),
      ideAccess: ideAccessSchema,
      features: z.array(z.string().min(1)),
      iat: z.number().int().min(0),
      exp: z.number().int().min(0),
      sig: z.string().min(1),
    }).safeParse(capability);
    if (!decodedRefresh.success) {
      throw new IdeGateError('IDE_GATE_DENIED', 'Malformed capability denied.');
    }
    const candidate = decodedRefresh.data;
    if (!signaturesEqual(candidate.sig, signatureFor(secret, candidate))) {
      throw new IdeGateError('IDE_GATE_DENIED', 'Tampered capability denied.');
    }
    const resolved = await resolveTierBody(candidate.tier);
    const next = mintFromBody({ sub: candidate.sub, sid: candidate.sid }, resolved.body);
    return { capability: next, gateBody: resolved.body, stale: resolved.stale };
  };

  // Pane chrome model: tier badge + locked features. Pure derivation, no I/O.
  const chromeForCapability = (capability) => {
    const verdict = verifyLocally(capability);
    if (!verdict.ok) {
      return {
        badge: 'IDE · locked',
        allowed: false,
        tier: null,
        features: [],
        locked: [...IDE_GATE_ALL_FEATURES],
        reason: verdict.reason,
      };
    }
    const granted = verdict.capability.features;
    const locked = IDE_GATE_ALL_FEATURES.filter((feature) => !granted.includes(feature));
    const allowed = verdict.capability.allowed && verdict.capability.ideAccess === 'allow';
    return {
      badge: allowed ? `IDE · ${verdict.capability.tier}` : 'IDE · locked',
      allowed,
      tier: verdict.capability.tier,
      features: [...granted],
      locked,
      reason: allowed ? 'ok' : 'tier-denied',
    };
  };

  return {
    resolveTierBody,
    mintAtLogin,
    verifyLocally,
    checkInvocation,
    refresh,
    chromeForCapability,
  };
};

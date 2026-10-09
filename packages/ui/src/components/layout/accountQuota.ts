import React from 'react';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { clearAutoSignOutMark, signOutToGateOnce } from './signOutToGate';

// Live TokenPanel quota beside the tier badge (task 35). The TokenPanel
// quota read API owns usage/balance; this module only READS its shape over
// `runtimeFetch('/api/tokenpanel/quota?authUserId=')` — the identity link
// is the alcore `sub` the session parser already carries (`subject`).
// Surfaces: web and desktop show the quota; hosted and Capacitor mobile
// inherit the same shared-UI behavior; VS Code hides the account surface
// entirely (AccountProfile returns null there, so this hook never runs).
//
// States mirror the API contract: `live` (source live, stale false),
// `stale-cached` (source cache, stale true), `unavailable` (any fetch
// failure, non-200, or malformed body — never a blank crash, never a
// fabricated quota). A missing subject means no identity to query, which
// is also `unavailable`, not an error. The one exception is the proxy's
// 401 `tokenpanel_session_expired` (the stored pair is dead and refresh
// refused it): that signs out to the gate once via signOutToGate, then
// reads `unavailable` like every other failure.

const quotaBalanceSchema = z.object({
  amountMicros: z.number(),
  reservedMicros: z.number(),
  availableMicros: z.number(),
  currency: z.string().min(1).max(8),
});

const quotaUsageSchema = z.object({
  totalRequests: z.number(),
  totalTokens: z.number(),
  totalCostMicros: z.number(),
  totalPriceMicros: z.number(),
  currency: z.string().min(1).max(8),
});

const quotaPayloadSchema = z.object({
  authUserId: z.string().min(1).max(128),
  customerId: z.string().min(1).max(64),
  balance: quotaBalanceSchema,
  usage: quotaUsageSchema,
  source: z.union([z.literal('live'), z.literal('cache')]),
  stale: z.boolean(),
});

export type AccountQuotaBalance = z.infer<typeof quotaBalanceSchema>;
export type AccountQuotaUsage = z.infer<typeof quotaUsageSchema>;

// Unvalidated JSON as the quota endpoint can answer it. The parser below
// turns this into the trusted AccountQuota contract (same boundary rule as
// accountSession.ts: network payloads enter only through this named type).
export interface AccountQuotaPayloadObject {
  [key: string]: AccountQuotaPayload;
}

export type AccountQuotaPayload =
  | string
  | number
  | boolean
  | null
  | undefined
  | AccountQuotaPayload[]
  | AccountQuotaPayloadObject;

export type AccountQuota =
  | { state: 'live'; balance: AccountQuotaBalance; usage: AccountQuotaUsage }
  | { state: 'stale-cached'; balance: AccountQuotaBalance; usage: AccountQuotaUsage }
  | { state: 'unavailable' };

export const parseAccountQuota = (payload: AccountQuotaPayload): AccountQuota => {
  const parsed = quotaPayloadSchema.safeParse(payload);
  if (!parsed.success) return { state: 'unavailable' };
  const { balance, usage, stale } = parsed.data;
  if (stale) return { state: 'stale-cached', balance, usage };
  return { state: 'live', balance, usage };
};

/** Micros (10^-6 major) to major units at the display boundary only. */
export const quotaAvailableMajor = (balance: AccountQuotaBalance): number =>
  balance.availableMicros / 1_000_000;

const QUOTA_REFRESH_MS = 3 * 60 * 1000;

/** The proxy's TokenPanel-session-expired signal: refresh is dead, sign out. */
const TOKENPANEL_SESSION_EXPIRED = 'tokenpanel_session_expired';

/** 401 + the expired code — and only that — is the sign-out trigger. */
export const isTokenpanelSessionExpired = (status: number, payload: AccountQuotaPayload): boolean => {
  if (status !== 401) return false;
  return z.object({ error: z.literal(TOKENPANEL_SESSION_EXPIRED) }).safeParse(payload).success;
};

export const fetchAccountQuota = async (authUserId: string, signal: AbortSignal): Promise<AccountQuota> => {
  if (authUserId === '') return { state: 'unavailable' };
  const response = await runtimeFetch(
    `/api/tokenpanel/quota?authUserId=${encodeURIComponent(authUserId)}`,
    { method: 'GET', credentials: 'include', headers: { Accept: 'application/json' }, signal },
  );
  if (!response.ok) {
    if (isTokenpanelSessionExpired(response.status, await response.json().catch(() => null))) {
      // The stored pair is dead and refresh refused it: leave the gate
      // path — sign out once, then read as unavailable like every other
      // failure (never a blank crash, never a fabricated quota).
      await signOutToGateOnce();
    }
    return { state: 'unavailable' };
  }
  clearAutoSignOutMark();
  const payload = await response.json().catch(() => null);
  return parseAccountQuota(payload);
};

/**
 * Live quota for the signed-in identity. Fetches on mount/subject change,
 * refreshes every 3 minutes while mounted, and re-fetches on runtime
 * endpoint switches. Returns null while the first read is in flight
 * (loading), then a stable `AccountQuota` — failures land on
 * `unavailable`, never null, so callers never blank-crash.
 */
export const useAccountQuota = (authUserId: string | null): AccountQuota | null => {
  const [quota, setQuota] = React.useState<AccountQuota | null>(null);
  React.useEffect(() => {
    if (authUserId === null || authUserId === '') {
      setQuota({ state: 'unavailable' });
      return;
    }
    let settled = false;
    const controller = new AbortController();
    setQuota(null);
    void fetchAccountQuota(authUserId, controller.signal)
      .then((next) => {
        if (!settled) setQuota(next);
      })
      .catch(() => {
        if (!settled) setQuota({ state: 'unavailable' });
      });
    const timer = window.setInterval(() => {
      const refresh = new AbortController();
      void fetchAccountQuota(authUserId, refresh.signal)
        .then((next) => {
          if (!settled) setQuota(next);
        })
        .catch(() => {
          if (!settled) setQuota({ state: 'unavailable' });
        });
    }, QUOTA_REFRESH_MS);
    const unsubscribe = subscribeRuntimeEndpointChanged(() => {
      if (settled) return;
      const retry = new AbortController();
      void fetchAccountQuota(authUserId, retry.signal)
        .then((next) => {
          if (!settled) setQuota(next);
        })
        .catch(() => {
          if (!settled) setQuota({ state: 'unavailable' });
        });
    });
    return () => {
      settled = true;
      controller.abort();
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [authUserId]);
  return quota;
};

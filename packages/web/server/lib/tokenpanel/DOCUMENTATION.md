# TokenPanel Quota Proxy Documentation

## Purpose

Owns `GET /api/tokenpanel/quota?authUserId=`, the live quota read behind
the header account surface (`useAccountQuota` in
`packages/ui/src/components/layout/accountQuota.ts`).

## Files

- `packages/web/server/lib/tokenpanel/tokenpanel-quota.js`: route runtime
  (`createTokenpanelQuotaRuntime`), mounted in
  `feature-routes-runtime.js` beside the other explicit routes — behind the
  existing `/api` session gate, before the generic OpenCode proxy.
- `packages/web/server/lib/tokenpanel/tokenpanel-quota.test.js`:
  serviceFetch-stub tests (no servers, manual clock seam).

## Flows

Read-through with the ide-gate fallback discipline: live wins; a transient
outage (network/timeout/5xx/429) serves the last-known body within one TTL
of grace (60 s) with `source:'cache', stale:true`; past grace (or a cold
cache) fails closed with 503. Hard-invalid answers (403/404 from the
upstream, malformed body) never serve stale and answer 502. A caller with
no stored pair answers 503 `tokenpanel_not_configured` without calling
upstream. Every failure shape maps to the hook's `unavailable` state —
except `tokenpanel_session_expired` (below) — never a fabricated quota.

## Caller auth (user Bearer, no service keys)

The proxy presents the CALLER's own access Bearer — the keychained pair
the desktop login captured at loopback completion (see
`packages/web/server/lib/user-tokens/user-token-store.js`) — as
`Authorization: Bearer` against `TOKENPANEL_API_URL` (default
`https://alcore.io.vn`). No management key is read on this path:
management keys must never appear in user-facing flows (a server-to-server
management contract may exist elsewhere, out of scope here). Self-only is
enforced before any upstream call: `authUserId` must equal the session's
Alcore `sub` (resolved through the injected `resolveSubject`, wired to
`uiAuthController.resolveRequestAlcoreSub`); a mismatch answers 403
`tokenpanel_forbidden` without touching tokens or the network. The token
is never logged, never placed in a URL, and never sent to the browser.
Base and pair resolve per request, so rotation applies without a restart.
Upstream `Set-Cookie` headers are never forwarded: the handler answers
with its own `res.status().json()`.

An upstream 401 (expired access JWT) refreshes ONCE through the store's
auth-service rotation (`POST {authBase}/auth/token/refresh`) and retries
with the fresh token. A refused refresh, a missing refresh token, or a
second 401 clears the stored pair and answers 401
`tokenpanel_session_expired` — the renderer's cue to sign out to the gate
(`signOutToGateOnce` in `packages/ui/src/components/layout/`). A refresh
that fails transiently keeps the stale-in-grace behavior above.

## Public exports (tokenpanel-quota.js)

- `createTokenpanelQuotaRuntime({ serviceBase, serviceFetch, now,
  cacheTtlMs, userTokenStore, resolveSubject })`:
  `{ registerRoutes, resolveQuotaBody }` plus `_`-free test seams through
  the injected options. `resolveQuotaBody(authUserId, subject)` throws
  `TokenpanelQuotaError` (`TOKENPANEL_INVALID_REQUEST` /
  `TOKENPANEL_FORBIDDEN` / `TOKENPANEL_NOT_CONFIGURED` /
  `TOKENPANEL_MISCONFIGURED` / `TOKENPANEL_TRANSIENT` /
  `TOKENPANEL_REJECTED` / `TOKENPANEL_SESSION_EXPIRED`).

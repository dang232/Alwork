# Desktop Auth Module Documentation

## Purpose

Cursor-style sign-in for the app gate: Email (password / signup / OTP code) and
Continue with Google via the system browser. The Alcore auth-service owns
identity; this module only translates its session pairs into IDE UI sessions.
Repo C is never modified: every flow uses its existing endpoints
(`/auth/login`, `/auth/register`, `/auth/verify-otp`, `/auth/otp-resend`,
`/auth/google/config`, `/auth/google/verify`).

## Files

- `packages/web/server/lib/desktop-auth/desktop-auth.js`: route runtime
  (`createDesktopAuthRuntime`), mounted inside `registerAuthAndAccessRoutes`
  before the `/api` auth gate and the generic OpenCode proxy.
- `packages/electron/main.mjs` (`desktop_start_google_login` IPC): starts the
  Google request against the local server and opens the minted page in the
  system browser. The only URL this channel ever opens is that page.
- `packages/ui/src/components/auth/SessionAuthGate.tsx`: Email + Continue,
  password, signup, code, and Google views. No token-paste field exists.

## Flows

Email: renderer → same-origin proxy → service. On a service pair the proxy
rewrites the body to `{alcoreToken}` and delegates to
`uiAuthController.handleSessionCreate`, so session cookies, TTLs, rate limits,
and client tokens stay on the one path that owns them. Service failures pass
through with their status (401 invalid credentials, 403 email_not_verified,
409 email_taken, 429 with Retry-After). Service `Set-Cookie` is never
forwarded: handlers answer with their own `res.status().json()`.

Google: `POST /api/auth/desktop/google/start` mints a single-use requestId and
returns a same-origin page URL. The loopback GIS page (`GET
/auth/desktop-google?requestId=`) embeds the service Google client id and
POSTs the GIS credential to `/api/auth/desktop/google-capture`, which holds it
(5-minute TTL, single use). The app polls `/api/auth/desktop/google-complete`,
which verifies the credential with the service and delegates to the session
handler like email. The renderer never sees the credential.

Completion requires this server to verify Alcore tokens (shared
`ALCORE_JWT_SECRET`/`JWT_SECRET`): without one the session-issuing routes
answer `503 alcore_not_configured` before calling the service.

## Public exports (desktop-auth.js)

- `createDesktopAuthRuntime({ uiAuthController, alcoreSecret,
  alcorePreviousSecret, alcoreIssuer, authServiceBase, serviceFetch, now })`:
  `{ registerRoutes, serviceBase }` plus `_pendingGoogle`/`_sweepGoogle` test
  seams. `serviceBase` derives from the Alcore issuer origin (default
  `https://auth.alcore.io.vn`); `serviceFetch` defaults to global fetch and is
  injected in tests. Tunnel-scope requests get the neighbouring 403s; the
  config GET and GIS page stay public (public values only).

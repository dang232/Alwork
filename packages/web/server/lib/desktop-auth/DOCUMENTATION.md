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
  Google request against the local server and opens the returned Google
  authorize URL in the system browser. The only URL this channel ever opens
  is an `https://accounts.google.com/` authorize URL the local server just
  built — anything else fails closed before `openExternal`.
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

Google: `POST /api/auth/desktop/google/start` mints a single-use requestId
plus PKCE and nonce, and returns the Google OAuth authorize URL with
`redirect_uri` pointing at this server's loopback callback
(`GET /auth/desktop-google/callback`). The system browser opens that Google
URL directly — a plain OAuth redirect, never the GIS JavaScript flow, so no
JavaScript origin is ever involved. Google returns the authorization code to
the loopback callback, which validates the minted state, redeems the code at
the service's `POST /auth/google/desktop-code` endpoint (the confidential
secret never leaves the service), and holds the resulting pair (5-minute
TTL, single use). The app polls `/api/auth/desktop/google-complete`, which
converts the pair into a session like email. The renderer never sees the
code, verifier, or pair.

Completion requires proving the service pair: servers with the shared
`ALCORE_JWT_SECRET`/`JWT_SECRET` verify locally; servers without one
(packaged desktop) confirm the pair live against the service itself
(`GET /auth/me` introspection) and issue through
`uiAuthController.handleServiceVerifiedSessionCreate`. An unreachable or
unconfirming service fails closed — never a session.

## Public exports (desktop-auth.js)

- `createDesktopAuthRuntime({ uiAuthController, alcoreSecret,
  alcorePreviousSecret, alcoreIssuer, authServiceBase, serviceFetch, now })`:
  `{ registerRoutes, serviceBase }` plus `_pendingGoogle`/`_sweepGoogle` test
  seams. `serviceBase` derives from the Alcore issuer origin (default
  `https://auth.alcore.io.vn`); `serviceFetch` defaults to global fetch and is
  injected in tests. Tunnel-scope requests get the neighbouring 403s; the
  config GET and loopback callback stay public (the system browser sends no
  auth headers, and unknown callback states fail closed before any
  exchange). The loopback redirect URI is derived from the request Host and
  normalized to `http://127.0.0.1:<port>/auth/desktop-google/callback`.

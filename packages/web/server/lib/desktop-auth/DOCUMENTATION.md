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
TTL, single use). The exchange answer also carries the signature-verified
Google profile (`profile: { name?, picture? }`, which the service persists
nowhere), so the callback captures it onto the pending entry — the only
place the IDE ever sees the name/avatar. Email/OTP completions take the
account email from the pair's user view instead (no extra call); the Google
path reads it best-effort from `GET /auth/me` with the fresh pair (the
user's own token, never stored; failures leave name/picture intact). At
completion the server-held profile rides the session body into issuance,
where the session owner re-validates and binds it — client poll bodies
cannot mint profile fields. The app polls `/api/auth/desktop/google-complete`, which
converts the pair into a session like email. The renderer never sees the
code, verifier, or pair.

Callback failures are named, never silent: the failure page carries the
failing step and upstream code in `body[data-auth-error]` and in a visible
`<code>step · code</code>` line. Steps are `google` (Google refused, e.g.
access_denied), `callback` (malformed/unknown state), and `exchange` (the
service call failed). Exchange codes: `upstream_unavailable` (service
unreachable/throttled), `desktop_code_unavailable` (service answered 404 or
non-JSON — the deployment where the app points has no desktop-code endpoint),
plus the service's own `google_not_configured` / `identity_conflict` /
credential codes passed through. A failed exchange is RETAINED on the pending
entry until its TTL: a repeat callback navigation re-renders the same named
page, and the app poll reads the terminal failure once
(`{ error, step }` with the page status) instead of polling 404
`no_credential` until expiry. Only a still-waiting request answers 404.

Completion requires proving the service pair: servers with the shared
`ALCORE_JWT_SECRET`/`JWT_SECRET` verify locally; servers without one
(packaged desktop) confirm the pair live against the service itself
(`GET /auth/me` introspection) and issue through
`uiAuthController.handleServiceVerifiedSessionCreate`. An unreachable or
unconfirming service fails closed — never a session.

Keychain capture (project-ide task 39): after a 200 issuance the proven
pair (access JWT + rotating refresh token) is stored in the shared
user-token keychain (`packages/web/server/lib/user-tokens/`), keyed by
the verified subject — the JWT `sub` decode on the local-verify path
(keying only; trust comes from the issuance above), the live-confirmed
`sub` on the introspection path. The Google refresh token rides the
server-held pending entry from the loopback callback into
`google-complete` (never the browser, never the poll body). A locked or
failing store never fails the proven login; nothing here logs tokens.
Issuance, cookies, validation, and rate limits are untouched.

## Public exports (desktop-auth.js)

- `createDesktopAuthRuntime({ uiAuthController, alcoreSecret,
  alcorePreviousSecret, alcoreIssuer, authServiceBase, serviceFetch, now,
  userTokenStore })` (null disables capture; production passes the shared
  keychain singleton):
  `{ registerRoutes, serviceBase }` plus `_pendingGoogle`/`_sweepGoogle` test
  seams. `serviceBase` derives from the Alcore issuer origin (default
  `https://auth.alcore.io.vn`); `serviceFetch` defaults to global fetch and is
  injected in tests. Tunnel-scope requests get the neighbouring 403s; the
  config GET and loopback callback stay public (the system browser sends no
  auth headers, and unknown callback states fail closed before any
  exchange). The loopback redirect URI is the fixed registered URI
  `http://127.0.0.1:57123/auth/desktop-google/callback` in all modes — the
  request Host never influences it, so the authorize URL always matches the
  registered redirect exactly. The desktop server always binds port 57123
  and fails loudly at startup when it is occupied; any other serving layout
  (dev API/HMR included) binds a dedicated loopback listener on 57123 for
  the callback alone (`desktop-callback-listener.js`), sharing this
  module's pending-request map so a login started on any port completes.

- `registerCallbackRoute({ get })`: mounts only
  `GET /auth/desktop-google/callback` with the same handler and map — the
  fixed-port listener's entry point. No logic is duplicated there.

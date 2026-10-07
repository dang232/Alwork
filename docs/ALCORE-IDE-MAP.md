# Alcore IDE Integration Map (fork working copy)

> Mass-ulw deep map, 2026-10-07. Source of truth for planning: I:/migration research (Alwork fork base + Alcore account gate + dynamic plugin slot). Upstream base: openchamber/openchamber @ 733fa61. No product code touched by this commit.

---

# Alwork DeepMap 01 — Integration Map

Merged from six verified lane digests (PKG, PLAT, AUTH, OMO, GATE, FORK). Independent verifier re-checked all six load-bearing facts: PASS.

## 1. Component map

### 1.1 Shell surfaces + platforms
- Monorepo of 8 workspace packages: `docs`, `electron desktop shell`, `extensions registry`, `mobile Capacitor android+ios`, `sdk TS client`, `ui React lib`, `vscode extension`, `web frontend`.
- Evidence refs: `package.json` (workspaces), `packages/docs`, `packages/electron` (Electron shell), `packages/extensions` + `packages/extensions/registry.json`, `packages/mobile` (Capacitor), `packages/sdk` (TS client), `packages/ui` (React lib), `packages/vscode` (VS Code extension), `packages/web` (frontend), `vite.config.ts`.
- Root deploy surface: `Dockerfile`, `docker-compose.yml`, `Caddyfile`.
- Platform build matrix (see §1.5 / §3 Wave 3 for workflow detail).

### 1.2 Auth seam
- UI password gate via env `OPENCHAMBER_UI_PASSWORD` plus device-remember cookie.
- Localhost-first default bind `127.0.0.1`.
- Single-use QR pairing + per-device tokens + Private Relay E2E channel.
- Enterprise managed mode via per-OS `policy.json` paths: `allowedExtensions` repo-URL allowlist, `opencodeBinary` pin, network lockdown flags.
- Evidence refs: `OPENCHAMBER_UI_PASSWORD`, `127.0.0.1` default bind, QR pairing flow, per-device tokens, Private Relay E2E, `policy.json` (per-OS paths), `allowedExtensions`, `opencodeBinary`.

### 1.3 OmO runtime + license boundary
- Adapter package `packages/omo-senpi`: npm name `@code-yeongyu/omo-senpi`, `pi-package` adapter shape (`pi.system`), extension entry `extensions/omo.js`, `omo-*-runtime` import hooks, shipped files under `extensions/skills/runtime`.
- License boundary SUL-1.0: internal / non-commercial use only; distribution only free-of-charge non-commercial; keep-notices obligation.
- Evidence refs: `packages/omo-senpi`, `@code-yeongyu/omo-senpi`, `pi.system`, `extensions/omo.js`, `omo-*-runtime` import hooks, `extensions/skills/runtime`, `SUL-1.0`.

### 1.4 Account gate (WHO vs WHAT)
- WHO = Repo C identity-only: tables `users`, `provider_identities`, `sessions`, `oidc_codes`, `product_exchange_codes`, `google_states`; `passwordHash` nullable; `emailVerified`; Google JWKS verification; OTP signup; 15-minute access / 30-day refresh tokens.
- WHAT = TokenPanel provision: `customer.authUserId`, idempotency key `customer-provision:{authUserId}`, tiers `free-tier` vs `pending-payment`, `subscription` always null at provision, `subscribeCustomer` never called at provision, `409` fail-closed on conflict.
- IDE check order: login → WHO → customer lookup → tier → gate.
- Evidence refs: `users`, `provider_identities`, `sessions`, `oidc_codes`, `product_exchange_codes`, `google_states`, `passwordHash` nullable, Google JWKS, `customer.authUserId`, `customer-provision:{authUserId}`.

### 1.5 Fork delivery
- Fork `dang232/Alwork` identical to upstream at `733fa61` (ahead 0, behind 0), branch `main`.
- Releases only on `v`-tags or `workflow_dispatch` (no automatic release on push to main).
- Evidence refs: `dang232/Alwork`, `733fa61`, `main`, `v-*` tags, `workflow_dispatch`.

## 2. Key discovery

- Enterprise-mode `policy.json` `allowedExtensions` allowlist IS the trust model for the dynamic plugin slot: only repo URLs on the allowlist may populate the dynamic slot; everything else is denied by policy, not by UI hiding.
- Companion pin: `opencodeBinary` in the same `policy.json` pins the exact binary the plugin slot may invoke, closing the "trusted list, untrusted runner" hole.
- Together with network lockdown flags in `policy.json`, this gives a managed-enterprise path: allowlisted extension repos + pinned runner binary + locked-down network.
- Why it matters: the dynamic plugin slot (extensions registry, `packages/extensions/registry.json`) must not invent its own trust check — it must inherit `policy.json` enforcement, with the OmO runtime (`packages/omo-senpi`, `extensions/omo.js`) executing only what policy allows.
- Evidence refs: `policy.json` (per-OS paths), `allowedExtensions` repo-URL allowlist, `opencodeBinary` pin, `packages/extensions/registry.json`.

## 3. Dependency-ordered implementation waves

### Wave 1 — Auth seam + plugin slot (first)
- Inputs: `OPENCHAMBER_UI_PASSWORD` + device-remember design, `127.0.0.1` default, QR pairing + per-device tokens + Private Relay E2E spec, `policy.json` schema (`allowedExtensions`, `opencodeBinary`, network lockdown), `packages/extensions` + `registry.json`, `packages/omo-senpi` adapter (`@code-yeongyu/omo-senpi`, `extensions/omo.js`, `omo-*-runtime` hooks).
- Work: harden localhost default + password gate; wire dynamic plugin slot to enforce `allowedExtensions` allowlist and `opencodeBinary` pin at load/invoke time.
- Done-condition: unauthenticated local access denied without password/pairing; non-allowlisted extension URL refused even if present in `registry.json`; non-pinned binary refused.

### Wave 2 — Account gate (second)
- Inputs: Wave 1 auth seam, Repo C schema (`users`, `provider_identities`, `sessions`, `oidc_codes`, `product_exchange_codes`, `google_states`), Google JWKS + OTP signup, TokenPanel provision contract (`customer.authUserId`, `customer-provision:{authUserId}`, `free-tier`/`pending-payment`, null subscription, no `subscribeCustomer` at provision, `409` fail-closed), IDE check order (login → WHO → customer lookup → tier → gate).
- Work: implement WHO identity service, then WHAT provision mapping, then IDE gate in check order.
- Done-condition: login resolves WHO; provision creates exactly one customer per `authUserId` (replay returns same, conflict 409 closed); IDE gates on tier correctly.

### Wave 3 — Platform builds (third)
- Inputs: Waves 1–2 green, `.github/workflows/release.yml` (win x64+arm64, mac aarch64+x86_64, linux AppImage), `.github/workflows/build-macos-arm64-dmg.yml`, `.github/workflows/mobile-release.yml` (android+iOS), `.github/workflows/vscode-extension.yml`, `Dockerfile` + `docker-compose.yml` + `Caddyfile`, `packages/electron`, `packages/mobile`, `packages/vscode`.
- Work: enable desktop/mobile/vscode/web packaging on top of the gated runtime.
- Done-condition: each workflow produces its artifact (win/mac/linux installers, mac arm64 dmg, android+iOS builds, vsix) with auth seam + account gate intact.

### Wave 4 — Fork delivery (last)
- Inputs: Waves 1–3 green, fork state `dang232/Alwork` @ `733fa61` on `main`, release rule (`v`-tags or `workflow_dispatch` only).
- Work: land integration via fork branch, tag `v*` or dispatch workflow for release.
- Done-condition: fork branch diff reviews clean against `733fa61`; release cut only by tag/dispatch and contains all wave artifacts.

## 4. Open owner-decisions

1. **Plugin host** — Where does the dynamic plugin slot execute in production (Electron main vs renderer, web worker, server side)? Decides how `allowedExtensions`/`opencodeBinary` enforcement is sandboxed.
2. **Commercial license** — SUL-1.0 allows internal/non-commercial use only and free-of-charge non-commercial distribution. Any paid/commercial offering needs a new license grant before Wave 4 ships.
3. **First surface** — Which shell ships first (web frontend, Electron desktop, VS Code extension, or mobile)? Decides Wave 3 build order and QA focus.
4. **Tier mapping** — How do TokenPanel tiers (`free-tier` vs `pending-payment`, future paid tiers) map to gated features in the IDE check (login → WHO → customer lookup → tier → gate)? Decides Wave 2 gate matrix.

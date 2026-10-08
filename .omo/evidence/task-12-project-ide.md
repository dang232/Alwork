# Task 12 evidence — Workspace-surface wiring: multi-repo roots with per-repo context

Todo: `.omo/plans/project-ide.md` todo 12. Branch: `alwork-ide-wave1`, worktree `I:/migration/Alwork-wt/wave1` only.
Never touched: `I:/migration/Alwork` (sibling checkout), LICENSE/NOTICE, product code, any push/merge.
This file lives at `<worktree>/.omo/evidence/task-12-project-ide.md` so the whole todo stays on the worktree branch.

## Step 0 receipt — bridge commit (prescribed)

- Pre-commit status (exact, matched expectation, nothing else):
  `M packages/web/server/lib/opencode/DOCUMENTATION.md`
  `?? packages/web/server/lib/opencode/omo-bridge-fixture.json`
  `?? packages/web/server/lib/opencode/omo-bridge-runtime.js`
  `?? packages/web/server/lib/opencode/omo-bridge-runtime.test.js`
- Base SHA before: `df075b21a36db7a1d717cb138ccfe3be049a5a88` (`df075b2 feat(slot)`).
- Existing tests read FIRST (`omo-bridge-runtime.test.js`, 26 tests: probe/invoke/stream/cancel/degraded-message).
- Focused run `bun test packages/web/server/lib/opencode/omo-bridge-runtime.test.js`: **25 pass / 1 fail**.
  The single failure is pre-existing and environmental, not caused by this todo:
  `probe > real node binary answers --version through the real spawnSync path` expects
  `missingRunFlags` to equal all four flags, but under `bun test` `process.execPath` is the
  bun binary (not node), whose `run --help` output contains `--port`, so the received list is
  `["--attach","--session-id","--json"]`. The test assumes a node binary; the file was committed
  as-authored per the explicit step-0 instruction (no test edits: weakening it to green would
  violate repo policy). No product code was changed by this todo, so no fix belongs here.
- `bunx oxlint` on `omo-bridge-runtime.js` + `omo-bridge-runtime.test.js`: clean (no output).
- Commit (exact prescribed message, no body): `373319d feat(adapter): OmO runtime bridge with snapshot writer`
  (4 files, +1031). Post-commit worktree status: clean.

## Per-repo AGENTS.md reading (before wiring)

- migration root (`I:/migration`): NO `AGENTS.md` (verified `Test-Path` False). Authority is
  `ALcore_Unified_Migration_Plan_v2.md` + `.omo/plans/project-ide.md` + `docs/auth/API-CONTRACT.md`.
- auth-service (`I:/migration/auth-service`): NO `AGENTS.md` (verified False). Authority is
  `README.md` (identity-only boundary, port 8082, Hono on bun) + `package.json` (name `auth-service`,
  `dev: bun run --hot src/index.ts`, `test: bun test`, `typecheck: tsc --noEmit`) +
  `src/routes/auth.ts` + `src/lib/auth-models.ts` (Session shape `id/userId/refreshHash/prevHashes/createdAt/expiresAt/revoked`).
- libre-webui (`I:/migration/libre-webui`): `AGENTS.md` present (8014 bytes). npm + Node 22.22+ only
  (never bun); `frontend/package.json` name `alcore-frontend`; startup preflight order in
  `backend/src/main.ts`; bundled provider manifests in `plugins/`.
- AlRepo (`I:/migration/AlRepo`): `AGENTS.md` present (15428 bytes, TokenPanel). Bun + turbo only;
  `package.json` name `tokenpanel`; config single source of truth `packages/config/src/fields.ts`;
  API runtime `apps/api/src/config/runtime.ts`; migrations immutable once pushed.

## Files created (scope: worktree workspace files + this evidence)

1. `alwork-ide-wave1.code-workspace` — VS Code multi-root with exactly the four folders
   (`migration-root`, `auth-service`, `libre-webui`, `AlRepo` → `I:/…` absolute paths) plus
   `search.exclude` / `files.watcherExclude` for `node_modules`, `backend/dist`, `frontend/dist`, `.git`.
   SHA256 `A3EBC868E2B8D96749C7A0A221CA973AA6ED191DB3645B967AFFF4D8D1B9BD49`.
2. `alwork-ide-roots.json` — per-root manifest: `path`, `agentsFile` (null with `agentsNote` where the
   repo honestly has no AGENTS.md), `contextFiles`, `runtime`, `scope`, and the `crossRoot` policy
   (`default: denied`; `allowedRoots` = the four names; nested product paths under migration-root
   resolve to their dedicated root; unknown names rejected with `OMO_WORKSPACE_UNKNOWN_ROOT`;
   `oh-my-openAlcore` explicitly out of scope as an example, SUL boundary).
   SHA256 `F65A6DA3DC327051D7D85D7FC3861175BCE4A6B694EADBB27C01C085D30E8B94`.
3. This evidence file.

## Manual-QA: literal open/resolve commands + outputs

All commands bounded single-shot via `powershell -NoProfile -Command`, worktree `373319d`, 2026-10-08.
Worktree HEAD at verify time: `373319de1c255a206997dc4ecfcbe5ae88132e1e`.

1. Workspace folders parse (4/4):
   `$w = Get-Content alwork-ide-wave1.code-workspace -Raw | ConvertFrom-Json` →
   `migration-root I:/migration`, `auth-service I:/migration/auth-service`,
   `libre-webui I:/migration/libre-webui`, `AlRepo I:/migration/AlRepo`, `folders=4`.
2. Per-root context resolves (15/15 True, zero asserts skipped):
   migration-root: `ALcore_Unified_Migration_Plan_v2.md` True, `.omo/plans/project-ide.md` True,
   `docs/auth/API-CONTRACT.md` True.
   auth-service: `package.json` True, `README.md` True, `src/routes/auth.ts` True,
   `src/lib/auth-models.ts` True.
   libre-webui: `AGENTS.md` True, `frontend/package.json` True, `backend/src/main.ts` True, `plugins` True.
   AlRepo: `AGENTS.md` True, `package.json` True, `packages/config/src/fields.ts` True,
   `apps/api/src/config/runtime.ts` True.
   Agents presence honest: `agents-auth=False agents-libre=True agents-alrepo=True`
   (no AGENTS.md invented for auth-service; manifest records `agentsFile: null` + note).
3. Per-root manifest identity (distinct, no confusion):
   `(auth-service/package.json).name` → `auth-service`;
   `(AlRepo/package.json).name` → `tokenpanel`;
   `(libre-webui/frontend/package.json).name` → `alcore-frontend`.
4. Scoped-open probe (dedicated roots): `auth-service/src/routes/auth.ts` True,
   `libre-webui/AGENTS.md` True, `AlRepo/AGENTS.md` True.

## Adversarial probes

| Probe | Command (literal) | Output (verbatim) | Verdict |
|---|---|---|---|
| malformed input (unknown root rejected cleanly) | resolve name `unknown-root` against `crossRoot.allowedRoots` | `OMO_WORKSPACE_UNKNOWN_ROOT: unknown-root rejected (allowed: migration-root,auth-service,libre-webui,AlRepo)`; `Test-Path I:/migration/unknown-root` → `False` | clean reject, nothing resolved, nothing created |
| wrong-context (TokenPanel skills in auth-service) → FAIL if present | `Test-Path` x4: `auth-service/packages/config/src/fields.ts`, `auth-service/AGENTS.md`, `libre-webui/packages/config/src/fields.ts`, `libre-webui/apps/api/src/config/runtime.ts` | `False False False False` | no leakage; failure condition absent |
| out-of-scope root denied | `allowedRoots -contains 'oh-my-openAlcore'` | `False` (engine dir exists on disk: `oh-my-openAlcore/packages/omo-senpi` True, still not a root) | explicitly scoped out, SUL boundary intact |
| stale_state (base SHAs recorded) | `git rev-parse HEAD`; `git log --oneline -4`; `Get-FileHash` both workspace files | HEAD `373319d`; chain `373319d/df075b2/36dd5fc/08ac695`; hashes in §Files above | pins reproducible |
| dirty_worktree (only intended files) | `git status --porcelain=v1` (worktree) | `?? alwork-ide-roots.json`, `?? alwork-ide-wave1.code-workspace` (+ this evidence file after write); branch `alwork-ide-wave1`; `status -- LICENSE NOTICE` empty | no product/license drift |
| misleading_success_output (assert resolved paths, not exit codes) | every resolve above asserts `Test-Path` True per file + name strings `auth-service/tokenpanel/alcore-frontend` | 15/15 True quoted above | paths asserted, not inferred |
| hung_commands (bounded) | all probes single-shot `powershell -NoProfile` with `nothrow`, no watchers/polls/servers | each returned in one round; longest (focused bun test) 141ms–60s budget | no hangs, nothing backgrounded |

## Validation summary (honest)

- Read FIRST: `omo-bridge-runtime.test.js` + both `AGENTS.md` files + auth-service `README.md`/`package.json`/`auth-models.ts`.
- Focused bridge tests at step 0: 25/26 (1 pre-existing environmental fail, documented above, committed as-authored per explicit instruction).
- `oxlint` on both bridge JS files: clean.
- Workspace files: JSON `ConvertFrom-Json` parse ×2 green; 15/15 resolves green; 4/4 negative leakage probes green; unknown-root reject green.
- Full suites NOT run (out of scope for a config-only todo; AGENTS.md prescribes narrowest validation for isolated config changes; todo 16 owns full-suite-green).
- No servers, PIDs, temp files, or background sessions created; nothing to kill. Sibling checkout `I:/migration/Alwork` never entered; migration-root scratch dirt (`.omo/...` modified entries) pre-exists and was not touched.

## STOP condition

Four roots open with correct per-repo context (asserted per root above) + cross-root access denied-or-scoped (policy + probes) + evidence recorded. Met.

# omo-dag-pane — DAG side pane guest

Third-party SDK guest (project-ide todo 13). Panel id `omo-dag-pane`:
never the `openchamber-builtin-` prefix, never the Herdr dashboard. The
guest renders OmO run graphs with node details and steers/cancels the live
session. Hosted by the Electron desktop shell's webview only: the rail
hides its surface everywhere else (see `packages/ui/src/lib/surfaces/
registry.ts`, `DESKTOP_ONLY_PLUGIN_SURFACE_IDS`). No web, VS Code, or
mobile pane host exists for this guest.

## Layout

- `package.json` — the install manifest (package envelope: `openchamber`
  block; semver `version` required or install refuses). `panel.entry` is
  `panel/index.html`; `service.entry` is `service/main.js` (`runtime:
  "host"`, no permissions declared). `attach: false`, so the guest never
  appears on composer + menus; the rail icon is the only entry point.
- `panel/index.html` — iframe entry. Loads the checked-in classic IIFE
  `panel/main.js` (the sandbox cannot load ESM). Page CSS uses only
  `var(--oc-*)` host tokens; spacing follows the 8px scale.
- `panel/main.ts` — guest source. `connectHost`, `applyHostReady` from the
  first `onReady`, kit primitives (`mountButton`, `mountTextField`,
  `mountSelect`, `mountBadge`, `mountBanner`, `mountEmpty`,
  `mountSpinner`). The graph itself is custom inline SVG (the kit ships no
  graph primitive): nodes laid out by payload `waves`, edges as lines,
  click/Enter selects a node for the details card. Colors come only from
  host tokens (running = primary, completed = success, failed = error,
  pending = muted; selection pair for the picked node).
- `panel/dag-view.ts` — pure snapshot-to-view parser, no DOM. A `null`
  dag is an empty view; any other shape break is `DAG_SNAPSHOT_MALFORMED`
  with the field named, and the panel renders that as an error card with
  Retry — never blank.
- `panel/strings.ts` — package dictionaries for all 13 host locales,
  picked from `ready.locale` (exact, then language prefix, then English).
- `panel/main.js` — built IIFE, checked in. Rebuild from this directory
  with `bun /path/to/packages/sdk/scripts/bundle-guest.ts panel/main.ts
  panel/main.js` (the official guest bundler; any IIFE bundler is an
  equivalent substitute). `panel/*.test.ts` runs under `bun test`.
- `service/handlers.js` — `createDagServiceHandlers({ fs, snapshotDir,
  createBridge })`. Wraps the adapter-A bridge (`packages/web/server/lib/
  opencode/omo-bridge-runtime.js`): `GET /status` (probe + snapshot
  sessions), `GET /snapshot?sessionId=`, `POST /steer` (invoke attached to
  the live session, handle kept for cancel), `POST /cancel` (provisional
  kill receipt). Engine-absent steers answer 503 with the bridge's
  degraded message.
- `service/main.js` — loopback entry. Requires `OPENCHAMBER_SERVICE_PORT`
  + `OPENCHAMBER_SERVICE_TOKEN`, enforces the bearer on every request
  including `/health`, binds 127.0.0.1 only.

## Data path

Snapshots live in the OS temp dir under `omo-dag-snapshots/
<sessionId>.snapshot.json` (override with `OMO_SNAPSHOT_DIR` where the
process inherits user env — the CLI; the service sandbox does not, so the
service always uses the default and the CLI defaults to the same). The
panel never touches the filesystem: it calls `serviceRequest`, and the
service reads the file. The wrapper entry for steering is per-guest
storage (`wrapperEntry`, edited in the panel); the service falls back to
`OMO_WRAPPER_PATH` when the request carries no entry.

## Install (desktop)

Settings → Extensions → install this folder. Approve the `service`
capability when asked. The rail shows the DAG icon (package SVG) on the
Electron desktop only. Folder installs keep their realpath, so the
service's relative bridge import keeps working from this checkout.

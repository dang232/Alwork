// DAG pane local service handlers (project-ide todo 13).
//
// The panel iframe stays sandboxed: every privileged step runs here, in the
// host-spawned service process, behind the host's loopback proxy. These
// handlers wrap the adapter-A bridge from todo 6
// (`packages/web/server/lib/opencode/omo-bridge-runtime.js`): probe for
// engine presence, steer by invoking a run attached to the live session,
// cancel through the bridge's provisional kill-with-reason, and read the
// snapshot files the bridge writer produces.
//
// `service/main.js` maps HTTP onto `handleRequest`; the unit tests call it
// directly with a stub bridge, so no server or engine is needed to prove
// the steer/cancel wiring.
import { tmpdir as osTmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import nodeFs from 'node:fs';

import {
  createOmoBridgeRuntime,
  defaultSnapshotPath,
} from '../../web/server/lib/opencode/omo-bridge-runtime.js';

export const DAG_SERVICE_NAME = 'omo-dag-pane';
export const DAG_SERVICE_DEFAULT_SNAPSHOT_PREFIX = 'omo-dag-snapshots';
export const DAG_SERVICE_MAX_BODY_BYTES = 1_000_000;

export const defaultServiceSnapshotDir = (tmpdir = osTmpdir, join = joinPath) => (
  join(tmpdir(), DAG_SERVICE_DEFAULT_SNAPSHOT_PREFIX)
);

const isNonEmptyString = (value) => (value?.trim?.() ?? '').length > 0;

const snapshotSessions = (fs, snapshotDir) => {
  let entries;
  try {
    entries = fs.readdirSync(snapshotDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.snapshot.json'))
    .map((name) => name.slice(0, -'.snapshot.json'.length))
    .sort();
};

export const createDagServiceHandlers = (dependencies = {}) => {
  const {
    fs = nodeFs,
    snapshotDir = defaultServiceSnapshotDir(),
    now = Date.now,
    createBridge = (entry) => createOmoBridgeRuntime({
      fs,
      snapshotDir,
      resolveEngineEntry: () => entry ?? process.env.OMO_WRAPPER_PATH ?? null,
    }),
  } = dependencies;

  try {
    fs.mkdirSync(snapshotDir, { recursive: true });
  } catch {
    // Reads degrade to NOT_FOUND and steer reports the write failure; a
    // missing directory must never crash the service process.
  }

  // sessionId -> { cancel, startedAt }: runs this service started that have
  // not reported their child closing yet. Cancel targets the latest steer
  // per session; a closed child removes its own entry.
  const live = new Map();

  const bridgeError = (error, fallbackCode) => {
    const code = error?.code ?? fallbackCode;
    if (code === 'OMO_ENGINE_ABSENT') {
      return { status: 503, body: { ok: false, code, message: error.message } };
    }
    if (code === 'OMO_INVOKE_ARGS_INVALID' || code === 'OMO_SESSION_ID_INVALID' || code === 'OMO_SNAPSHOT_DIR_INVALID') {
      return { status: 400, body: { ok: false, code, message: error.message } };
    }
    return { status: 500, body: { ok: false, code, message: error?.message ?? 'The DAG service failed.' } };
  };

  const snapshotPathFor = (sessionId) => defaultSnapshotPath(snapshotDir, sessionId);

  const readSnapshot = (sessionId) => {
    let snapshotPath;
    try {
      snapshotPath = snapshotPathFor(sessionId);
    } catch (error) {
      return { status: 400, body: { ok: false, code: error.code ?? 'OMO_SESSION_ID_INVALID', message: error.message } };
    }
    let text;
    try {
      text = fs.readFileSync(snapshotPath, 'utf8');
    } catch {
      return { status: 404, body: { ok: false, code: 'OMO_DAG_SNAPSHOT_MISSING', sessionId } };
    }
    try {
      return { status: 200, body: JSON.parse(text) };
    } catch {
      return { status: 422, body: { ok: false, code: 'DAG_SNAPSHOT_MALFORMED', field: 'snapshot', sessionId } };
    }
  };

  const handleRequest = async ({ method, path, query = {}, body = {} } = {}) => {
    if (method === 'GET' && path === '/health') {
      return { status: 200, body: { ok: true, service: DAG_SERVICE_NAME } };
    }
    if (method === 'GET' && path === '/status') {
      const entry = isNonEmptyString(query?.entry) ? query.entry.trim() : undefined;
      const bridge = createBridge(entry);
      const probe = await bridge.probe();
      return {
        status: 200,
        body: {
          ok: true,
          probe,
          sessions: snapshotSessions(fs, snapshotDir),
          snapshotDir,
          now: new Date(now()).toISOString(),
        },
      };
    }
    if (method === 'GET' && path === '/snapshot') {
      const sessionId = query?.sessionId;
      if (!isNonEmptyString(sessionId)) {
        return { status: 400, body: { ok: false, code: 'OMO_DAG_SESSION_REQUIRED', message: 'Pass ?sessionId=<run session>.' } };
      }
      return readSnapshot(sessionId.trim());
    }
    if (method === 'POST' && path === '/steer') {
      const message = body?.message;
      const sessionId = body?.sessionId;
      const entry = isNonEmptyString(body?.entry) ? body.entry.trim() : undefined;
      if (!isNonEmptyString(message)) {
        return { status: 400, body: { ok: false, code: 'OMO_DAG_MESSAGE_REQUIRED', message: 'Steering needs a non-empty message.' } };
      }
      if (!isNonEmptyString(sessionId)) {
        return { status: 400, body: { ok: false, code: 'OMO_DAG_SESSION_REQUIRED', message: 'Steering attaches to a live session: pass sessionId.' } };
      }
      let snapshotPath;
      try {
        snapshotPath = snapshotPathFor(sessionId.trim());
      } catch (error) {
        return { status: 400, body: { ok: false, code: error.code ?? 'OMO_SESSION_ID_INVALID', message: error.message } };
      }
      const bridge = createBridge(entry);
      let handle;
      try {
        handle = bridge.invoke({
          message: message.trim(),
          sessionId: sessionId.trim(),
          snapshotPath,
        });
      } catch (error) {
        return bridgeError(error, 'OMO_SPAWN_FAILED');
      }
      const startedAt = new Date(now()).toISOString();
      live.set(sessionId.trim(), { cancel: handle.cancel, startedAt });
      handle.wait().then(
        () => {
          if (live.get(sessionId.trim())?.cancel === handle.cancel) {
            live.delete(sessionId.trim());
          }
        },
        () => {
          if (live.get(sessionId.trim())?.cancel === handle.cancel) {
            live.delete(sessionId.trim());
          }
        },
      );
      return {
        status: 200,
        body: {
          ok: true, sessionId: sessionId.trim(), entry: handle.entry, argv: handle.argv, startedAt,
        },
      };
    }
    if (method === 'POST' && path === '/cancel') {
      const sessionId = body?.sessionId;
      if (!isNonEmptyString(sessionId)) {
        return { status: 400, body: { ok: false, code: 'OMO_DAG_SESSION_REQUIRED', message: 'Cancel targets a live session: pass sessionId.' } };
      }
      const running = live.get(sessionId.trim());
      if (!running) {
        return { status: 404, body: { ok: false, code: 'OMO_DAG_NO_RUN', sessionId: sessionId.trim() } };
      }
      let receipt;
      try {
        receipt = await running.cancel(isNonEmptyString(body?.reason) ? body.reason.trim() : 'pane cancel');
      } catch (error) {
        return bridgeError(error, 'OMO_CANCEL_FAILED');
      }
      live.delete(sessionId.trim());
      return { status: 200, body: { ok: true, sessionId: sessionId.trim(), receipt } };
    }
    return { status: 404, body: { ok: false, code: 'OMO_DAG_UNKNOWN_PATH', path } };
  };

  return { handleRequest, live };
};

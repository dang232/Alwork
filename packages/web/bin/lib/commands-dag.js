// `openchamber dag` — text-only run visibility for OmO sessions
// (project-ide todo 13: CLI parity for the DAG side pane, no pane here).
//
// `dag status` prints the bridge snapshot file the adapter-A writer
// produces; `dag stream` invokes the user-installed engine through the
// todo-6 bridge and prints its events textually. Both stay deterministic
// in human, `--quiet`, `--json`, and non-TTY modes; no prompts anywhere.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';

import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { createOmoBridgeRuntime } from '../../server/lib/opencode/omo-bridge-runtime.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  isJsonMode,
  isQuietMode,
  printJson,
  logStatus,
} from '../cli-output.js';

const DAG_SNAPSHOT_PREFIX = 'omo-dag-snapshots';
const DAG_SNAPSHOT_SUFFIX = '.snapshot.json';
const DAG_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const asNonEmptyString = (value) => {
  // Options only ever carry strings; anything else counts as absent, and
  // only a string primitive stringifies to itself under `===`.
  if (String(value) !== value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const defaultDagSnapshotDir = () => join(tmpdir(), DAG_SNAPSHOT_PREFIX);

export const resolveDagSnapshotDir = (options = {}) => (
  asNonEmptyString(options.snapshotDir)
  ?? asNonEmptyString(process.env.OMO_SNAPSHOT_DIR)
  ?? defaultDagSnapshotDir()
);

const assertDagSessionId = (sessionId) => {
  if (!DAG_SESSION_ID_PATTERN.test(sessionId ?? '')) {
    throw new TunnelCliError('Missing or invalid --session. Pass the run session id (letters, digits, _ -).', EXIT_CODE.USAGE_ERROR);
  }
  return sessionId;
};

const wireRecord = (value) => (value instanceof Object && !Array.isArray(value) ? value : null);

const wireText = (record, key) => {
  const value = record?.[key];
  return String(value) === value ? value : '';
};

const wireCount = (record, key) => {
  const value = record?.[key];
  return Number(value) === value && Number.isFinite(value) ? value : 0;
};

// Tolerant projection of a bridge snapshot document for terminal output.
// Strict shape validation lives in the pane (dag-view.ts); the CLI prints
// what is there and zeros what is not, so a partial file still reports.
export const summarizeDagSnapshot = (doc) => {
  const record = wireRecord(doc) ?? {};
  const runs = Array.isArray(record.dag?.runs) ? record.dag.runs : [];
  const tasks = Array.isArray(record.tasks?.tasks) ? record.tasks.tasks : [];
  return {
    sessionId: wireText(record, 'sessionId'),
    updatedAt: wireText(record, 'updatedAt'),
    runs: runs.map((run) => {
      const entry = wireRecord(run) ?? {};
      const nodes = Array.isArray(entry.nodes) ? entry.nodes : [];
      const counts = wireRecord(entry.counts) ?? {};
      return {
        runKey: wireText(entry, 'run_key'),
        name: wireText(entry, 'name'),
        status: wireText(entry, 'status') || 'unknown',
        counts: {
          pending: wireCount(counts, 'pending'),
          running: wireCount(counts, 'running'),
          completed: wireCount(counts, 'completed'),
        },
        nodes: nodes.map((node) => {
          const item = wireRecord(node) ?? {};
          return {
            label: wireText(item, 'label'),
            state: wireText(item, 'state') || 'unknown',
          };
        }),
      };
    }),
    tasks: tasks.map((task) => {
      const item = wireRecord(task) ?? {};
      return {
        taskId: wireText(item, 'task_id'),
        status: wireText(item, 'status') || 'unknown',
      };
    }),
  };
};

export const readDagSnapshotFile = (snapshotDir, sessionId) => {
  const id = assertDagSessionId(asNonEmptyString(sessionId));
  const filePath = join(snapshotDir, `${id}${DAG_SNAPSHOT_SUFFIX}`);
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new TunnelCliError(
      `No snapshot for session \"${id}\" [SNAPSHOT_MISSING]: ${filePath} does not exist yet. Stream a run first.`,
      EXIT_CODE.GENERAL_ERROR,
    );
  }
  try {
    return { filePath, doc: JSON.parse(text) };
  } catch {
    throw new TunnelCliError(
      `Snapshot for session \"${id}\" is unreadable [SNAPSHOT_MALFORMED]: ${filePath} is not valid JSON.`,
      EXIT_CODE.GENERAL_ERROR,
    );
  }
};

const quietRunLine = (run) => (
  `run ${run.runKey || '?'} ${run.status} pending=${run.counts.pending} running=${run.counts.running} completed=${run.counts.completed}`
);

async function statusAction(options = {}) {
  const snapshotDir = resolveDagSnapshotDir(options);
  const { doc } = readDagSnapshotFile(snapshotDir, options.session);
  const summary = summarizeDagSnapshot(doc);

  if (isJsonMode(options)) {
    printJson({ status: 'ok', snapshot: summary });
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write(`session ${summary.sessionId} updated ${summary.updatedAt}\n`);
    for (const run of summary.runs) {
      process.stdout.write(`${quietRunLine(run)}\n`);
    }
    return;
  }
  clackIntro('DAG status');
  if (summary.runs.length === 0) {
    logStatus('warning', `session ${summary.sessionId}: no runs yet`);
    clackOutro('empty snapshot');
    return;
  }
  for (const run of summary.runs) {
    const level = run.status === 'completed' ? 'success' : run.status === 'failed' ? 'error' : 'info';
    logStatus(level, `run ${run.runKey || '?'} — ${run.status}`, `pending ${run.counts.pending} · running ${run.counts.running} · completed ${run.counts.completed}`);
    for (const node of run.nodes) {
      process.stdout.write(`  ${node.label || '?'}: ${node.state}\n`);
    }
  }
  clackOutro(`${summary.runs.length} run(s)`);
}

const eventLineCount = (data) => (Array.isArray(data?.runs) ? data.runs.length : 0);

const printStreamEvent = (options, name, data) => {
  if (name === 'omo.dag.updated') {
    const line = `event omo.dag.updated runs=${eventLineCount(data)}`;
    if (isJsonMode(options)) {
      printJson({ status: 'ok', event: name, runs: eventLineCount(data) });
    } else {
      process.stdout.write(`${line}\n`);
    }
    return;
  }
  if (name === 'omo.task.updated') {
    const count = Array.isArray(data?.tasks) ? data.tasks.length : 0;
    if (isJsonMode(options)) {
      printJson({ status: 'ok', event: name, tasks: count });
    } else {
      process.stdout.write(`event omo.task.updated tasks=${count}\n`);
    }
  }
};

async function streamAction(options = {}, dependencies = {}) {
  const {
    createBridge = () => createOmoBridgeRuntime(),
    setCancelCleanup = null,
  } = dependencies;
  const message = asNonEmptyString(options.message);
  if (!message) {
    throw new TunnelCliError('Missing required --message. Nothing was started.', EXIT_CODE.USAGE_ERROR);
  }
  const onInterrupt = setCancelCleanup ?? null;
  const bridge = createBridge();
  const probe = await bridge.probe();
  if (!probe.available) {
    const detail = probe.message ?? 'The OmO engine is not available.';
    if (isJsonMode(options)) {
      printJson({ status: 'error', error: { message: detail, code: probe.code ?? 'OMO_ENGINE_ABSENT' } });
    } else {
      logStatus('error', 'OmO engine not found [ENGINE_ABSENT]', detail);
    }
    throw new TunnelCliError(detail, EXIT_CODE.MISSING_DEPENDENCY);
  }
  const sessionId = asNonEmptyString(options.session) ?? undefined;
  let handle;
  try {
    handle = bridge.invoke({
      message,
      port: options.explicitPort ? options.port : undefined,
      attachUrl: asNonEmptyString(options.attach) ?? undefined,
      sessionId,
      onEvent: (name, data) => {
        if (sessionId && data instanceof Object && data.parent_session_id !== sessionId) {
          return;
        }
        printStreamEvent(options, name, data);
      },
    });
  } catch (error) {
    throw new TunnelCliError(error?.message ?? 'The run could not start.', error?.code === 'OMO_ENGINE_ABSENT' ? EXIT_CODE.MISSING_DEPENDENCY : EXIT_CODE.GENERAL_ERROR);
  }
  if (onInterrupt) {
    onInterrupt(() => {
      try {
        void handle.cancel('interrupted');
      } catch {
        // The run already ended; the CLI exit path owns the outcome.
      }
    });
  }
  try {
    const completion = await handle.wait();
    if (onInterrupt) {
      onInterrupt(null);
    }
    const result = completion.result;
    const resultSummary = result instanceof Object ? wireText(result, 'summary') : '';
    if (isJsonMode(options)) {
      printJson({ status: result?.success === false ? 'error' : 'ok', result });
    } else if (result?.success === false) {
      logStatus('error', 'run failed', resultSummary);
    } else {
      logStatus('success', `run ended (exit ${completion.exitCode ?? '?'})`);
    }
    clackOutroIfHuman(options, result);
    if (result?.success === false) {
      throw new TunnelCliError(resultSummary || 'The run reported failure.', EXIT_CODE.GENERAL_ERROR);
    }
  } catch (error) {
    if (onInterrupt) {
      onInterrupt(null);
    }
    if (error instanceof TunnelCliError) {
      throw error;
    }
    throw new TunnelCliError(error?.message ?? 'The run failed.', EXIT_CODE.GENERAL_ERROR);
  }
}

const clackOutroIfHuman = (options, result) => {
  if (isJsonMode(options) || isQuietMode(options)) {
    return;
  }
  clackOutro(result?.sessionId ? `session ${result.sessionId}` : 'done');
};

export function showDagHelp() {
  console.log(`
 OpenChamber DAG - text-only run visibility for OmO sessions

USAGE:
  openchamber dag status --session <id> [--snapshot-dir <dir>]
  openchamber dag stream --message <text> [--session <id>] [--port <n> | --attach <url>]

SUBCOMMANDS:
  status         Print the snapshot for one run session
  stream         Invoke the engine and print its run events textually
  help           Show this help

OPTIONS:
  --session <id>       Run session the snapshot belongs to (status) or to
                       attach the run to (stream)
  --message <text>     Run message for stream (required)
  --snapshot-dir <dir> Snapshot directory (default: $OMO_SNAPSHOT_DIR or the
                       OS temp dir under ${DAG_SNAPSHOT_PREFIX})
  --port <n>           Engine loopback port for stream (explicit --port only)
  --attach <url>       Attach stream to a running engine URL

MODES:
  --quiet              Compact lines, no frames
  --json               JSON only (events print as newline-delimited JSON)

EXIT CODES:
  0  success · 1  run/snapshot failure · 2  usage error ·
  3  engine absent (install the free OmO plugin, set OMO_WRAPPER_PATH)
`);
}

export const createDagCommand = (dependencies = {}) => {
  const dagCommand = async (options = {}, action = 'help') => {
    if (action === 'status') {
      await statusAction(options);
      return;
    }
    if (action === 'stream') {
      await streamAction(options, dependencies);
      return;
    }
    if (action === 'help') {
      showDagHelp();
      return;
    }
    throw new TunnelCliError(`Unknown dag command '${action}'. Use: status, stream, help.`, EXIT_CODE.USAGE_ERROR);
  };
  return dagCommand;
};

// Default instance used by the CLI entrypoint (no injected deps).
export const dagCommand = createDagCommand();

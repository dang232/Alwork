// Snapshot -> view parser for the omo-dag-pane guest (project-ide todo 13).
//
// This module is the panel's I/O boundary: it reads the bridge snapshot
// document the adapter-A writer produces (`{ schemaVersion: 1, sessionId,
// updatedAt, dag, tasks }` where `dag` is the `omo.dag.updated` payload
// and `tasks` the `omo.task.updated` payload) and answers either a
// renderable view or a named malformed error. The panel turns the error
// into an error card, never a blank pane.
//
// Narrowing follows the repo's `isJsonValue` idiom (stringify-to-self for
// strings, `Object(value) === value` for records): no `typeof` operators,
// no `unknown` parameters, every input typed as the SDK's `JsonValue`
// owner contract. No DOM here: unit-tested in bun:test without a browser.
import type { JsonValue } from '@openchamber/sdk';

export const DAG_SNAPSHOT_SCHEMA_VERSION = 1;

export type WireRecord = { [key: string]: JsonValue };

export const isWireRecord = (value: JsonValue | undefined): value is WireRecord => (
  Object(value) === value && !Array.isArray(value)
);

export const wireString = (value: JsonValue | undefined): string | null => {
  // SAFETY: only strings stringify to themselves; every other JSON value
  // stringifies to something unequal to itself under `===`.
  return String(value) === value ? (value as string) : null;
};

export const wireNumber = (value: JsonValue | undefined): number | null => {
  // SAFETY: `Number(value) === value` with finiteness holds only for
  // numbers; every other JSON value coerces to something unequal.
  return Number(value) === value && Number.isFinite(value) ? (value as number) : null;
};

const wireStringArray = (value: JsonValue | undefined): string[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  const entries: string[] = [];
  for (const entry of value) {
    const text = wireString(entry);
    if (text === null) {
      return null;
    }
    entries.push(text);
  }
  return entries;
};

export type DagNodeView = {
  id: string;
  label: string;
  state: string;
  attempt: number;
  prompt: string;
  dependsOn: string[];
  startedAt: string | null;
  completedAt: string | null;
};

export type DagRunWave = {
  index: number;
  nodeIds: string[];
};

export type DagRunView = {
  runId: string;
  runKey: string;
  name: string;
  status: string;
  counts: { pending: number; running: number; completed: number };
  nodes: DagNodeView[];
  edges: { from: string; to: string }[];
  waves: DagRunWave[];
};

export type DagTaskView = {
  taskId: string;
  status: string;
  name: string;
  summary: string;
};

export type DagSnapshotView = {
  sessionId: string;
  updatedAt: string;
  runs: DagRunView[];
  tasks: DagTaskView[];
};

export type DagSnapshotError = {
  code: 'DAG_SNAPSHOT_MALFORMED';
  /** Dotted field path naming the first shape violation, e.g. `dag.runs[0].nodes`. */
  field: string;
};

export type DagSnapshotOutcome =
  | { ok: true; view: DagSnapshotView }
  | { ok: false; error: DagSnapshotError };

const fail = (field: string): DagSnapshotOutcome => (
  { ok: false, error: { code: 'DAG_SNAPSHOT_MALFORMED', field } }
);

const readNode = (raw: JsonValue | undefined): DagNodeView | null => {
  if (!isWireRecord(raw)) {
    return null;
  }
  const id = wireString(raw.id);
  const label = wireString(raw.label);
  const state = wireString(raw.state);
  const prompt = wireString(raw.prompt);
  const dependsOn = wireStringArray(raw.depends_on);
  if (id === null || label === null || state === null || prompt === null || dependsOn === null) {
    return null;
  }
  return {
    id,
    label,
    state,
    attempt: wireNumber(raw.attempt) ?? 0,
    prompt,
    dependsOn,
    startedAt: wireString(raw.started_at),
    completedAt: wireString(raw.completed_at),
  };
};

const readWave = (raw: JsonValue | undefined): DagRunWave | null => {
  if (!isWireRecord(raw)) {
    return null;
  }
  const index = wireNumber(raw.index);
  const nodeIds = wireStringArray(raw.node_ids);
  if (index === null || !Number.isInteger(index) || nodeIds === null) {
    return null;
  }
  return { index, nodeIds };
};

const readRun = (raw: JsonValue | undefined): DagRunView | null => {
  if (!isWireRecord(raw)) {
    return null;
  }
  const runId = wireString(raw.run_id);
  const runKey = wireString(raw.run_key);
  const name = wireString(raw.name);
  const status = wireString(raw.status);
  if (runId === null || runKey === null || name === null || status === null) {
    return null;
  }
  if (!Array.isArray(raw.nodes)) {
    return null;
  }
  const nodes: DagNodeView[] = [];
  for (const entry of raw.nodes) {
    const node = readNode(entry);
    if (!node) {
      return null;
    }
    nodes.push(node);
  }
  const edges: DagRunView['edges'] = [];
  if (raw.edges !== undefined) {
    if (!Array.isArray(raw.edges)) {
      return null;
    }
    for (const entry of raw.edges) {
      if (!isWireRecord(entry)) {
        return null;
      }
      const from = wireString(entry.from);
      const to = wireString(entry.to);
      if (from === null || to === null) {
        return null;
      }
      edges.push({ from, to });
    }
  }
  // Waves only drive graph layout, so a broken wave list falls back to a
  // single column instead of failing the run.
  const waves: DagRunWave[] = [];
  if (Array.isArray(raw.waves)) {
    for (const entry of raw.waves) {
      const wave = readWave(entry);
      if (wave) {
        waves.push(wave);
      }
    }
  }
  const counts = isWireRecord(raw.counts) ? raw.counts : {};
  const countOf = (key: string): number => wireNumber(counts[key]) ?? 0;
  return {
    runId,
    runKey,
    name,
    status,
    counts: { pending: countOf('pending'), running: countOf('running'), completed: countOf('completed') },
    nodes,
    edges,
    waves,
  };
};

const readTasks = (raw: JsonValue | undefined): DagTaskView[] | null => {
  if (raw === null || raw === undefined) {
    return [];
  }
  if (!isWireRecord(raw) || !Array.isArray(raw.tasks)) {
    return null;
  }
  const tasks: DagTaskView[] = [];
  for (const entry of raw.tasks) {
    if (!isWireRecord(entry)) {
      return null;
    }
    const taskId = wireString(entry.task_id);
    const status = wireString(entry.status);
    if (taskId === null || status === null) {
      return null;
    }
    tasks.push({
      taskId,
      status,
      name: wireString(entry.name) ?? taskId,
      summary: wireString(entry.task_summary) ?? '',
    });
  }
  return tasks;
};

/**
 * Parse one bridge snapshot document into a renderable view. A `null` dag
 * means no event has landed yet: that is an empty view, not malformed.
 * Anything else that breaks the wire shape is malformed with the field
 * named, so the panel can render an error card instead of blank output.
 */
export const parseSnapshotDoc = (raw: JsonValue | undefined): DagSnapshotOutcome => {
  if (!isWireRecord(raw)) {
    return fail('snapshot');
  }
  const sessionId = wireString(raw.sessionId);
  if (sessionId === null) {
    return fail('sessionId');
  }
  if (raw.schemaVersion !== DAG_SNAPSHOT_SCHEMA_VERSION) {
    return fail('schemaVersion');
  }
  const updatedAt = wireString(raw.updatedAt) ?? '';
  if (raw.dag !== null && raw.dag !== undefined) {
    if (!isWireRecord(raw.dag) || !Array.isArray(raw.dag.runs)) {
      return fail('dag.runs');
    }
    const runs: DagRunView[] = [];
    for (let index = 0; index < raw.dag.runs.length; index += 1) {
      const run = readRun(raw.dag.runs[index]);
      if (!run) {
        return fail(`dag.runs[${index}]`);
      }
      runs.push(run);
    }
    const tasks = readTasks(raw.tasks);
    if (!tasks) {
      return fail('tasks');
    }
    return { ok: true, view: { sessionId, updatedAt, runs, tasks } };
  }
  const tasks = readTasks(raw.tasks);
  if (!tasks) {
    return fail('tasks');
  }
  return { ok: true, view: { sessionId, updatedAt, runs: [], tasks } };
};

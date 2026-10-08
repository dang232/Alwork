// Tests for `openchamber dag status|stream` (project-ide todo 13: CLI
// text parity for the DAG side pane). Vitest per the colocated CLI
// precedent; stdout is captured, no servers or engines are started — the
// bridge is stubbed, the snapshot round-trips through a real temp dir.
import { describe, expect, test, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import fixture from '../../server/lib/opencode/omo-bridge-fixture.json';
import { EXIT_CODE } from './cli-errors.js';
import {
  createDagCommand,
  defaultDagSnapshotDir,
  resolveDagSnapshotDir,
  summarizeDagSnapshot,
} from './commands-dag.js';

const scratchDirs = [];

const makeSnapshotDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-cli-'));
  scratchDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const snapshotDoc = {
  schemaVersion: 1,
  sessionId: fixture.sessionId,
  updatedAt: '2026-10-08T08:01:00.000Z',
  dag: fixture.dagUpdated,
  tasks: fixture.taskUpdated,
};

async function captureStdout(fn) {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = (chunk, ...rest) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    for (const arg of rest) {
      if (arg instanceof Function) {
        arg();
        break;
      }
    }
    return true;
  };
  try {
    await fn();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}

describe('dag snapshot dir', () => {
  test('flag beats env beats temp default', () => {
    expect(resolveDagSnapshotDir({ snapshotDir: '/x' })).toBe('/x');
    const previous = process.env.OMO_SNAPSHOT_DIR;
    process.env.OMO_SNAPSHOT_DIR = '/env-dir';
    try {
      expect(resolveDagSnapshotDir({})).toBe('/env-dir');
    } finally {
      if (previous === undefined) {
        delete process.env.OMO_SNAPSHOT_DIR;
      } else {
        process.env.OMO_SNAPSHOT_DIR = previous;
      }
    }
    expect(resolveDagSnapshotDir({})).toBe(defaultDagSnapshotDir());
  });
});

describe('dag status', () => {
  test('human mode prints run state textually', async () => {
    const dir = makeSnapshotDir();
    fs.writeFileSync(path.join(dir, `${fixture.sessionId}.snapshot.json`), JSON.stringify(snapshotDoc), 'utf8');
    const output = await captureStdout(() => createDagCommand()({ session: fixture.sessionId, snapshotDir: dir }, 'status'));
    expect(output).toContain('fixture-a');
    expect(output).toContain('build: running');
    expect(output).toContain('plan: completed');
    expect(output).toContain('1 run(s)');
  });

  test('quiet mode prints compact lines', async () => {
    const dir = makeSnapshotDir();
    fs.writeFileSync(path.join(dir, `${fixture.sessionId}.snapshot.json`), JSON.stringify(snapshotDoc), 'utf8');
    const output = await captureStdout(() => createDagCommand()({ session: fixture.sessionId, snapshotDir: dir, quiet: true }, 'status'));
    expect(output).toContain(`session ${fixture.sessionId} updated 2026-10-08T08:01:00.000Z`);
    expect(output).toContain('run fixture-a running pending=1 running=1 completed=1');
  });

  test('json mode prints the summary only', async () => {
    const dir = makeSnapshotDir();
    fs.writeFileSync(path.join(dir, `${fixture.sessionId}.snapshot.json`), JSON.stringify(snapshotDoc), 'utf8');
    const output = await captureStdout(() => createDagCommand()({ session: fixture.sessionId, snapshotDir: dir, json: true }, 'status'));
    const payload = JSON.parse(output);
    expect(payload.status).toBe('ok');
    expect(payload.snapshot.runs[0].runKey).toBe('fixture-a');
    expect(payload.snapshot.runs[0].nodes.map((node) => node.label)).toEqual(['plan', 'build', 'verify']);
  });

  test('missing snapshot fails loudly, malformed names the file', async () => {
    const dir = makeSnapshotDir();
    await expect(createDagCommand()({ session: 'ses_nope', snapshotDir: dir }, 'status')).rejects.toMatchObject({
      exitCode: EXIT_CODE.GENERAL_ERROR,
    });
    try {
      await createDagCommand()({ session: 'ses_nope', snapshotDir: dir }, 'status');
      expect.unreachable();
    } catch (error) {
      expect(error.message).toContain('[SNAPSHOT_MISSING]');
    }
    fs.writeFileSync(path.join(dir, 'ses_bad.snapshot.json'), 'not json{', 'utf8');
    try {
      await createDagCommand()({ session: 'ses_bad', snapshotDir: dir }, 'status');
      expect.unreachable();
    } catch (error) {
      expect(error.exitCode).toBe(EXIT_CODE.GENERAL_ERROR);
      expect(error.message).toContain('[SNAPSHOT_MALFORMED]');
    }
  });

  test('invalid session is a usage error', async () => {
    await expect(createDagCommand()({ session: '../evil', snapshotDir: makeSnapshotDir() }, 'status')).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE_ERROR,
    });
  });
});

describe('summarizeDagSnapshot', () => {
  test('tolerates partial documents', () => {
    expect(summarizeDagSnapshot(null).runs).toEqual([]);
    expect(summarizeDagSnapshot({ dag: { runs: [{ run_key: 'k' }] } }).runs[0].status).toBe('unknown');
  });
});

describe('dag stream', () => {
  const scriptedBridge = (probe) => () => ({
    probe: async () => probe,
    invoke: ({ message, sessionId, onEvent }) => {
      onEvent('omo.dag.updated', fixture.dagUpdated);
      onEvent('omo.task.updated', fixture.taskUpdated);
      onEvent('omo.unknown.event', {});
      return {
        entry: 'stub',
        argv: ['run', message],
        wait: async () => ({
          exitCode: 0,
          signal: null,
          result: { sessionId: sessionId ?? 'ses_stream01', success: true, summary: 'Stub run completed' },
          sessionId: sessionId ?? 'ses_stream01',
        }),
        cancel: async () => ({ provisional: true }),
      };
    },
  });

  test('prints engine events textually, then the result', async () => {
    let cleanup = 'unset';
    const output = await captureStdout(() => createDagCommand({
      createBridge: scriptedBridge({ available: true, compatible: true, code: 'OMO_PROBE_OK' }),
      setCancelCleanup: (handler) => { cleanup = handler; },
    })({ message: 'Go', session: fixture.sessionId }, 'stream'));
    expect(output).toContain('event omo.dag.updated runs=1');
    expect(output).toContain('event omo.task.updated tasks=1');
    expect(output).not.toContain('omo.unknown.event');
    expect(output).toContain('run ended');
    expect(cleanup).toBeNull();
  });

  test('absent engine degrades with the documented exit code', async () => {
    const detail = 'OmO engine not found. Install it yourself, then retry.';
    try {
      await createDagCommand({
        createBridge: scriptedBridge({ available: false, compatible: false, code: 'OMO_ENGINE_ABSENT', message: detail }),
      })({ message: 'Go' }, 'stream');
      expect.unreachable();
    } catch (error) {
      expect(error.exitCode).toBe(EXIT_CODE.MISSING_DEPENDENCY);
      expect(error.message).toContain('OmO engine not found');
    }
  });

  test('missing message is a usage error', async () => {
    await expect(createDagCommand()({}, 'stream')).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE_ERROR });
  });

  test('unknown action is a usage error', async () => {
    await expect(createDagCommand()({}, 'frobnicate')).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE_ERROR });
  });
});

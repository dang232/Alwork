// Service handler tests for the omo-dag-pane guest (project-ide todo 13).
// bun:test, no servers: `handleRequest` is called directly with a scripted
// bridge. The live steer/cancel path spawns a REAL sleeper child (the
// platform node binary) and kills it through the REAL bridge `cancelRun`,
// so the test proves steer starts a process and cancel terminates it.
import { describe, expect, test, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';
import nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cancelRun } from '../../web/server/lib/opencode/omo-bridge-runtime.js';
import { createDagServiceHandlers } from './handlers.js';

const scratchDirs = [];
const liveChildren = [];

const makeSnapshotDir = () => {
  const dir = nodeFs.mkdtempSync(join(tmpdir(), 'dag-svc-'));
  scratchDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const child of liveChildren.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already exited: the cancel under test terminated it.
    }
  }
  for (const dir of scratchDirs.splice(0)) {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

const absentBridge = () => ({
  probe: async () => ({ available: false, compatible: false, code: 'OMO_ENGINE_ABSENT' }),
  invoke: () => {
    throw Object.assign(new Error('OmO engine not found.'), { code: 'OMO_ENGINE_ABSENT' });
  },
});

// A stub bridge whose invoke starts a real sleeper process and whose cancel
// is the real provisional kill, so steer/cancel act on a live session.
const sleeperBridge = (probeResult) => ({
  probe: async () => probeResult,
  invoke: ({ message, sessionId }) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore', windowsHide: true });
    liveChildren.push(child);
    const wait = () => new Promise((resolve) => {
      child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    return {
      entry: 'stub-sleeper',
      argv: ['run', message, '--session-id', sessionId, '--json'],
      child,
      writer: null,
      wait,
      cancel: (reason) => cancelRun({ child }, reason, { cancelGraceMs: 100 }),
    };
  },
});

const handlersWith = (snapshotDir, createBridge) => (
  createDagServiceHandlers({ fs: nodeFs, snapshotDir, createBridge })
);

describe('dag service handlers', () => {
  test('health answers ready', async () => {
    const { handleRequest } = handlersWith(makeSnapshotDir(), absentBridge);
    const answer = await handleRequest({ method: 'GET', path: '/health' });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ ok: true, service: 'omo-dag-pane' });
  });

  test('status passes the probe through and lists snapshot sessions', async () => {
    const dir = makeSnapshotDir();
    nodeFs.writeFileSync(join(dir, 'ses_live01.snapshot.json'), '{"schemaVersion":1}', 'utf8');
    const { handleRequest } = handlersWith(dir, () => sleeperBridge({ available: true, compatible: true, code: 'OMO_PROBE_OK' }));
    const answer = await handleRequest({ method: 'GET', path: '/status' });
    expect(answer.status).toBe(200);
    expect(answer.body.probe.code).toBe('OMO_PROBE_OK');
    expect(answer.body.sessions).toEqual(['ses_live01']);
  });

  test('snapshot reads the bridge file, missing and malformed degrade by code', async () => {
    const dir = makeSnapshotDir();
    const doc = {
      schemaVersion: 1, sessionId: 'ses_live01', updatedAt: '2026-10-08T08:01:00.000Z', dag: null, tasks: null,
    };
    nodeFs.writeFileSync(join(dir, 'ses_live01.snapshot.json'), JSON.stringify(doc), 'utf8');
    nodeFs.writeFileSync(join(dir, 'ses_bad.snapshot.json'), 'not json{', 'utf8');
    const { handleRequest } = handlersWith(dir, absentBridge);
    const read = await handleRequest({ method: 'GET', path: '/snapshot', query: { sessionId: 'ses_live01' } });
    expect(read).toEqual({ status: 200, body: doc });
    const missing = await handleRequest({ method: 'GET', path: '/snapshot', query: { sessionId: 'ses_nope' } });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('OMO_DAG_SNAPSHOT_MISSING');
    const malformed = await handleRequest({ method: 'GET', path: '/snapshot', query: { sessionId: 'ses_bad' } });
    expect(malformed.status).toBe(422);
    expect(malformed.body.code).toBe('DAG_SNAPSHOT_MALFORMED');
    const noSession = await handleRequest({ method: 'GET', path: '/snapshot', query: {} });
    expect(noSession.status).toBe(400);
    expect(noSession.body.code).toBe('OMO_DAG_SESSION_REQUIRED');
  });

  test('steer validates input before spawning', async () => {
    const { handleRequest } = handlersWith(makeSnapshotDir(), absentBridge);
    const emptyMessage = await handleRequest({ method: 'POST', path: '/steer', body: { message: '  ', sessionId: 'ses_live01' } });
    expect(emptyMessage.status).toBe(400);
    const noSession = await handleRequest({ method: 'POST', path: '/steer', body: { message: 'Go' } });
    expect(noSession.status).toBe(400);
    expect(noSession.body.code).toBe('OMO_DAG_SESSION_REQUIRED');
  });

  test('steer without an engine answers 503 with the degraded message', async () => {
    const { handleRequest } = handlersWith(makeSnapshotDir(), absentBridge);
    const answer = await handleRequest({
      method: 'POST', path: '/steer', body: { message: 'Go', sessionId: 'ses_live01' },
    });
    expect(answer.status).toBe(503);
    expect(answer.body.code).toBe('OMO_ENGINE_ABSENT');
    expect(answer.body.message.length).toBeGreaterThan(0);
  });

  test('steer starts a live session and cancel terminates it', async () => {
    const { handleRequest, live } = handlersWith(
      makeSnapshotDir(),
      () => sleeperBridge({ available: true, compatible: true, code: 'OMO_PROBE_OK' }),
    );
    const steered = await handleRequest({
      method: 'POST', path: '/steer', body: { message: 'Keep going', sessionId: 'ses_live01' },
    });
    expect(steered.status).toBe(200);
    expect(steered.body.sessionId).toBe('ses_live01');
    expect(steered.body.argv).toContain('--session-id');
    expect(live.has('ses_live01')).toBe(true);

    const cancelled = await handleRequest({
      method: 'POST', path: '/cancel', body: { sessionId: 'ses_live01', reason: 'test cancel' },
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.ok).toBe(true);
    expect(cancelled.body.receipt.provisional).toBe(true);
    expect(cancelled.body.receipt.reason).toBe('test cancel');
    expect(live.has('ses_live01')).toBe(false);

    const again = await handleRequest({ method: 'POST', path: '/cancel', body: { sessionId: 'ses_live01' } });
    expect(again.status).toBe(404);
    expect(again.body.code).toBe('OMO_DAG_NO_RUN');
  });

  test('unknown paths 404 with the path echoed', async () => {
    const { handleRequest } = handlersWith(makeSnapshotDir(), absentBridge);
    const answer = await handleRequest({ method: 'GET', path: '/nope' });
    expect(answer.status).toBe(404);
    expect(answer.body.code).toBe('OMO_DAG_UNKNOWN_PATH');
  });
});

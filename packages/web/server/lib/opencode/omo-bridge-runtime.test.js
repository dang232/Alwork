// Fixture-driven tests for the OmO adapter-A runtime bridge. No engine is
// installed: the fixture snapshot JSON drives render/snapshot cases, scripted
// stub spawn/spawnSync stand in for the wrapper, and three tests use the real
// node binary / real child processes to prove the spawn, wait, and kill paths.
import { describe, expect, it, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import { spawn as realSpawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OmoBridgeError,
  buildRunArgv,
  cancelRun,
  createOmoBridgeRuntime,
  createSnapshotWriter,
  defaultSnapshotPath,
  engineAbsentMessage,
  parseEventLine,
} from './omo-bridge-runtime.js';

const fixture = JSON.parse(readFileSync(new URL('./omo-bridge-fixture.json', import.meta.url), 'utf8'));

const createMemoryFs = () => {
  const files = new Map();
  return {
    files,
    writeFileSync: (path, content) => {
      files.set(path, String(content));
    },
    renameSync: (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
};

const liveChildren = [];
afterEach(() => {
  for (const child of liveChildren.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already exited; nothing to clean up.
    }
  }
});

// Scripted stand-in for the wrapper entry: answers --version and run --help
// from canned text so probe tests never touch a real engine.
const stubSpawnSync = ({ versionText = 'omo-fixture 9.9.9', helpText = 'run <message> --port <port> --attach <url> --session-id <id> --json' } = {}) => {
  const calls = [];
  const spawnSync = (entry, args, options) => {
    calls.push({ entry, args, options });
    if (args[0] === '--version') {
      return { status: 0, stdout: `${versionText}\n`, error: undefined };
    }
    return { status: 0, stdout: `${helpText}\n`, error: undefined };
  };
  return { spawnSync, calls };
};

class FakeStdout extends EventEmitter {}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new FakeStdout();
    this.stderr = new FakeStdout();
    this.exitCode = null;
    this.signalCode = null;
    this.killedWith = [];
  }
  kill(signal = 'SIGTERM') {
    this.killedWith.push(signal);
    if (this.exitCode !== null) {
      return false;
    }
    this.exitCode = null;
    this.signalCode = signal;
    this.emit('exit', null, signal);
    this.emit('close', null, signal);
    return true;
  }
}

// Scripted stand-in for spawn: asserts nothing itself, records argv, and lets
// each test script stdout lines plus the exit.
const stubSpawn = ({ lines = [], exitCode = 0 } = {}) => {
  const calls = [];
  let child;
  const spawn = (entry, argv, options) => {
    calls.push({ entry, argv, options });
    child = new FakeChild();
    setImmediate(() => {
      for (const line of lines) {
        child.stdout.emit('data', `${line}\n`);
      }
      child.exitCode = exitCode;
      child.emit('exit', exitCode, null);
      child.emit('close', exitCode, null);
    });
    return child;
  };
  return { spawn, calls, getChild: () => child };
};

describe('probe (version/capability handshake)', () => {
  it('engine-absent yields the documented degraded message and never hangs', async () => {
    const startedAt = Date.now();
    const bridge = createOmoBridgeRuntime({ resolveEngineEntry: () => '/nonexistent/oh-my-opencode.js' });
    const result = await bridge.probe({ timeoutMs: 1000 });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(result.available).toBe(false);
    expect(result.code).toBe('OMO_ENGINE_ABSENT');
    expect(result.message).toContain('stays empty');
    expect(result.message).toContain('nothing is fetched automatically');
  });

  it('unresolved entry degrades the same way', async () => {
    const bridge = createOmoBridgeRuntime({ resolveEngineEntry: () => null });
    const result = await bridge.probe({ timeoutMs: 1000 });
    expect(result.available).toBe(false);
    expect(result.code).toBe('OMO_ENGINE_ABSENT');
  });

  it('compatible stub answers version plus all four run flags', async () => {
    const { spawnSync } = stubSpawnSync();
    const bridge = createOmoBridgeRuntime({
      resolveEngineEntry: () => '/user/engine/bin/oh-my-opencode.js',
      existsSync: () => true,
      spawnSync,
    });
    const result = await bridge.probe();
    expect(result.available).toBe(true);
    expect(result.compatible).toBe(true);
    expect(result.code).toBe('OMO_PROBE_OK');
    expect(result.version).toBe('9.9.9');
    expect(result.runFlags).toEqual(['--port', '--attach', '--session-id', '--json']);
    expect(result.missingRunFlags).toEqual([]);
  });

  it('stub missing flags reports incompatible with the missing names', async () => {
    const { spawnSync } = stubSpawnSync({ helpText: 'run <message> --port <port>' });
    const bridge = createOmoBridgeRuntime({
      resolveEngineEntry: () => '/user/engine/bin/oh-my-opencode.js',
      existsSync: () => true,
      spawnSync,
    });
    const result = await bridge.probe();
    expect(result.available).toBe(true);
    expect(result.compatible).toBe(false);
    expect(result.code).toBe('OMO_PROBE_INCOMPATIBLE');
    expect(result.missingRunFlags).toEqual(['--attach', '--session-id', '--json']);
  });

  it('wedged engine hits the bounded timeout instead of hanging', async () => {
    const spawnSync = () => {
      const error = new Error('timed out');
      error.code = 'ETIMEDOUT';
      return { status: null, stdout: '', error };
    };
    const bridge = createOmoBridgeRuntime({
      resolveEngineEntry: () => '/user/engine/bin/oh-my-opencode.js',
      existsSync: () => true,
      spawnSync,
    });
    const startedAt = Date.now();
    const result = await bridge.probe({ timeoutMs: 300 });
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(result.available).toBe(false);
    expect(result.code).toBe('OMO_PROBE_TIMEOUT');
  });

  it('real node binary answers --version through the real spawnSync path', async () => {
    const bridge = createOmoBridgeRuntime({ resolveEngineEntry: () => process.execPath });
    const result = await bridge.probe({ timeoutMs: 10000 });
    expect(result.available).toBe(true);
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
    // node has no `run` subcommand: the flag check honestly reports that.
    expect(result.compatible).toBe(false);
    expect(result.missingRunFlags).toEqual(['--port', '--attach', '--session-id', '--json']);
  });
});

describe('invoke (wrapper contract argv)', () => {
  it('port variant builds run <message> --port N --json', () => {
    const { spawn } = stubSpawn();
    const bridge = createOmoBridgeRuntime({
      resolveEngineEntry: () => '/user/engine/bin/oh-my-opencode.js',
      existsSync: () => true,
      spawn,
    });
    const handle = bridge.invoke({ message: 'Fix the bug', port: 4321 });
    expect(handle.entry).toBe('/user/engine/bin/oh-my-opencode.js');
    expect(handle.argv).toEqual(['run', 'Fix the bug', '--port', '4321', '--json']);
  });

  it('attach plus session-id variant builds the documented order', () => {
    const { spawn, calls } = stubSpawn();
    const bridge = createOmoBridgeRuntime({
      resolveEngineEntry: () => '/user/engine/bin/oh-my-opencode.js',
      existsSync: () => true,
      spawn,
    });
    bridge.invoke({ message: 'Continue', attachUrl: 'http://127.0.0.1:4321', sessionId: 'ses_abc123' });
    expect(calls[0].argv).toEqual(['run', 'Continue', '--attach', 'http://127.0.0.1:4321', '--session-id', 'ses_abc123', '--json']);
  });

  it('port plus attach together is rejected (Gap 2 mutual exclusivity)', () => {
    expect(() => buildRunArgv({ message: 'x', port: 1, attachUrl: 'http://127.0.0.1:1' }))
      .toThrow(/mutually exclusive/);
  });

  it('out-of-range ports are rejected (Gap 4 range 1..65535)', () => {
    for (const port of [0, -1, 99999, 1.5]) {
      expect(() => buildRunArgv({ message: 'x', port })).toThrow(/Port must be between 1 and 65535/);
    }
  });

  it('empty message is rejected', () => {
    expect(() => buildRunArgv({ message: '   ' })).toThrow(/non-empty message/);
  });

  it('engine-absent throws the degraded message instead of spawning', () => {
    const { spawn, calls } = stubSpawn();
    const bridge = createOmoBridgeRuntime({ resolveEngineEntry: () => null, spawn });
    let thrown = null;
    try {
      bridge.invoke({ message: 'hi' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OmoBridgeError);
    expect(thrown.code).toBe('OMO_ENGINE_ABSENT');
    expect(thrown.message).toContain('stays empty');
    expect(calls).toEqual([]);
  });

  it('wait resolves the --json final result from stub stdout', async () => {
    const { spawn } = stubSpawn({ lines: [JSON.stringify(fixture.runResult)], exitCode: 0 });
    const bridge = createOmoBridgeRuntime({
      resolveEngineEntry: () => '/user/engine/bin/oh-my-opencode.js',
      existsSync: () => true,
      spawn,
    });
    const settled = await bridge.invoke({ message: 'hi' }).wait();
    expect(settled.exitCode).toBe(0);
    expect(settled.result).toMatchObject({ sessionId: 'ses_fixture01', success: true });
    expect(settled.sessionId).toBe('ses_fixture01');
  });

  it('real spawn of the node binary exits and wait captures it', async () => {
    const bridge = createOmoBridgeRuntime({ resolveEngineEntry: () => process.execPath });
    const handle = bridge.invoke({ message: 'hi' });
    liveChildren.push(handle.child);
    const settled = await handle.wait();
    // node tries to run a script literally named `run` and exits non-zero.
    expect(settled.exitCode).not.toBe(0);
    expect(settled.result).toBeNull();
  }, 15000);
});

describe('stream (session-filtered snapshot writer)', () => {
  const createWriter = (fs, sessionId = fixture.sessionId) => createSnapshotWriter({
    sessionId,
    snapshotPath: '/snap/ses_fixture01.snapshot.json',
    fs,
  });

  it('fixture snapshot renders through the snapshot path', () => {
    const fs = createMemoryFs();
    const writer = createWriter(fs);
    const dagOutcome = writer.handleEvent('omo.dag.updated', fixture.dagUpdated);
    const taskOutcome = writer.handleEvent('omo.task.updated', fixture.taskUpdated);
    expect(dagOutcome).toEqual({ accepted: true, written: true });
    expect(taskOutcome).toEqual({ accepted: true, written: true });
    const document = JSON.parse(fs.files.get('/snap/ses_fixture01.snapshot.json'));
    expect(document.schemaVersion).toBe(1);
    expect(document.sessionId).toBe('ses_fixture01');
    expect(document.dag.runs[0].run_id).toBe('run_fixture_a');
    expect(document.dag.runs[0].nodes).toHaveLength(3);
    expect(document.dag.runs[0].nodes.map((node) => node.id))
      .toEqual(['node_plan', 'node_build', 'node_verify']);
    expect(document.tasks.tasks[0].task_id).toBe('st_fixture0000000000000001');
    expect(writer.stats).toMatchObject({ acceptedDag: 1, acceptedTask: 1, writes: 2 });
  });

  it('other-session payloads are filtered out, never stored', () => {
    const fs = createMemoryFs();
    const writer = createWriter(fs);
    const outcome = writer.handleEvent('omo.dag.updated', fixture.dagUpdatedOtherSession);
    expect(outcome).toEqual({ accepted: false, written: false, reason: 'wrong_session' });
    expect(fs.files.size).toBe(0);
    expect(writer.stats.droppedWrongSession).toBe(1);
  });

  it('malformed input degrades to counters, never crashes', () => {
    const fs = createMemoryFs();
    const writer = createWriter(fs);
    for (const line of fixture.malformedLines) {
      expect(() => writer.handleLine(line)).not.toThrow();
    }
    expect(() => writer.handleEvent('omo.dag.updated', null)).not.toThrow();
    expect(() => writer.handleEvent('omo.dag.updated', { nope: true })).not.toThrow();
    expect(fs.files.size).toBe(0);
    expect(writer.stats.droppedMalformed).toBe(4);
    expect(writer.stats.droppedUnknownType).toBe(1);
    expect(writer.stats.droppedWrongSession).toBe(2);
  });

  it('oversize snapshots are dropped and counted, the file stays put', () => {
    const fs = createMemoryFs();
    const writer = createSnapshotWriter({
      sessionId: fixture.sessionId,
      snapshotPath: '/snap/ses_fixture01.snapshot.json',
      fs,
      maxSnapshotBytes: 10,
    });
    const outcome = writer.handleEvent('omo.dag.updated', fixture.dagUpdated);
    expect(outcome).toEqual({ accepted: true, written: false, reason: 'snapshot_too_large' });
    expect(fs.files.size).toBe(0);
    expect(writer.stats.droppedOversize).toBe(1);
  });

  it('writer construction misuse throws a coded error', () => {
    const fs = createMemoryFs();
    expect(() => createSnapshotWriter({ sessionId: '', snapshotPath: '/x', fs })).toThrow(OmoBridgeError);
    expect(() => createSnapshotWriter({ sessionId: 's', snapshotPath: '', fs })).toThrow(OmoBridgeError);
    expect(() => defaultSnapshotPath('/snap', 'ses/../evil')).toThrow(/snapshot filename/);
    expect(defaultSnapshotPath('/snap', 'ses_fixture01')).toBe(join('/snap', 'ses_fixture01.snapshot.json'));
  });

  it('stub event lines pumped through invoke land in the session snapshot', async () => {
    const eventLine = JSON.stringify({ type: 'omo.dag.updated', data: fixture.dagUpdated });
    const { spawn } = stubSpawn({ lines: [eventLine, JSON.stringify(fixture.runResult)], exitCode: 0 });
    const fs = createMemoryFs();
    const bridge = createOmoBridgeRuntime({
      resolveEngineEntry: () => '/user/engine/bin/oh-my-opencode.js',
      existsSync: () => true,
      spawn,
      fs,
      snapshotDir: '/snap',
    });
    const seen = [];
    const handle = bridge.invoke({ message: 'hi', sessionId: fixture.sessionId, onEvent: (name, data) => seen.push([name, data]) });
    const settled = await handle.wait();
    expect(settled.exitCode).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe('omo.dag.updated');
    const document = JSON.parse(fs.files.get(join('/snap', 'ses_fixture01.snapshot.json')));
    expect(document.dag.runs[0].run_id).toBe('run_fixture_a');
  });

  it('parseEventLine routes result lines and event lines', () => {
    expect(parseEventLine('nope{').error).toBe('malformed_json');
    expect(parseEventLine('[1]').error).toBe('malformed_json');
    expect(parseEventLine(JSON.stringify(fixture.runResult)).result).toMatchObject({ success: true });
    const parsed = parseEventLine(JSON.stringify({ type: 'omo.task.updated', data: fixture.taskUpdated }));
    expect(parsed.event.name).toBe('omo.task.updated');
    expect(parsed.event.data.parent_session_id).toBe('ses_fixture01');
  });
});

describe('cancel (PROVISIONAL kill-with-reason)', () => {
  it('scripted child records SIGTERM with the caller reason', async () => {
    const { spawn } = stubSpawn();
    const bridge = createOmoBridgeRuntime({
      resolveEngineEntry: () => '/user/engine/bin/oh-my-opencode.js',
      existsSync: () => true,
      spawn,
    });
    const handle = bridge.invoke({ message: 'long run' });
    const receipt = await handle.cancel('user asked to stop');
    expect(receipt).toMatchObject({
      provisional: true,
      alreadyExited: false,
      escalated: false,
      reason: 'user asked to stop',
    });
  });

  it('real sleeper child is terminated with a documented receipt', async () => {
    const child = realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    liveChildren.push(child);
    const receipt = await cancelRun({ child }, 'qa cancel', { cancelGraceMs: 5000 });
    expect(receipt.provisional).toBe(true);
    expect(receipt.alreadyExited).toBe(false);
    expect(receipt.escalated).toBe(false);
    expect(receipt.reason).toBe('qa cancel');
    expect(receipt.signal).toBe('SIGTERM');
    // Signal-terminated children keep exitCode null with signalCode set.
    expect(child.signalCode ?? child.exitCode).not.toBeNull();
  }, 15000);

  it('already-exited runs report alreadyExited instead of signaling', async () => {
    const { spawn } = stubSpawn({ exitCode: 0 });
    const bridge = createOmoBridgeRuntime({
      resolveEngineEntry: () => '/user/engine/bin/oh-my-opencode.js',
      existsSync: () => true,
      spawn,
    });
    const handle = bridge.invoke({ message: 'quick' });
    await handle.wait();
    const receipt = await handle.cancel('late cancel');
    expect(receipt.alreadyExited).toBe(true);
    expect(receipt.reason).toBe('late cancel');
  });

  it('handle without a child throws a coded error', async () => {
    let thrown = null;
    try {
      await cancelRun({}, 'x');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OmoBridgeError);
    expect(thrown.code).toBe('OMO_CANCEL_NO_CHILD');
  });
});

describe('degraded message contract', () => {
  it('names the empty slot and rules out silent fetching', () => {
    const message = engineAbsentMessage('/user/engine/bin/oh-my-opencode.js');
    expect(message).toContain('/user/engine/bin/oh-my-opencode.js');
    expect(message).toContain('stays empty');
    expect(message).toContain('nothing is fetched automatically');
    expect(engineAbsentMessage(null)).toContain('OMO_WRAPPER_PATH');
  });
});

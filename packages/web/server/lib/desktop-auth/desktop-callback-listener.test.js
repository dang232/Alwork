import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import http from 'node:http';

import { createDesktopAuthRuntime } from './desktop-auth.js';
import {
  DESKTOP_CALLBACK_HOST,
  DESKTOP_CALLBACK_PORT,
  startDesktopCallbackListener,
} from './desktop-callback-listener.js';

// The dedicated listener mounts the desktop-auth callback with the same
// handler and pending-request map the main server uses: a login the main
// server starts must complete through this listener.
const listeners = [];

afterEach(async () => {
  while (listeners.length > 0) {
    const listener = listeners.pop();
    try {
      await listener.stop();
    } catch {
      // Already closed by the case under test.
    }
  }
});

const track = (listener) => {
  listeners.push(listener);
  return listener;
};

const createRuntime = () => createDesktopAuthRuntime({
  uiAuthController: {
    handleSessionCreate: async (_req, res) => res.status(200).json({ authenticated: true }),
  },
  alcoreSecret: 'test-alcore-secret-32-chars-long!!',
  serviceFetch: async () => ({ status: 404, json: async () => null }),
});

describe('desktop Google callback listener', () => {
  test('binds the fixed registered loopback pair by default', () => {
    expect(DESKTOP_CALLBACK_PORT).toBe(57123);
    expect(DESKTOP_CALLBACK_HOST).toBe('127.0.0.1');
  });

  test('serves the shared callback handler: malformed input fails named, never silent', async () => {
    const runtime = createRuntime();
    const listener = track(await startDesktopCallbackListener({
      express,
      registerCallbackRoute: runtime.registerCallbackRoute,
      activePort: 3901,
      port: 0,
    }));
    expect(listener.skipped).toBe(false);

    const missing = await fetch(`http://127.0.0.1:${listener.port}/auth/desktop-google/callback`);
    const missingBody = await missing.text();
    expect(missing.status).toBe(400);
    expect(missingBody).toContain('data-auth-error="invalid_request"');

    const refused = await fetch(
      `http://127.0.0.1:${listener.port}/auth/desktop-google/callback?state=${'ab'.repeat(16)}&error=access_denied`,
    );
    const refusedBody = await refused.text();
    expect(refused.status).toBe(400);
    expect(refusedBody).toContain('data-auth-error="google_oauth_error"');

    const unknown = await fetch(
      `http://127.0.0.1:${listener.port}/auth/desktop-google/callback?state=${'ab'.repeat(16)}&code=code`,
    );
    const unknownBody = await unknown.text();
    expect(unknown.status).toBe(410);
    expect(unknownBody).toContain('data-auth-error="invalid_state"');
  });

  test('shares the runtime pending map: a request the main server minted completes here', async () => {
    const runtime = createRuntime();
    const listener = track(await startDesktopCallbackListener({
      express,
      registerCallbackRoute: runtime.registerCallbackRoute,
      activePort: 3901,
      port: 0,
    }));
    const requestId = 'cd'.repeat(16);
    runtime._pendingGoogle.set(requestId, {
      verifier: 'verifier',
      nonce: 'nonce',
      redirectUri: `http://127.0.0.1:${DESKTOP_CALLBACK_PORT}/auth/desktop-google/callback`,
      pair: 'service-access-token',
      failure: null,
      expiresAt: Date.now() + 60_000,
    });

    const response = await fetch(
      `http://127.0.0.1:${listener.port}/auth/desktop-google/callback?state=${requestId}&code=code`,
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('Signed in');
  });

  test('an occupied port fails loudly naming it', async () => {
    const squatter = http.createServer((_req, res) => res.end('nope'));
    await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    const takenPort = squatter.address()?.port ?? 0;
    listeners.push({ stop: async () => { await new Promise((resolve) => squatter.close(() => resolve())); } });
    const runtime = createRuntime();

    const error = await startDesktopCallbackListener({
      express,
      registerCallbackRoute: runtime.registerCallbackRoute,
      activePort: 3901,
      port: takenPort,
    }).then(
      () => null,
      (failure) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(String(takenPort));
    expect(error.message).toContain('occupied');
  });

  test('skips when the main server already serves the fixed port', async () => {
    let registered = 0;
    const listener = track(await startDesktopCallbackListener({
      express,
      registerCallbackRoute: () => { registered += 1; },
      activePort: DESKTOP_CALLBACK_PORT,
    }));
    expect(listener.skipped).toBe(true);
    expect(listener.server).toBeNull();
    expect(registered).toBe(0);
  });

  test('refuses to start without the shared registrar instead of losing logins silently', async () => {
    const error = await startDesktopCallbackListener({
      express,
      registerCallbackRoute: null,
      activePort: 3901,
      port: 0,
    }).then(
      () => null,
      (failure) => failure,
    );
    expect(error).toBeInstanceOf(Error);
  });

  test('stop closes the listener', async () => {
    const runtime = createRuntime();
    const listener = track(await startDesktopCallbackListener({
      express,
      registerCallbackRoute: runtime.registerCallbackRoute,
      activePort: 3901,
      port: 0,
    }));
    const boundPort = listener.port;
    await listener.stop();
    listeners.pop();
    await expect(fetch(`http://127.0.0.1:${boundPort}/auth/desktop-google/callback`)).rejects.toThrow();
  });
});

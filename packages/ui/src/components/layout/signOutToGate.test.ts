import { describe, expect, test } from 'bun:test';

import { clearAutoSignOutMark, signOutToGate, signOutToGateOnce } from './signOutToGate';

// The shared sign-out sequence (header button + automatic quota-expiry
// path): POST the existing global sign-out route, then reload into the
// gate. window is stubbed per test (fetch + location + sessionStorage);
// the desktop credential branch stays off because the stub is not a
// desktop shell. Each test re-arms the once-guard first: the module flag
// is file-scoped, so tests must not leak a fired guard into each other.
// SAFETY: the stub installs a plain-object window below and this file
// restores the original value after each test; only presence is read here.
const originalWindow = (globalThis as { window?: unknown }).window;
const originalFetch = globalThis.fetch;

const installWindow = (fetchImpl: (input: string) => Promise<Response>) => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const session = new Map<string, string>();
  let reloads = 0;
  // runtimeFetch calls the global fetch; location/sessionStorage come
  // from window. Both are stubbed, both restored.
  // SAFETY: signOutToGate only calls fetch(input, init); Bun's extra
  // `preconnect` member is never read.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return fetchImpl(String(input));
  }) as typeof fetch;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        origin: 'http://127.0.0.1:3001',
        href: 'http://127.0.0.1:3001/',
        protocol: 'http:',
        reload: () => {
          reloads += 1;
        },
      },
      sessionStorage: {
        getItem: (key: string) => session.get(key) ?? null,
        setItem: (key: string, value: string) => {
          session.set(key, value);
        },
        removeItem: (key: string) => {
          session.delete(key);
        },
      },
    },
  });
  const restore = () => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  };
  return { requests, reloads: () => reloads, session, restore };
};

const okReset = () => new Response('{}', { status: 200 });

describe('signOutToGate', () => {
  test('posts the reset route, then reloads into the gate', async () => {
    const w = installWindow(async () => okReset());
    try {
      clearAutoSignOutMark();
      await signOutToGate();
      expect(w.requests).toHaveLength(1);
      expect(w.requests[0]?.url).toContain('/api/auth/reset');
      expect(w.requests[0]?.init?.method).toBe('POST');
      expect(w.reloads()).toBe(1);
    } finally {
      w.restore();
    }
  });

  test('a failing reset still reloads and never throws', async () => {
    const w = installWindow(async () => {
      throw new Error('down');
    });
    try {
      clearAutoSignOutMark();
      await signOutToGate();
      expect(w.reloads()).toBe(1);
    } finally {
      w.restore();
    }
  });

  test('the automatic path fires once, then reads as already signed out', async () => {
    const w = installWindow(async () => okReset());
    try {
      clearAutoSignOutMark();
      await signOutToGateOnce();
      await signOutToGateOnce();
      expect(w.requests).toHaveLength(1);
      expect(w.reloads()).toBe(1);
      expect(w.session.get('oc_quota_signout_v1')).toBe('1');
    } finally {
      w.restore();
    }
  });

  test('a present marker blocks the automatic path until re-armed', async () => {
    const w = installWindow(async () => okReset());
    try {
      clearAutoSignOutMark();
      w.session.set('oc_quota_signout_v1', '1');
      await signOutToGateOnce();
      expect(w.requests).toHaveLength(0);
      expect(w.reloads()).toBe(0);
      clearAutoSignOutMark();
      await signOutToGateOnce();
      expect(w.requests).toHaveLength(1);
      expect(w.reloads()).toBe(1);
    } finally {
      w.restore();
    }
  });
});

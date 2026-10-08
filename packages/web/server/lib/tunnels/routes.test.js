import { describe, expect, it } from 'bun:test';
import { createTunnelRoutesRuntime } from './routes.js';

// The password gate is gone: Alcore login owns browser auth, so tunnel
// start no longer takes a password precondition. Enterprise mode still
// refuses every tunnel, and the happy path still starts the provider.
describe('public tunnel gate', () => {
  const createRuntime = () => {
    let starts = 0;
    const runtime = createTunnelRoutesRuntime({
      tunnelService: {
        start: async () => {
          starts += 1;
          return { provider: 'cloudflare', publicUrl: 'https://example.com', activeMode: 'quick' };
        },
      },
      TUNNEL_PROVIDER_CLOUDFLARE: 'cloudflare',
      TUNNEL_MODE_MANAGED_REMOTE: 'managed-remote',
    });
    return { runtime, getStarts: () => starts };
  };

  it('rejects the HTTP start route in enterprise mode without disturbing an existing tunnel', async () => {
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      const { runtime, getStarts } = createRuntime();
      const routes = new Map();
      runtime.registerRoutes({
        get: (path, handler) => routes.set(`GET ${path}`, handler),
        post: (path, handler) => routes.set(`POST ${path}`, handler),
        put: (path, handler) => routes.set(`PUT ${path}`, handler),
      });
      let status = 200;
      let body;
      await routes.get('POST /api/openchamber/tunnel/start')({ body: {} }, {
        status(code) { status = code; return this; },
        json(payload) { body = payload; return this; },
      });
      expect(status).toBe(403);
      expect(body.code).toBe('enterprise_mode');
      expect(getStarts()).toBe(0);
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
  });

  it('refuses every tunnel in enterprise mode', async () => {
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      const { runtime, getStarts } = createRuntime();
      await expect(runtime.startTunnelWithNormalizedRequest({ provider: 'cloudflare', mode: 'quick' }))
        .rejects.toThrow('enterprise mode');
      expect(getStarts()).toBe(0);
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
  });

  it('starts a tunnel outside enterprise mode with no password precondition', async () => {
    const { runtime, getStarts } = createRuntime();
    const result = await runtime.startTunnelWithNormalizedRequest({ provider: 'cloudflare', mode: 'quick' });
    expect(result.publicUrl).toBe('https://example.com');
    expect(getStarts()).toBe(1);
  });
});

// Dedicated loopback listener for the desktop Google OAuth callback.
//
// The registered Google redirect URI is fixed
// (http://127.0.0.1:57123/auth/desktop-google/callback), but only the
// packaged desktop server binds that port as its main listener. Dev layouts
// serve the UI and API on dynamic ports (Vite HMR on 51xx, API on 39xx), so
// without this module the system browser's callback lands on a refused
// connection. This listener closes that gap: a minimal loopback server that
// mounts ONLY the existing desktop-auth callback route — same handler, same
// pending-request map — so a login started on any serving port completes.
//
// Boundary: loopback-only (127.0.0.1). It serves the same public callback
// route the main server already exposes, so it adds no new crossing: no
// enterprise gate applies, and it never binds a network address.
import http from 'node:http';

import { DESKTOP_PORT } from './desktop-auth.js';

export const DESKTOP_CALLBACK_PORT = DESKTOP_PORT;
export const DESKTOP_CALLBACK_HOST = '127.0.0.1';

export const desktopCallbackPortOccupiedMessage = (port, host) =>
  `Desktop Google callback port ${port} is occupied (${host}). Close the other app using it, then start OpenChamber again.`;

// Starts the fixed-port callback listener, unless the main server already
// serves on that port. `registerCallbackRoute` must be the desktop-auth
// runtime's own (sharing its pending-request map with the login start).
// `port`/`host` overrides exist for tests; production always uses the fixed
// loopback pair. An occupied port rejects loudly naming it (existing rule).
export const startDesktopCallbackListener = async ({
  express,
  registerCallbackRoute,
  activePort,
  createServer = (app) => http.createServer(app),
  port = DESKTOP_CALLBACK_PORT,
  host = DESKTOP_CALLBACK_HOST,
} = {}) => {
  if (registerCallbackRoute === undefined || registerCallbackRoute === null) {
    throw new Error('Desktop Google callback route is not registered: login cannot complete.');
  }
  if (Number(activePort) === Number(port)) {
    return { skipped: true, server: null, port: Number(port), stop: async () => {} };
  }
  const app = express();
  registerCallbackRoute({ get: (...args) => app.get(...args) });
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('error', onError);
      if (error?.code === 'EADDRINUSE') {
        reject(new Error(desktopCallbackPortOccupiedMessage(port, host)));
        return;
      }
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const boundPort = () => server.address()?.port ?? Number(port);
  console.log(`Desktop Google callback listening on ${host}:${boundPort()}`);
  const stop = async () => {
    try {
      server.closeAllConnections?.();
    } catch {
      // Older runtimes lack closeAllConnections; close() still drains.
    }
    await new Promise((resolve) => server.close(() => resolve()));
  };
  return { skipped: false, server, port: boundPort(), stop };
};

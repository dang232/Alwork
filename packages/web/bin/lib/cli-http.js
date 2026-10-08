import { buildLocalUrl } from './cli-network.js';
import { readDesktopLocalClientTokenFromSettings, readDesktopLocalPortFromSettings } from './cli-paths.js';

function getDesktopLocalAuthHeader(port, requestHeaders) {
  if (requestHeaders.Authorization || requestHeaders.authorization) {
    return null;
  }
  const desktopPort = readDesktopLocalPortFromSettings();
  if (desktopPort !== port) {
    return null;
  }
  const token = readDesktopLocalClientTokenFromSettings();
  return token ? `Bearer ${token}` : null;
}

async function requestServerShutdown(port, hostOverride) {
  if (!Number.isFinite(port) || port <= 0) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const resp = await fetch(buildLocalUrl(port, '/api/system/shutdown', hostOverride), {
      method: 'POST',
      signal: controller.signal,
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(port, endpoint, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.trunc(options.timeoutMs)
    : 4000;
  const fetchOptions = { ...options };
  delete fetchOptions.timeoutMs;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestUrl = buildLocalUrl(port, endpoint);
    const requestHeaders = {
      Accept: 'application/json',
      ...(fetchOptions.body ? { 'Content-Type': 'application/json' } : {}),
      ...(fetchOptions.headers || {}),
    };
    const desktopAuth = getDesktopLocalAuthHeader(port, requestHeaders);
    if (desktopAuth) {
      requestHeaders.Authorization = desktopAuth;
    }
    const response = await fetch(requestUrl, {
      ...fetchOptions,
      headers: requestHeaders,
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return { response, body };
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
      throw new Error(`Request to ${endpoint} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function isServerHealthReady(port, timeoutMs = 1000) {
  if (!Number.isFinite(port) || port <= 0) {
    return false;
  }
  const requestTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : 1000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeout);
  try {
    const response = await fetch(buildLocalUrl(port, '/health'), {
      headers: { Accept: 'text/plain' },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServerHealth(port, {
  timeoutMs = 60000,
  intervalMs = 250,
  onTick,
} = {}) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    const elapsedMs = Date.now() - start;
    if (typeof onTick === 'function') {
      onTick({ elapsedMs, timeoutMs });
    }
    if (await isServerHealthReady(port, Math.min(1000, intervalMs * 2))) {
      if (typeof onTick === 'function') {
        onTick({ elapsedMs: Math.min(Date.now() - start, timeoutMs), timeoutMs, complete: true });
      }
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (typeof onTick === 'function') {
    onTick({ elapsedMs: timeoutMs, timeoutMs, timedOut: true });
  }
  return false;
}


async function fetchTunnelProvidersFromPort(port, fetchImpl = globalThis.fetch) {
  if (!Number.isFinite(port) || port <= 0 || typeof fetchImpl !== 'function') {
    return null;
  }
  try {
    const response = await fetchImpl(buildLocalUrl(port, '/api/openchamber/tunnel/providers'));
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    if (!body || !Array.isArray(body.providers)) return null;
    return body.providers;
  } catch {
    return null;
  }
}

async function fetchSystemInfoFromPort(port, fetchImpl = globalThis.fetch, hostOverride) {
  if (!Number.isFinite(port) || port <= 0 || typeof fetchImpl !== 'function') {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetchImpl(buildLocalUrl(port, '/api/system/info', hostOverride), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    if (!body || typeof body.runtime !== 'string') return null;

    return {
      runtime: body.runtime,
      pid: Number.isFinite(body.pid) ? body.pid : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}


export {
  requestServerShutdown,
  requestJson,
  isServerHealthReady,
  waitForServerHealth,
  fetchTunnelProvidersFromPort,
  fetchSystemInfoFromPort,
};

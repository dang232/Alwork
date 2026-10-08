// DAG pane local service entry (project-ide todo 13).
//
// Host-spawned with the app runtime: binds 127.0.0.1 on
// OPENCHAMBER_SERVICE_PORT, checks `Authorization: Bearer
// OPENCHAMBER_SERVICE_TOKEN` on every request including /health, and proxies
// the guest's serviceRequest calls onto `createDagServiceHandlers` (which
// owns the adapter-A bridge). Listens on loopback only, never 0.0.0.0.
// Shipped built (plain Node JS); the host never compiles TypeScript.
import http from 'node:http';

import { createDagServiceHandlers, DAG_SERVICE_MAX_BODY_BYTES } from './handlers.js';

const port = Number.parseInt(process.env.OPENCHAMBER_SERVICE_PORT ?? '', 10);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('omo-dag-pane service: OPENCHAMBER_SERVICE_PORT is missing or invalid.');
  process.exit(1);
}
if (token.length === 0) {
  console.error('omo-dag-pane service: OPENCHAMBER_SERVICE_TOKEN is missing.');
  process.exit(1);
}

const { handleRequest } = createDagServiceHandlers();

const readBody = (request) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > DAG_SERVICE_MAX_BODY_BYTES) {
      reject(new Error('body_too_large'));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  request.on('error', reject);
});

const server = http.createServer(async (request, response) => {
  try {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, code: 'OMO_DAG_UNAUTHORIZED' }));
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    let body = {};
    if (request.method === 'POST') {
      const text = await readBody(request);
      if (text.trim().length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: false, code: 'DAG_SERVICE_BODY_MALFORMED' }));
          return;
        }
      }
    }
    const answer = await handleRequest({
      method: request.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
    });
    response.writeHead(answer.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer.body));
  } catch {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, code: 'OMO_DAG_SERVICE_FAILED' }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`omo-dag-pane service ready on 127.0.0.1:${port}`);
});

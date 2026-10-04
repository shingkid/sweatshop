import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore, ControlConflict, canonicalJson } from './control-store.mjs';

const digest = value => createHash('sha256').update(value).digest();
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const fields = (value, keys) => {
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(400, 'Unexpected request fields');
};

async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') fail(415, 'Expected application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) fail(413, 'Request body exceeds 64 KiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'Invalid JSON body'); }
}

function credentialsFor(credentials, contracts) {
  if (!Array.isArray(credentials) || !credentials.length) throw new Error('Scoped credentials are required');
  const projects = new Set(contracts.map(contract => contract.projectId));
  const seen = new Set();
  return credentials.map(({ token, role, projectId }) => {
    if (typeof token !== 'string' || token.length < 32 || /\s/.test(token) ||
        !['coordinator', 'supervisor'].includes(role) || !projects.has(projectId) || seen.has(token)) {
      throw new Error('Invalid or reused control credential');
    }
    seen.add(token);
    return { hash: digest(token), role, projectId };
  });
}

/** A single authority over one durable SQLite file. No cloud dispatch or publisher is exposed. */
export function createControlApi({ databasePath, contracts, credentials, clock }) {
  const access = credentialsFor(credentials, contracts);
  const store = new ControlStore({ databasePath, contracts, clock });
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, body) => { response.writeHead(status); response.end(JSON.stringify(body) + '\n'); };
    try {
      if (request.headers.origin) fail(403, 'Browser-origin requests are not supported');
      if (request.method === 'GET' && request.url === '/health') return send(200, { status: 'ready', protocol: 1 });
      const match = request.url?.match(/^\/v1\/projects\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/(reservations|attempts\/([0-9a-f-]{36})\/(unknown|register|finish)))?$/);
      if (!match) fail(404, 'Unknown control route');
      const projectId = match[1], action = match[4] ?? match[2] ?? 'status';
      const bearer = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
      if (!bearer) fail(401, 'Control credential required');
      const supplied = digest(bearer);
      const credential = access.find(item => timingSafeEqual(supplied, item.hash));
      if (!credential) fail(401, 'Invalid control credential');
      if (credential.projectId !== projectId) fail(403, 'Credential cannot access this project');
      if (request.method === 'GET' && action === 'status') return send(200, store.status(projectId));
      if (request.method !== 'POST' || action === 'status') fail(405, 'Unsupported method');
      const role = ['reservations', 'unknown'].includes(action) ? 'coordinator' : 'supervisor';
      if (credential.role !== role) fail(403, 'Credential cannot perform this action');
      const body = await readBody(request);
      let result;
      if (action === 'reservations') {
        fields(body, ['contractId', 'operationId', 'executor']);
        result = store.reserve({ ...body, projectId });
      } else {
        const binding = { ...body, projectId, attemptId: match[3] };
        if (action === 'unknown') {
          fields(body, ['contractId', 'generation']);
          result = store.markUnknown(binding);
        } else if (action === 'register') {
          fields(body, ['contractId', 'generation', 'nativeTaskId', 'runnerId', 'observed']);
          fields(body.observed, ['baselineSha', 'controllerSha', 'acceptanceSha', 'allowedFiles']);
          const contract = store.status(projectId).contract;
          for (const key of ['baselineSha', 'controllerSha', 'acceptanceSha', 'allowedFiles']) {
            if (canonicalJson(body.observed[key]) !== canonicalJson(contract[key])) fail(409, 'Observed ' + key + ' differs from the contract');
          }
          result = store.register(binding);
        } else {
          fields(body, ['contractId', 'generation', 'nativeTaskId', 'runnerId', 'outcome', 'evidence', 'stopped']);
          result = store.finish(binding);
        }
      }
      send(200, result);
    } catch (error) {
      // Store conflicts describe the contract or transition, never request credentials.
      const status = error.status ?? (error instanceof ControlConflict ? 409 : 500);
      send(status, { error: status === 500 ? 'Control service failed; reconcile before another submission' : error.message });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 64;
  return {
    server,
    async listen({ host = '127.0.0.1', port = 0 } = {}) {
      await new Promise((yes, no) => { server.once('error', no); server.listen(port, host, yes); });
      const address = server.address();
      return 'http://' + (address.family === 'IPv6' ? '[' + address.address + ']' : address.address) + ':' + address.port;
    },
    async close() {
      if (server.listening) await new Promise((yes, no) => server.close(error => error ? no(error) : yes()));
      store.close();
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--config') throw new Error('Usage: control-api.mjs --config FILE');
  const config = JSON.parse(readFileSync(args[1], 'utf8'));
  const credentials = config.credentials.map(item => ({ ...item, token: process.env[item.tokenEnv] }));
  const api = createControlApi({ databasePath: config.databasePath, contracts: config.contracts, credentials });
  const url = await api.listen({ host: config.host ?? '127.0.0.1', port: config.port ?? 8787 });
  console.log(JSON.stringify({ status: 'listening', url, protocol: 1 }));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await api.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

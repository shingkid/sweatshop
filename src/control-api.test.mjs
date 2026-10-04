import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createControlApi } from './control-api.mjs';
import { createControlClient } from './control-client.mjs';

const contract = { projectId: 'smoke', contractId: 'no-op-v1', baselineSha: 'a'.repeat(40), controllerSha: 'b'.repeat(40), acceptanceSha: 'c'.repeat(64), allowedFiles: ['noop.txt'], maxAttempts: 2, maxDurationMs: 1800000 };
const observed = { baselineSha: contract.baselineSha, controllerSha: contract.controllerSha, acceptanceSha: contract.acceptanceSha, allowedFiles: contract.allowedFiles };
const errorStatus = status => error => error.status === status && error.outcomeUnknown === false;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sweatshop-api-'));
  const coordinatorToken = randomBytes(32).toString('hex'), supervisorToken = randomBytes(32).toString('hex');
  const options = { databasePath: join(directory, 'control.sqlite'), contracts: [contract], credentials: [
    { projectId: 'smoke', role: 'coordinator', token: coordinatorToken },
    { projectId: 'smoke', role: 'supervisor', token: supervisorToken },
  ] };
  let api = createControlApi(options);
  t.after(async () => { await api.close(); await rm(directory, { recursive: true, force: true }); });
  const url = await api.listen();
  const coordinator = createControlClient({ url, token: coordinatorToken, projectId: 'smoke' });
  const supervisor = createControlClient({ url, token: supervisorToken, projectId: 'smoke' });
  const restart = async () => {
    await api.close();
    api = createControlApi(options);
    const url = await api.listen();
    return {
      coordinator: createControlClient({ url, token: coordinatorToken, projectId: 'smoke' }),
      supervisor: createControlClient({ url, token: supervisorToken, projectId: 'smoke' }),
    };
  };
  return { url, coordinatorToken, supervisorToken, coordinator, supervisor, restart };
}

const reserve = coordinator => coordinator.reserve({ contractId: contract.contractId, operationId: 'first', executor: 'cloud' });
const registration = { nativeTaskId: 'native-1', runnerId: 'runner-1', observed };
const completion = { nativeTaskId: 'native-1', runnerId: 'runner-1', outcome: 'complete', stopped: true,
  evidence: { ...observed, candidateSha: contract.baselineSha, kind: 'no-op', productVerified: false } };

test('HTTP roles separate reservation, admission, and reporting', async t => {
  const { coordinator, supervisor } = await fixture(t);
  await assert.rejects(reserve(supervisor), errorStatus(403));
  const attempt = await reserve(coordinator);
  assert.equal(attempt.maySubmit, true);
  assert.equal((await reserve(coordinator)).maySubmit, false);
  await assert.rejects(coordinator.register(attempt, registration), errorStatus(403));
  assert.equal((await supervisor.register(attempt, registration)).mayExecute, true);
  assert.equal((await supervisor.register(attempt, registration)).mayExecute, false);
  await assert.rejects(coordinator.finish(attempt, completion), errorStatus(403));
  assert.equal((await supervisor.finish(attempt, completion)).state, 'complete');
  assert.equal((await coordinator.status()).currentAttempt.mayExecute, false);
  await assert.rejects(coordinator.reserve({ contractId: contract.contractId, operationId: 'second', executor: 'local' }), errorStatus(409));
});

test('unknown submission blocks replacement and only matching admission can resolve it', async t => {
  const { coordinator, supervisor } = await fixture(t);
  const attempt = await reserve(coordinator);
  await coordinator.markUnknown(attempt);
  await assert.rejects(coordinator.reserve({ contractId: contract.contractId, operationId: 'second', executor: 'local' }), errorStatus(409));
  await assert.rejects(supervisor.register(attempt, { ...registration, observed: { ...observed, controllerSha: 'd'.repeat(40) } }), errorStatus(409));
  assert.equal((await coordinator.status()).currentAttempt.state, 'unknown');
  assert.equal((await supervisor.register(attempt, registration)).mayExecute, true);
  await assert.rejects(supervisor.register(attempt, { ...registration, runnerId: 'duplicate-process' }), errorStatus(409));
  await assert.rejects(supervisor.register(attempt, { ...registration, nativeTaskId: 'different-task' }), errorStatus(409));
});

test('credentials, cross-project requests, field overrides, and browser requests fail closed', async t => {
  const { url, coordinatorToken, coordinator } = await fixture(t);
  const wrong = createControlClient({ url, token: 'x'.repeat(64), projectId: 'smoke' });
  await assert.rejects(wrong.status(), errorStatus(401));
  const other = createControlClient({ url, token: coordinatorToken, projectId: 'other' });
  await assert.rejects(other.status(), errorStatus(403));
  await assert.rejects(coordinator.reserve({ contractId: contract.contractId, operationId: 'first', executor: 'cloud', maxAttempts: 99 }), errorStatus(400));
  const response = await fetch(url + '/v1/projects/smoke', { headers: { Authorization: 'Bearer ' + coordinatorToken, Origin: 'https://example.com' } });
  assert.equal(response.status, 403);
  assert.equal((await coordinator.status()).attempts.length, 0);
});

test('lost HTTP acknowledgement does not cause a client retry or second reservation', async t => {
  const { url, coordinatorToken, coordinator } = await fixture(t);
  let writes = 0;
  const proxy = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    writes++;
    const upstream = await fetch(url + request.url, { method: request.method, headers: { Authorization: request.headers.authorization, 'Content-Type': 'application/json' }, body: Buffer.concat(chunks) });
    await upstream.arrayBuffer();
    response.destroy();
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const client = createControlClient({ url: 'http://127.0.0.1:' + proxy.address().port, token: coordinatorToken, projectId: 'smoke' });
  await assert.rejects(reserve(client), error => error.outcomeUnknown === true);
  assert.equal(writes, 1);
  const replay = await reserve(coordinator);
  assert.equal(replay.maySubmit, false);
  assert.equal((await coordinator.status()).attempts.length, 1);
});

test('client rejects insecure remote origins and embedded credentials', () => {
  const options = { token: 'x'.repeat(64), projectId: 'smoke' };
  assert.throws(() => createControlClient({ ...options, url: 'http://example.com' }), /HTTPS/);
  assert.throws(() => createControlClient({ ...options, url: 'https://name:secret@example.com' }), /HTTPS/);
});

test('lost registration response remains non-executable after service restart', async t => {
  const { url, coordinator, supervisorToken, restart } = await fixture(t);
  const attempt = await reserve(coordinator);
  let registrations = 0;
  const proxy = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    registrations++;
    const upstream = await fetch(url + request.url, {
      method: request.method,
      headers: { Authorization: request.headers.authorization, 'Content-Type': 'application/json' },
      body: Buffer.concat(chunks),
    });
    await upstream.arrayBuffer();
    response.destroy();
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const supervisor = createControlClient({ url: 'http://127.0.0.1:' + proxy.address().port, token: supervisorToken, projectId: 'smoke' });
  await assert.rejects(supervisor.register(attempt, registration), error => error.outcomeUnknown === true);
  assert.equal(registrations, 1);
  const resumed = await restart();
  assert.equal((await resumed.supervisor.register(attempt, registration)).mayExecute, false);
  assert.equal((await resumed.coordinator.status()).currentAttempt.state, 'registered');
  await assert.rejects(resumed.coordinator.reserve({ contractId: contract.contractId, operationId: 'replacement', executor: 'local' }), errorStatus(409));
});

test('command reads closed JSON input and preserves one-time submission permission', async t => {
  const { url, coordinatorToken } = await fixture(t);
  const command = (action, body) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./control-command.mjs', import.meta.url)), action], {
      env: { ...process.env, SWEATSHOP_CONTROL_URL: url, SWEATSHOP_PROJECT: 'smoke', SWEATSHOP_CONTROL_TOKEN: coordinatorToken },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(body === undefined ? '' : JSON.stringify(body));
  });
  const body = { contractId: contract.contractId, operationId: 'command-first', executor: 'cloud' };
  const first = await command('reserve', body);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).maySubmit, true);
  const second = await command('reserve', body);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).maySubmit, false);
  const status = await command('status');
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).attempts.length, 1);
  const invalid = await command('reserve', {});
  assert.equal(invalid.code, 1);
  assert.equal(JSON.parse(invalid.stderr).outcomeUnknown, false);
  assert.ok(![first, second, status, invalid].some(result => (result.stdout + result.stderr).includes(coordinatorToken)));
});

test('redirects and service errors make mutation outcomes unknown without retries', async t => {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++;
    response.writeHead(requests === 1 ? 307 : 500, { 'Content-Type': 'application/json', Location: '/redirected' });
    response.end(JSON.stringify({ error: 'unavailable' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = createControlClient({ url: 'http://127.0.0.1:' + server.address().port, projectId: 'smoke', token: 't'.repeat(64) });
  await assert.rejects(reserve(client), error => error.status === 307 && error.outcomeUnknown);
  assert.equal(requests, 1);
  await assert.rejects(reserve(client), error => error.status === 500 && error.outcomeUnknown);
  assert.equal(requests, 2);
});

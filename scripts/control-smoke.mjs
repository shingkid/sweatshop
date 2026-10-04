#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createControlApi } from '../src/control-api.mjs';
import { createControlClient } from '../src/control-client.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: control-smoke.mjs [--output NEW_DIRECTORY]');
const directory = args.length ? resolve(args[1]) : await mkdtemp(join(tmpdir(), 'sweatshop-control-smoke-'));
if (args.length) await mkdir(directory, { recursive: false, mode: 0o700 });
const contract = { projectId: 'smoke', contractId: 'protocol-smoke-v1', baselineSha: '1'.repeat(40), controllerSha: '2'.repeat(40),
  acceptanceSha: createHash('sha256').update('sweatshop protocol smoke v1').digest('hex'), allowedFiles: ['noop.txt'], maxAttempts: 2 };
const observed = { baselineSha: contract.baselineSha, controllerSha: contract.controllerSha, acceptanceSha: contract.acceptanceSha, allowedFiles: contract.allowedFiles };
const tokens = { coordinator: randomBytes(32).toString('hex'), supervisor: randomBytes(32).toString('hex') };
const options = { databasePath: join(directory, 'control.sqlite'), contracts: [contract], credentials: Object.entries(tokens).map(([role, token]) => ({ role, token, projectId: 'smoke' })) };
const evidence = { kind: 'local-protocol-smoke', syntheticRevisions: true, productVerified: false, checks: [] };
let api;
try {
  api = createControlApi(options);
  let url = await api.listen();
  let coordinator = createControlClient({ url, projectId: 'smoke', token: tokens.coordinator });
  let supervisor = createControlClient({ url, projectId: 'smoke', token: tokens.supervisor });
  const request = { contractId: contract.contractId, operationId: 'simulated-lost-response', executor: 'cloud' };
  const attempt = await coordinator.reserve(request);
  assert.equal(attempt.maySubmit, true);
  await coordinator.markUnknown(attempt);
  await assert.rejects(coordinator.reserve({ ...request, operationId: 'replacement', executor: 'local' }), error => error.status === 409);
  evidence.checks.push('unknown submission blocks replacement');
  await api.close();
  api = null;
  api = createControlApi(options);
  url = await api.listen();
  coordinator = createControlClient({ url, projectId: 'smoke', token: tokens.coordinator });
  supervisor = createControlClient({ url, projectId: 'smoke', token: tokens.supervisor });
  assert.equal((await coordinator.reserve(request)).maySubmit, false);
  assert.equal((await coordinator.status()).currentAttempt.state, 'unknown');
  evidence.checks.push('restart retains reservation without submission permission');
  const runner = { nativeTaskId: 'synthetic-task-1', runnerId: 'synthetic-runner-1', observed };
  assert.equal((await supervisor.register(attempt, runner)).mayExecute, true);
  assert.equal((await supervisor.register(attempt, runner)).mayExecute, false);
  await assert.rejects(supervisor.register(attempt, { ...runner, runnerId: 'duplicate-runner' }), error => error.status === 409);
  evidence.checks.push('one-time execution admission and duplicate rejection');
  await supervisor.finish(attempt, { nativeTaskId: runner.nativeTaskId, runnerId: runner.runnerId, outcome: 'failed', stopped: true,
    evidence: { ...observed, candidateSha: contract.baselineSha, kind: 'simulated-no-op-failure' } });
  const second = await coordinator.reserve({ ...request, operationId: 'local-retry', executor: 'local' });
  assert.equal(second.generation, 2);
  await assert.rejects(supervisor.finish(attempt, { nativeTaskId: runner.nativeTaskId, runnerId: runner.runnerId, outcome: 'complete', stopped: true,
    evidence: { ...observed, candidateSha: contract.baselineSha, kind: 'late-result' } }), error => error.status === 409);
  evidence.checks.push('local retry shares the allowance and rejects obsolete results');
  const localRunner = { nativeTaskId: 'synthetic-task-2', runnerId: 'synthetic-runner-2', observed };
  assert.equal((await supervisor.register(second, localRunner)).mayExecute, true);
  await supervisor.finish(second, { nativeTaskId: localRunner.nativeTaskId, runnerId: localRunner.runnerId, outcome: 'failed', stopped: true,
    evidence: { ...observed, candidateSha: contract.baselineSha, kind: 'simulated-no-op-failure' } });
  await assert.rejects(coordinator.reserve({ ...request, operationId: 'third' }), error => error.status === 409);
  evidence.checks.push('two-attempt allowance cannot reset');
  evidence.finalState = await coordinator.status();
  evidence.status = 'passed';
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: 'passed', scope: 'local protocol only', checks: evidence.checks, evidencePath: join(directory, 'evidence.json') }));
} finally {
  if (api) await api.close();
}

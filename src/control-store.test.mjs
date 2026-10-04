import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { ControlStore } from './control-store.mjs';

const contract = {
  projectId: 'demo', contractId: 'approved-goal', baselineSha: 'a'.repeat(40),
  controllerSha: 'b'.repeat(40), acceptanceSha: 'c'.repeat(64),
  allowedFiles: ['src/example.mjs'], maxAttempts: 2, maxDurationMs: 1000,
};
function fixture(t, contracts = [contract]) {
  const directory = mkdtempSync(join(tmpdir(), 'control-store-'));
  const databasePath = join(directory, 'state.sqlite');
  let now = 100;
  const stores = [];
  const open = () => {
    const store = new ControlStore({ databasePath, contracts, clock: () => now });
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) { try { store.close(); } catch {} }
    rmSync(directory, { recursive: true, force: true });
  });
  return { open, databasePath, setTime: value => { now = value; } };
}
const reserve = (store, overrides = {}) => store.reserve({ projectId: contract.projectId, contractId: contract.contractId, operationId: 'op-one', executor: 'cloud', ...overrides });
const register = (store, attempt, overrides = {}) => store.register({ ...attempt, nativeTaskId: 'task-one', runnerId: 'runner-one', ...overrides });
const evidence = (overrides = {}) => ({ baselineSha: contract.baselineSha, controllerSha: contract.controllerSha, acceptanceSha: contract.acceptanceSha, candidateSha: 'd'.repeat(40), allowedFiles: contract.allowedFiles, checks: [{ name: 'unit', exitCode: 0 }], ...overrides });
const finish = (store, attempt, overrides = {}) => store.finish({ ...attempt, outcome: 'complete', stopped: true, evidence: evidence(), ...overrides });

test('reservation retries bind the operation to project, contract and executor', t => {
  const f = fixture(t); const store = f.open();
  const attempt = reserve(store);
  assert.equal(attempt.maySubmit, true);
  assert.deepEqual(reserve(store), { ...attempt, maySubmit: false });
  assert.equal('maySubmit' in store.status('demo').currentAttempt, false);
  assert.equal(store.status('demo').attempts.length, 1);
  assert.throws(() => reserve(store, { executor: 'local' }), /Operation identity/);
  assert.throws(() => reserve(store, { contractId: 'different' }), /Contract identity/);
  assert.throws(() => reserve(store, { operationId: 'different' }), /blocks/);
});

test('lost response and unknown submission retain the same reservation without timeout takeover', t => {
  const f = fixture(t); const store = f.open();
  const attempt = reserve(store);
  store.markUnknown(attempt);
  f.setTime(999999);
  assert.equal(reserve(store).state, 'unknown');
  assert.throws(() => reserve(store, { operationId: 'replacement', executor: 'local' }), /blocks/);
  assert.equal(register(store, attempt).mayExecute, true);
  assert.equal(store.markUnknown(attempt).state, 'registered');
});

test('registration admits exactly once and binds native task and runner', t => {
  const f = fixture(t); const store = f.open(); const attempt = reserve(store);
  const registered = register(store, attempt);
  assert.equal(registered.mayExecute, true);
  assert.equal(register(store, attempt).mayExecute, false);
  assert.equal(store.status('demo').currentAttempt.mayExecute, false);
  assert.throws(() => register(store, attempt, { nativeTaskId: 'other-task' }), /different/);
  assert.throws(() => register(store, attempt, { runnerId: 'other-process' }), /different/);
});

test('stopped failure allows one host switch, then the shared attempt budget blocks work', t => {
  const f = fixture(t); const store = f.open();
  const first = register(store, reserve(store));
  assert.throws(() => finish(store, first, { outcome: 'failed', stopped: false }), /stopped/);
  finish(store, first, { outcome: 'failed' });
  const second = register(store, reserve(store, { operationId: 'op-two', executor: 'local' }), { nativeTaskId: 'task-two', runnerId: 'runner-two' });
  assert.equal(second.generation, 2);
  assert.throws(() => finish(store, first, { outcome: 'failed' }), /Stale/);
  assert.throws(() => store.markUnknown(first), /Stale/);
  assert.throws(() => register(store, first), /Stale/);
  finish(store, second, { outcome: 'failed' });
  assert.throws(() => reserve(store, { operationId: 'op-three' }), /limit/);
});

test('restart preserves the unknown reservation, immutable contract and shared timer', t => {
  const f = fixture(t); const firstStore = f.open();
  const attempt = reserve(firstStore); firstStore.markUnknown(attempt);
  firstStore.close();
  const secondStore = f.open();
  assert.equal(secondStore.status('demo').currentAttempt.state, 'unknown');
  assert.equal(reserve(secondStore).maySubmit, false);
  assert.equal('maySubmit' in secondStore.status('demo').currentAttempt, false);
  const registered = register(secondStore, attempt);
  f.setTime(1100);
  const thirdStore = f.open();
  assert.equal(thirdStore.status('demo').startedAt, 100);
  assert.equal(thirdStore.status('demo').expired, true);
  assert.equal(register(thirdStore, registered).mayExecute, false);
  assert.throws(() => new ControlStore({ databasePath: f.databasePath, contracts: [{ ...contract, controllerSha: 'e'.repeat(40) }] }), /immutable/);
});

test('project and native identities cannot be reused across contracts', t => {
  const other = { ...contract, projectId: 'other', contractId: 'other-goal' };
  const f = fixture(t, [contract, other]); const store = f.open();
  const first = register(store, reserve(store));
  assert.throws(() => reserve(store, { projectId: 'other', contractId: 'other-goal' }), /Operation identity/);
  const second = reserve(store, { projectId: 'other', contractId: 'other-goal', operationId: 'other-op' });
  assert.throws(() => register(store, second), /UNIQUE/);
  assert.throws(() => finish(store, { ...first, projectId: 'other', contractId: 'other-goal' }), /Stale/);
  assert.throws(() => store.markUnknown({ ...first, contractId: 'other-goal' }), /Contract/);
  assert.throws(() => reserve(store, { projectId: 'unconfigured' }), /configured/);
});

test('duration starts on admission and cannot reset after host switch', t => {
  const f = fixture(t); const store = f.open(); const attempt = reserve(store);
  f.setTime(5000);
  assert.equal(store.status('demo').startedAt, null);
  const first = register(store, attempt);
  assert.equal(store.status('demo').deadlineAt, 6000);
  finish(store, first, { outcome: 'failed' });
  f.setTime(5900);
  const second = register(store, reserve(store, { operationId: 'second', executor: 'local' }), { nativeTaskId: 'second', runnerId: 'second' });
  assert.equal(store.status('demo').deadlineAt, 6000);
  f.setTime(6000);
  const completed = finish(store, second);
  assert.equal(completed.state, 'complete');
  assert.deepEqual(completed.evidence, evidence());
  assert.equal(store.status('demo').expired, true);
  assert.equal(register(store, second, { nativeTaskId: 'second', runnerId: 'second' }).mayExecute, false);
});

test('elapsed scheduling deadline blocks a new attempt after a stopped failure', t => {
  const f = fixture(t); const store = f.open();
  const first = register(store, reserve(store));
  f.setTime(1100);
  finish(store, first, { outcome: 'failed' });
  assert.throws(() => reserve(store, { operationId: 'second' }), /deadline/);
});

test('expired absolute deadline permits reconciliation without admission', t => {
  const f = fixture(t, [{ ...contract, deadlineAt: 200 }]); const store = f.open();
  const attempt = reserve(store); store.markUnknown(attempt); f.setTime(200);
  const registered = register(store, attempt);
  assert.equal(registered.mayExecute, false);
  assert.equal(registered.admitted, false);
  assert.equal(store.status('demo').startedAt, null);
  assert.throws(() => finish(store, registered), /deadline/);
  finish(store, registered, { outcome: 'failed' });
  assert.throws(() => reserve(store, { operationId: 'replacement' }), /deadline/);
});

test('results require exact generation, task, runner, pins and allowed files', t => {
  const f = fixture(t); const store = f.open(); const attempt = register(store, reserve(store));
  for (const change of [{ generation: 2 }, { attemptId: 'wrong' }, { nativeTaskId: 'wrong' }, { runnerId: 'wrong' }]) assert.throws(() => finish(store, attempt, change));
  for (const key of ['baselineSha', 'controllerSha', 'acceptanceSha']) assert.throws(() => finish(store, attempt, { evidence: evidence({ [key]: 'e'.repeat(40) }) }), /mismatch/);
  assert.throws(() => finish(store, attempt, { evidence: evidence({ allowedFiles: ['src/other.mjs'] }) }), /mismatch/);
  assert.throws(() => finish(store, attempt, { evidence: evidence({ candidateSha: 'branch-name' }) }), /mismatch/);
  assert.throws(() => finish(store, attempt, { evidence: evidence({ checks: undefined }) }), /finite JSON/);
  assert.equal(store.status('demo').currentAttempt.state, 'registered');
});

test('terminal retries accept only the same complete evidence', t => {
  const f = fixture(t); const store = f.open(); const attempt = register(store, reserve(store));
  const completed = finish(store, attempt);
  f.setTime(999999);
  assert.deepEqual(finish(store, attempt), completed);
  assert.throws(() => finish(store, attempt, { evidence: evidence({ checks: [] }) }), /differs/);
  assert.throws(() => finish(store, attempt, { outcome: 'failed' }), /differs/);
  assert.throws(() => reserve(store, { operationId: 'next' }), /blocks/);
  assert.equal(store.markUnknown(attempt).state, 'complete');
});

test('invalid contract configuration fails before accepting reservations', t => {
  const f = fixture(t);
  for (const change of [{ allowedFiles: ['src/'] }, { allowedFiles: ['../x'] }, { allowedFiles: ['.git/config'] }, { maxAttempts: 3 }, { maxDurationMs: 0 }, { baselineSha: 'main' }, { acceptanceSha: 'c'.repeat(40) }]) {
    assert.throws(() => new ControlStore({ databasePath: f.databasePath, contracts: [{ ...contract, ...change }] }));
  }
});

async function race(databasePath, operations, method = 'reserve') {
  const barrier = new SharedArrayBuffer(4);
  const workers = operations.map(operationId => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { ControlStore } = await import(workerData.module);
      const store = new ControlStore({ databasePath: workerData.databasePath, contracts: [workerData.contract] });
      parentPort.postMessage({ ready: true });
      Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      try {
        const args = workerData.method === 'reserve'
          ? { projectId: 'demo', contractId: 'approved-goal', operationId: workerData.operationId, executor: 'cloud' }
          : workerData.operationId;
        parentPort.postMessage({ attempt: store[workerData.method](args) });
      }
      catch (error) { parentPort.postMessage({ error: error.message }); }
      finally { store.close(); }
    })();`, { eval: true, workerData: { databasePath, operationId, method, contract, barrier, module: new URL('./control-store.mjs', import.meta.url).href } }));
  const results = workers.map(worker => new Promise((resolve, reject) => { worker.on('message', message => { if (!message.ready) resolve(message); }); worker.on('error', reject); }));
  await Promise.all(workers.map(worker => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); })));
  Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
  return Promise.all(results);
}

test('concurrent SQLite connections cannot reserve two active attempts', async t => {
  const f = fixture(t); f.open();
  const results = await race(f.databasePath, ['first', 'second']);
  assert.equal(results.filter(result => result.attempt).length, 1);
  assert.match(results.find(result => result.error).error, /blocks/);
  assert.equal(f.open().status('demo').attempts.length, 1);
});

test('concurrent identical reservations return the same durable attempt', async t => {
  const f = fixture(t); f.open();
  const results = await race(f.databasePath, ['same', 'same']);
  assert.ok(results.every(result => result.attempt));
  assert.equal(results[0].attempt.attemptId, results[1].attempt.attemptId);
  assert.equal(results.filter(result => result.attempt.maySubmit).length, 1);
  assert.equal(f.open().status('demo').attempts.length, 1);
});


test('concurrent registration retries admit execution only once', async t => {
  const f = fixture(t); const store = f.open();
  const binding = { ...reserve(store), nativeTaskId: 'native-task', runnerId: 'same-runner' };
  const results = await race(f.databasePath, [binding, binding], 'register');
  assert.ok(results.every(result => result.attempt));
  assert.equal(results.filter(result => result.attempt.mayExecute).length, 1);
  assert.equal(results[0].attempt.attemptId, results[1].attempt.attemptId);
  const saved = store.status('demo').currentAttempt;
  assert.equal(saved.nativeTaskId, binding.nativeTaskId);
  assert.equal(saved.runnerId, binding.runnerId);
  assert.equal(saved.mayExecute, false);
});

test('concurrent different runners cannot both register one attempt', async t => {
  const f = fixture(t); const store = f.open();
  const binding = { ...reserve(store), nativeTaskId: 'native-task', runnerId: 'first-runner' };
  const results = await race(f.databasePath, [binding, { ...binding, runnerId: 'second-runner' }], 'register');
  const admitted = results.filter(result => result.attempt?.mayExecute);
  assert.equal(admitted.length, 1);
  assert.match(results.find(result => result.error).error, /different native task or runner/);
  assert.equal(store.status('demo').currentAttempt.runnerId, admitted[0].attempt.runnerId);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { runTask, taskFingerprint } from './engine.mjs';

const BASE = 'a'.repeat(40);
const COMMIT = 'b'.repeat(40);
const task = {
  id: 'simulation-1', issueNumber: 1, title: 'Simulation task', body: 'Approved simulation',
  baseSha: BASE, acceptancePath: 'acceptance.mjs', allowedPaths: ['src/'],
};
const publication = { url: 'https://github.com/example/simulation/pull/1', commit: COMMIT };

// These fake adapters test coordination only. They do not prove real worker or GitHub behavior.
function simulation(overrides = {}) {
  const calls = [];
  const snapshots = [];
  const methods = {
    prepare: async () => ({ workspace: '/simulation', baseSha: BASE }),
    work: async () => ({ workerEvidence: 'simulation worker output' }),
    recover: async () => {},
    verify: async () => ({ commit: COMMIT, evidence: 'simulation acceptance passed' }),
    publish: async () => publication,
    reconcile: async () => publication,
    ...overrides,
  };
  const adapter = Object.fromEntries(Object.entries(methods).map(([name, fn]) => [name, async (...args) => {
    calls.push(name);
    return fn(...args);
  }]));
  return {
    calls, snapshots, adapter,
    save: async state => { snapshots.push(structuredClone(state)); },
    get state() { return snapshots.at(-1); },
  };
}

test('simulation: success persists attempt before worker and verifies before publishing', async () => {
  const sim = simulation({ work: async (_, state) => {
    assert.equal(sim.state.stage, 'working');
    assert.equal(sim.state.attempt, 1);
    assert.equal(state.attempt, 1);
    return { workerEvidence: 'worker says done' };
  } });
  const result = await runTask({ task, ...sim });
  assert.equal(result.stage, 'complete');
  assert.deepEqual(sim.calls, ['prepare', 'work', 'verify', 'publish']);
  assert.deepEqual(result.publication, publication);
  assert.deepEqual(sim.snapshots.map(s => s.stage), ['pending', 'working', 'verifying', 'publishing', 'complete']);
});

test('simulation: crash at working checkpoint consumes attempt and recovers before retry', async () => {
  const sim = simulation();
  await assert.rejects(runTask({ task, adapter: sim.adapter, save: async state => {
    await sim.save(state);
    if (state.stage === 'working') throw new Error('simulated process crash');
  } }), /simulated process crash/);
  assert.deepEqual(sim.calls, ['prepare']);
  assert.equal(sim.state.attempt, 1);
  const result = await runTask({ task, ...sim, state: sim.state });
  assert.equal(result.stage, 'complete');
  assert.equal(result.attempt, 2);
  assert.deepEqual(sim.calls, ['prepare', 'recover', 'prepare', 'work', 'verify', 'publish']);
});

for (const phase of ['work', 'verify']) {
  test(`simulation: ${phase} failure repairs with bounded fresh work`, async () => {
    let failures = 0;
    const sim = simulation({ [phase]: async () => {
      if (failures++ === 0) throw new Error('repairable simulation failure');
      return phase === 'work' ? { workerEvidence: 'repaired' } : { commit: COMMIT, evidence: 'repaired' };
    } });
    const result = await runTask({ task, ...sim });
    assert.equal(result.stage, 'complete');
    assert.equal(result.attempt, 2);
    assert.ok(result.history.some(e => e.kind === `${phase}-failed`));
    assert.equal(sim.calls.filter(x => x === 'work').length, 2);
  });

  test(`simulation: repeated ${phase} failure exhausts two attempts`, async () => {
    const sim = simulation({ [phase]: async () => { throw new Error('persistent simulation failure'); } });
    const result = await runTask({ task, ...sim });
    assert.equal(result.stage, 'blocked');
    assert.equal(result.attempt, 2);
    assert.match(result.reason, /attempts exhausted/);
    assert.equal(sim.calls.filter(x => x === phase).length, 2);
    assert.ok(!sim.calls.includes('publish'));
  });
}

test('simulation: lost publication response reconciles successful remote write', async () => {
  const sim = simulation({ publish: async () => { throw new Error('response lost after remote write'); } });
  const result = await runTask({ task, ...sim });
  assert.equal(result.stage, 'complete');
  assert.equal(sim.calls.filter(x => x === 'publish').length, 1);
  assert.equal(sim.calls.at(-1), 'reconcile');
});

test('simulation: publishing restart reconciles without creating a duplicate', async () => {
  const sim = simulation();
  await assert.rejects(runTask({ task, adapter: sim.adapter, save: async state => {
    await sim.save(state);
    if (state.stage === 'publishing') throw new Error('simulated crash');
  } }));
  const resumed = simulation();
  const result = await runTask({ task, ...resumed, state: sim.state });
  assert.equal(result.stage, 'complete');
  assert.deepEqual(resumed.calls, ['reconcile']);
});

test('simulation: unknown publication blocks without retry', async () => {
  const sim = simulation({
    publish: async () => { throw new Error('unknown write'); },
    reconcile: async () => null,
  });
  const result = await runTask({ task, ...sim });
  assert.equal(result.stage, 'blocked');
  assert.match(result.reason, /outcome unknown/);
  assert.equal(sim.calls.filter(x => x === 'publish').length, 1);
});

for (const commit of [undefined, 'main', 'short']) {
  test(`simulation: verification rejects nonimmutable commit ${commit}`, async () => {
    const sim = simulation({ verify: async () => ({ commit, evidence: 'claims passed' }) });
    const result = await runTask({ task, ...sim });
    assert.equal(result.stage, 'blocked');
    assert.ok(!sim.calls.includes('publish'));
  });
}

test('simulation: mismatched published commit cannot complete', async () => {
  const wrong = { ...publication, commit: 'c'.repeat(40) };
  const sim = simulation({ publish: async () => wrong, reconcile: async () => wrong });
  const result = await runTask({ task, ...sim });
  assert.equal(result.stage, 'blocked');
  assert.match(result.reason, /does not match/);
});

test('simulation: missing publication URL cannot complete', async () => {
  const sim = simulation({ publish: async () => ({ commit: COMMIT }), reconcile: async () => ({ commit: COMMIT }) });
  const result = await runTask({ task, ...sim });
  assert.equal(result.stage, 'blocked');
  assert.match(result.reason, /URL/);
});

test('simulation: all contract fields affect fingerprint; object key order does not', () => {
  const original = taskFingerprint(task);
  assert.equal(taskFingerprint(Object.fromEntries(Object.entries(task).reverse())), original);
  for (const key of Object.keys(task)) {
    assert.notEqual(taskFingerprint({ ...task, [key]: `changed ${key}` }), original, key);
  }
});

test('simulation: changed contract or policy cannot resume', async () => {
  const sim = simulation();
  await runTask({ task, ...sim });
  for (const change of [{ task: { ...task, body: 'changed' } }, { limits: { maxAttempts: 3 } }, { limits: { policy: 'new' } }]) {
    const resumed = simulation();
    const result = await runTask({ task, ...resumed, state: sim.state, ...change });
    assert.equal(result.stage, 'blocked');
    assert.match(result.reason, /changed/);
    assert.deepEqual(resumed.calls, []);
  }
});

test('simulation: persisted duration prevents work after restart', async () => {
  let clock = 100;
  const limits = { now: () => clock, maxDurationMs: 50 };
  const sim = simulation();
  await assert.rejects(runTask({ task, adapter: sim.adapter, limits, save: async state => {
    await sim.save(state);
    throw new Error('simulated crash');
  } }));
  clock = 151;
  const result = await runTask({ task, ...sim, state: sim.state, limits });
  assert.equal(result.stage, 'blocked');
  assert.match(result.reason, /duration/);
  assert.deepEqual(sim.calls, []);
});

test('simulation: work overrunning duration is not published', async () => {
  let clock = 0;
  const sim = simulation({ work: async () => { clock = 51; return {}; } });
  const result = await runTask({ task, ...sim, limits: { now: () => clock, maxDurationMs: 50 } });
  assert.equal(result.stage, 'blocked');
  assert.deepEqual(sim.calls, ['prepare', 'work']);
});

test('simulation: preparation failure blocks before a worker launches', async () => {
  const sim = simulation({ prepare: async () => { throw new Error('unsafe workspace'); } });
  const result = await runTask({ task, ...sim });
  assert.equal(result.stage, 'blocked');
  assert.match(result.reason, /preparation failed/);
  assert.deepEqual(sim.calls, ['prepare']);
});

test('simulation: recovery failure blocks without starting a competing worker', async () => {
  const sim = simulation();
  await assert.rejects(runTask({ task, adapter: sim.adapter, save: async state => {
    await sim.save(state);
    if (state.stage === 'working') throw new Error('simulated crash');
  } }));
  const resumed = simulation({ recover: async () => { throw new Error('worker may still be alive'); } });
  const result = await runTask({ task, ...resumed, state: sim.state });
  assert.equal(result.stage, 'blocked');
  assert.match(result.reason, /recovery failed/);
  assert.deepEqual(resumed.calls, ['recover']);
});

test('simulation: verifying restart reruns independent verification', async () => {
  const sim = simulation();
  await assert.rejects(runTask({ task, adapter: sim.adapter, save: async state => {
    await sim.save(state);
    if (state.stage === 'verifying') throw new Error('simulated crash');
  } }));
  const resumed = simulation();
  const result = await runTask({ task, ...resumed, state: sim.state });
  assert.equal(result.stage, 'complete');
  assert.deepEqual(resumed.calls, ['verify', 'publish']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const wrapper = fileURLToPath(new URL('./watchdog.mjs', import.meta.url));
function launch(source, timeout = 2000, detached = true) {
  const child = spawn(process.execPath, [wrapper, String(timeout), String(process.pid), process.execPath, '-e', source],
    { detached, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  return { child, done: once(child, 'close'), output: () => stdout };
}
function liveMembers(group) {
  return execFileSync('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' }).trim().split('\n')
    .map(row => row.trim().split(/\s+/))
    .filter(([, pgid, status]) => Number(pgid) === group && !status.startsWith('Z'));
}
async function waitForEmpty(group) {
  for (let i = 0; i < 60; i++) {
    if (!liveMembers(group).length) return;
    await delay(50);
  }
  assert.fail(`Owned watchdog group ${group} still has live members`);
}

test('watchdog passes through normal output and exit code', async () => {
  const run = launch('console.log("watchdog-ok"); process.exitCode = 7;');
  assert.deepEqual(await run.done, [7, null]);
  assert.equal(run.output().trim(), 'watchdog-ok');
  await waitForEmpty(run.child.pid);
});

test('watchdog refuses to signal a group it does not lead', async () => {
  const run = launch('console.log("must-not-run")', 500, false);
  assert.deepEqual(await run.done, [125, null]);
  assert.equal(run.output(), '');
});

test('watchdog kills its worker group at the independent deadline', async () => {
  const run = launch('setInterval(() => {}, 1000)', 250);
  assert.deepEqual(await run.done, [null, 'SIGKILL']);
  await waitForEmpty(run.child.pid);
});

test('watchdog terminates remaining group descendants after successful command exit', async () => {
  const run = launch(`
    const {spawn} = require('node:child_process');
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'}).unref();
  `);
  assert.deepEqual(await run.done, [0, null]);
  await waitForEmpty(run.child.pid);
});

test('watchdog kills its group when its owning controller dies', async () => {
  const source = `
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, [${JSON.stringify(wrapper)}, '10000', String(process.pid),
      process.execPath, '-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
      {detached:true, stdio:['ignore','pipe','ignore']});
    child.stdout.once('data', () => process.send({pid:child.pid}));
    setInterval(() => {}, 1000);
  `;
  const controller = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let group;
  try {
    const [message] = await Promise.race([
      once(controller, 'message'),
      delay(5000, undefined, { ref: false }).then(() => { throw new Error('Controller fixture did not start watchdog'); }),
    ]);
    group = message.pid;
    const exited = once(controller, 'exit');
    controller.kill('SIGKILL');
    await exited;
    await waitForEmpty(group);
  } finally {
    if (controller.exitCode === null && controller.signalCode === null) controller.kill('SIGKILL');
    if (group && liveMembers(group).length) {
      try { process.kill(-group, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
});

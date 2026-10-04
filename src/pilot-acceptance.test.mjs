import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCase, verifyObservation, verifyScope } from '../projects/sweatshop/acceptance/status-read-only.test.mjs';

test('pilot scope excludes acceptance, policy, and unrelated source changes', () => {
  verifyScope(['src/cli.mjs', 'src/cli.test.mjs']);
  for (const file of ['src/engine.mjs', 'projects/sweatshop/project.json', 'projects/sweatshop/acceptance/status-read-only.test.mjs', '../src/cli.mjs']) {
    assert.throws(() => verifyScope([file]), /Pilot changes/);
  }
  assert.throws(() => verifyScope('src/cli.mjs'));
});

test('observation checks reject mutations, wrong reports, and silent failures', () => {
  const success = { status: 0, stdout: '{"status":"not-run"}', stderr: '' };
  verifyObservation({}, {}, success, { status: 'not-run' });
  verifyObservation({}, {}, { status: 1, stderr: '{"status":"blocked","reason":"Invalid identity"}' }, null);
  assert.throws(() => verifyObservation({}, { created: true }, success, { status: 'not-run' }), /status mutated/);
  assert.throws(() => verifyObservation({}, {}, success, { status: 'complete' }));
  assert.throws(() => verifyObservation({}, {}, success, null), /Invalid state/);
  assert.throws(() => verifyObservation({}, {}, { status: 1, stderr: '' }, null));
});

test('subprocess harness accepts unused read-only state and detects the known creation defect', async t => {
  const workspace = await fs.mkdtemp(join(tmpdir(), 'sweatshop-harness-unit-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(join(workspace, 'src'));
  const cli = join(workspace, 'src/cli.mjs');
  await fs.writeFile(cli, 'console.log(JSON.stringify({status: "not-run"}));\n');
  await runCase(workspace, 'unused');
  await fs.writeFile(cli, 'import { mkdirSync } from "node:fs"; mkdirSync(process.argv[process.argv.indexOf("--state-root") + 1], {recursive: true}); console.log(JSON.stringify({status: "not-run"}));\n');
  await assert.rejects(runCase(workspace, 'unused'), /status mutated fixture files or directories/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { argumentsFor, prepareState, assertTrackedFile } from './cli.mjs';

const policy = { id: 'first', repository: 'org/first', account: 'bot' };
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'sweatshop-cli-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const controlRoot = join(root, 'controller'); const repo = join(root, 'source'); const stateRoot = join(root, 'state');
  await fs.mkdir(controlRoot); await fs.mkdir(repo);
  return { root, controlRoot, repo, stateRoot, policy };
}
test('requires explicit project and state-root selection', () => {
  assert.equal(argumentsFor(['status', '--project', 'projects/first/project.json', '--repo', '/source', '--state-root', '/state']).project, 'projects/first/project.json');
  assert.throws(() => argumentsFor(['status', '--repo', '/source', '--state', '/state']));
});
test('isolates project state and refuses rebinding an existing project', async t => {
  const paths = await fixture(t);
  const first = await prepareState(paths);
  assert.equal(await prepareState(paths), first);
  const second = await prepareState({ ...paths, policy: { ...policy, id: 'second', repository: 'org/second' } });
  assert.notEqual(first, second);
  await assert.rejects(prepareState({ ...paths, policy: { ...policy, account: 'different' } }), /State identity/);
  const other = join(paths.root, 'other'); await fs.mkdir(other);
  await assert.rejects(prepareState({ ...paths, repo: other }), /State identity/);
});
test('rejects source, controller and state overlap including symlink aliases', async t => {
  const paths = await fixture(t);
  await assert.rejects(prepareState({ ...paths, repo: paths.controlRoot }), /separate/);
  await assert.rejects(prepareState({ ...paths, stateRoot: join(paths.repo, 'new-state') }), /separate/);
  const alias = join(paths.root, 'alias'); await fs.symlink(paths.repo, alias);
  await assert.rejects(prepareState({ ...paths, stateRoot: join(alias, 'new-state') }), /separate/);
  await fs.mkdir(paths.stateRoot); await fs.symlink(paths.repo, join(paths.stateRoot, 'first'));
  await assert.rejects(prepareState(paths), /symlink/);
});
test('requires tracked, unmodified pinned files and rejects symlink ancestry', async t => {
  const paths = await fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: paths.controlRoot, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  const file = join(paths.controlRoot, 'project.json'); await fs.writeFile(file, '{"version":1}\n');
  git('add', '.'); git('commit', '-qm', 'fixture'); const revision = git('rev-parse', 'HEAD');
  await assertTrackedFile(paths.controlRoot, file, revision);
  await fs.writeFile(file, '{"version":2}\n');
  await assert.rejects(assertTrackedFile(paths.controlRoot, file, revision), /pinned revision/);
  const untracked = join(paths.controlRoot, 'new.json'); await fs.writeFile(untracked, '{}');
  await assert.rejects(assertTrackedFile(paths.controlRoot, untracked, revision));
  const alias = join(paths.controlRoot, 'alias'); await fs.symlink(paths.controlRoot, alias);
  await assert.rejects(assertTrackedFile(paths.controlRoot, join(alias, 'project.json'), revision), /symlink/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const allowed = ['src/cli.mjs', 'src/cli.test.mjs'];
export function verifyScope(changed) {
  assert.ok(Array.isArray(changed) && changed.every(file => allowed.includes(file)), 'Pilot changes must stay in src/cli.mjs and src/cli.test.mjs');
}

// Include metadata so a rewrite of identical bytes is still a mutation. Ignore access times.
async function snapshot(root) {
  const entries = {};
  async function visit(path, name) {
    const stat = await fs.lstat(path, { bigint: true });
    entries[name] = [String(stat.mode), String(stat.mtimeNs), String(stat.ctimeNs),
      stat.isSymbolicLink() ? await fs.readlink(path) : stat.isFile() ? createHash('sha256').update(await fs.readFile(path)).digest('hex') : null];
    if (stat.isDirectory()) for (const child of (await fs.readdir(path)).sort()) await visit(join(path, child), `${name}/${child}`);
  }
  await visit(root, '.');
  return entries;
}

export function verifyObservation(before, after, result, expected) {
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(path => JSON.stringify(before[path]) !== JSON.stringify(after[path]));
  assert.deepEqual(changed, [], 'status mutated fixture files or directories');
  assert.ifError(result.error);
  if (expected === null) {
    assert.notEqual(result.status, 0, 'Invalid state must fail');
    const failure = JSON.parse(result.stderr.trim());
    assert.equal(failure.status, 'blocked');
    assert.ok(typeof failure.reason === 'string' && failure.reason.trim(), 'Failure must explain the rejected state');
  } else {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
}

const cases = ['unused', 'existing', 'malformed-identity', 'malformed-tick', 'wrong-identity',
  'overlap', 'alias-overlap', 'identity-symlink', 'project-symlink', 'state-symlink'];

export async function runCase(workspace, kind) {
  assert.ok(cases.includes(kind));
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'sweatshop-status-')));
  try {
    const controller = join(root, 'controller');
    const repo = join(root, 'product');
    const bin = join(root, 'bin');
    const project = join(controller, 'projects', 'fixture');
    for (const path of [project, repo, bin, join(root, 'home')]) await fs.mkdir(path, { recursive: true });
    await fs.cp(join(workspace, 'src'), join(controller, 'src'), { recursive: true });
    const gitPath = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' });
    assert.equal(gitPath.status, 0, 'Local Git is required');
    await fs.symlink(gitPath.stdout.trim(), join(bin, 'git'));
    for (const command of ['gh', 'codex', 'curl', 'wget', 'ssh']) {
      await fs.writeFile(join(bin, command), '#!/bin/sh\necho forbidden-external-command >&2\nexit 97\n', { mode: 0o755 });
    }
    const env = { PATH: bin, HOME: join(root, 'home'), LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    const init = spawnSync(join(bin, 'git'), ['init', '-q', repo], { env, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    const policy = { version: 1, id: 'fixture', repository: 'fixture/product', account: 'fixture',
      remote: 'https://github.com/fixture/product.git', baseBranch: 'main', eligibleLabel: 'ready',
      allowedPaths: ['src/'], protectedPaths: ['tests/'], checks: [{ name: 'syntax', command: '{node}', args: ['--version'], readablePaths: [] }],
      maxAttempts: 1, maxDurationMs: 10000, workerTimeoutMs: 10000, checkTimeoutMs: 10000, maxTasksPerTick: 1 };
    const projectFile = join(project, 'project.json');
    await fs.writeFile(projectFile, JSON.stringify(policy));
    let state = join(root, 'unused', 'nested-state');
    const report = { status: 'complete', at: '2026-01-01T00:00:00Z', tasks: [{ issue: 7, stage: 'complete' }] };
    const expected = kind === 'unused' ? { status: 'not-run' } : kind === 'existing' ? report : null;
    if (['existing', 'malformed-identity', 'malformed-tick', 'wrong-identity', 'identity-symlink'].includes(kind)) {
      const dir = join(state, policy.id);
      await fs.mkdir(dir, { recursive: true });
      const identity = { projectId: policy.id, repo, repository: policy.repository, account: kind === 'wrong-identity' ? 'other' : policy.account };
      await fs.writeFile(join(dir, 'identity.json'), kind === 'malformed-identity' ? '{broken' : JSON.stringify(identity));
      await fs.writeFile(join(dir, 'last-tick.json'), kind === 'malformed-tick' ? '{broken' : JSON.stringify(report));
      if (kind === 'identity-symlink') {
        const file = 'identity.json';
        await fs.rename(join(dir, file), join(root, 'state-file-target.json'));
        await fs.symlink(join(root, 'state-file-target.json'), join(dir, file));
      }
    }
    if (kind === 'overlap') state = join(repo, 'new-state');
    if (kind === 'alias-overlap') {
      await fs.symlink(controller, join(root, 'alias'));
      state = join(root, 'alias', 'new-state');
    }
    if (kind === 'project-symlink') {
      await fs.rename(projectFile, join(root, 'project-target.json'));
      await fs.symlink(join(root, 'project-target.json'), projectFile);
    }
    if (kind === 'state-symlink') {
      await fs.mkdir(state, { recursive: true });
      await fs.mkdir(join(root, 'state-target'));
      await fs.symlink(join(root, 'state-target'), join(state, policy.id));
    }
    const before = await snapshot(root);
    const result = spawnSync(process.execPath, [join(controller, 'src/cli.mjs'), 'status', '--project', 'projects/fixture/project.json', '--repo', repo, '--state-root', state],
      { cwd: controller, env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
    verifyObservation(before, await snapshot(root), result, expected);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// Imports expose assertions to harness unit tests, but the production entry always uses the candidate CLI.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  test('pilot change scope', () => {
    assert.ok(process.env.FACTORY_WORKSPACE, 'FACTORY_WORKSPACE is required');
    assert.ok(process.env.FACTORY_CHANGED_FILES, 'Trusted FACTORY_CHANGED_FILES is required');
    verifyScope(JSON.parse(process.env.FACTORY_CHANGED_FILES));
  });
  for (const kind of cases) test(`read-only status: ${kind}`, () => runCase(resolve(process.env.FACTORY_WORKSPACE), kind));
}

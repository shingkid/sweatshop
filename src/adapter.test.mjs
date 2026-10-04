import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createAdapter, runProcess, validateChangedPaths, assertWorkerStopped, validateArtifactPath } from './adapter.mjs';

const allowedPaths = ['src/domain/', 'tests/domain/'];
const policy = { ...JSON.parse(readFileSync(new URL('../projects/chalou/project.json', import.meta.url))), workerTimeoutMs: 10000, checkTimeoutMs: 10000 };
const projectDir = path.resolve(import.meta.dirname, '../projects/chalou');

test('path gate rejects scope escapes, symlinks, and edits to existing tests', () => {
  for (const change of [
    { status: 'M', file: 'package.json' },
    { status: '?', file: 'src/domain/../../package.json' },
    { status: '?', file: 'src/domain/link', mode: '120000' },
    { status: 'D', file: 'tests/domain/existing.test.ts' },
    { status: 'M', file: 'tests/domain/existing.test.ts' },
  ]) assert.throws(() => validateChangedPaths([change], allowedPaths, ['tests/domain/existing.test.ts']), { code: 'BLOCKED' });
  validateChangedPaths([{ status: '?', file: 'src/domain/new.ts' }, { status: '?', file: 'tests/domain/new.test.ts' }], allowedPaths, []);
});

async function fixture(t, options = {}) {
  const { policy: projectPolicy = policy, sourceFile = 'src/domain/existing.ts', protectedFile = 'tests/domain/existing.test.ts', ...adapterOptions } = options;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-adapter-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repoPath = path.join(dir, 'repo'), stateDir = path.join(dir, 'state');
  await fs.mkdir(path.dirname(path.join(repoPath, protectedFile)), { recursive: true });
  await fs.mkdir(path.dirname(path.join(repoPath, sourceFile)), { recursive: true });
  await fs.writeFile(path.join(repoPath, protectedFile), 'export {};\n');
  await fs.writeFile(path.join(repoPath, sourceFile), 'export const value = 1;\n');
  const git = async (...args) => {
    const result = await runProcess('git', args, { cwd: repoPath });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  await git('init', '-b', 'main');
  await git('add', '.');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'baseline');
  const baseSha = await git('rev-parse', 'HEAD');
  const acceptancePath = path.join(dir, 'acceptance.mjs');
  await fs.writeFile(acceptancePath, 'import "node:test";\n');
  const acceptanceHash = createHash('sha256').update(await fs.readFile(acceptancePath)).digest('hex');
  const task = { id: '1', projectId: projectPolicy.id, issueNumber: 1, title: 'Project work', body: 'A bounded task', baseSha, acceptancePath, acceptanceHash, allowedPaths: projectPolicy.allowedPaths };
  const adapter = createAdapter({ repoPath, stateDir, projectDir, policy: projectPolicy, codexPath: process.execPath, ...adapterOptions });
  const state = { attempt: 1, ...await adapter.prepare(task, { attempt: 0 }) };
  return { adapter, task, state, repoPath, stateDir, git };
}

test('prepare isolates clone and fails closed before an unvalidated worker starts', async (t) => {
  const { adapter, task, state, repoPath } = await fixture(t);
  assert.notEqual(state.workspace, repoPath);
  assert.equal((await fs.lstat(path.join(state.workspace, '.git'))).isDirectory(), true);
  await assert.rejects(adapter.work(task, state), /Native sandbox preflight unavailable/);
});

test('verification rejects protected test changes before any sandbox check', async (t) => {
  const { adapter, task, state } = await fixture(t);
  await fs.writeFile(path.join(state.workspace, 'tests/domain/existing.test.ts'), 'export const bypass = true;\n');
  await assert.rejects(adapter.verify(task, state), /Existing protected file changed/);
});

test('verification rejects changed git metadata', async (t) => {
  const { adapter, task, state } = await fixture(t);
  await fs.appendFile(path.join(state.workspace, '.git/config'), '\n# worker mutation\n');
  await assert.rejects(adapter.verify(task, state), /Worker changed git metadata/);
});

test('verification rejects untracked ignored files outside task scope', async (t) => {
  const { adapter, task, state } = await fixture(t);
  await fs.writeFile(path.join(state.workspace, 'private.env'), 'unapproved');
  await assert.rejects(adapter.verify(task, state), /Change outside allowed paths/);
});

test('mocked native checks create a controller commit only after acceptance and typecheck pass', async (t) => {
  const calls = [];
  let liveWorkspace;
  const runCommand = async (command, args, options) => {
    if (command === 'codex') {
      calls.push({ args, options });
      await fs.writeFile(path.join(liveWorkspace, 'src/domain/existing.ts'), 'export const value = 999;\n');
      return { code: 0, stdout: 'mock check passed', stderr: '' };
    }
    return runProcess(command, args, options);
  };
  const { adapter, task, state, repoPath } = await fixture(t, { runCommand, enforcementValidated: true });
  liveWorkspace = state.workspace;
  const compilerDir = path.join(repoPath, 'node_modules/typescript/bin');
  await fs.mkdir(compilerDir, { recursive: true });
  await fs.writeFile(path.join(compilerDir, 'tsc'), '// mock dependency\n');
  await fs.writeFile(path.join(state.workspace, 'src/domain/existing.ts'), 'export const value = 2;\n');
  const result = await adapter.verify(task, state);
  assert.match(result.commit, /^[a-f0-9]{40}$/);
  assert.notEqual(result.commit, state.baseSha);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].args.includes('--test'));
  assert.ok(calls[1].args.includes(path.join(projectDir, 'checks/typecheck.mjs')));
  assert.ok(calls[2].args.includes(path.join(projectDir, 'checks/regressions.mjs')));
  assert.deepEqual(result.evidence.checks.map(check => check.name), ['typecheck', 'regressions']);
  assert.ok(calls[0].options.env.FACTORY_WORKSPACE.startsWith(state.workspace.replace('attempt-1', 'verification-1-')));
  assert.deepEqual(result.evidence.paths, ['src/domain/existing.ts']);
  assert.equal(await fs.readFile(path.join(calls[0].options.env.FACTORY_WORKSPACE, 'src/domain/existing.ts'), 'utf8'), 'export const value = 2;\n');
});

test('reconciliation uses only the configured account token and validates immutable PR head', async () => {
  const calls = [];
  const commit = 'a'.repeat(40);
  const adapter = createAdapter({ repoPath: '/tmp/repo', stateDir: '/tmp/state', projectDir, policy, runCommand: async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'auth') return { code: 0, stdout: 'synthetic-token\n' };
    assert.equal(options.env.GH_TOKEN, 'synthetic-token');
    if (args[0] === 'api') return { code: 0, stdout: JSON.stringify({ login: 'shingkid' }) };
    if (args[0] === 'repo') return { code: 0, stdout: JSON.stringify({ nameWithOwner: 'shingkid/chalou' }) };
    return { code: 0, stdout: JSON.stringify([{ url: 'https://github.com/shingkid/chalou/pull/1', headRefOid: commit, state: 'OPEN' }]) };
  } });
  const result = await adapter.reconcile({ issueNumber: 1 }, { verification: { commit } });
  assert.equal(result.commit, commit);
  assert.equal(calls.filter(({ args }) => args[0] === 'auth').length, 1);
  await assert.rejects(adapter.reconcile({ issueNumber: 1 }, { verification: { commit: 'b'.repeat(40) } }), /head differs/);
  assert.equal(calls.some(({ args }) => args.includes('create') || args.includes('push')), false);
});

test('mocked worker receives no token or SSH-agent environment and required disabling flags', async (t) => {
  let captured;
  const runCommand = async (command, args, options) => {
    if (command === 'codex') { captured = { args, options }; return { code: 0, stdout: 'mock worker', stderr: '' }; }
    return runProcess(command, args, options);
  };
  const { adapter, task, state } = await fixture(t, { runCommand, enforcementValidated: true });
  await adapter.work(task, state);
  assert.equal(captured.options.env.GH_TOKEN, undefined);
  assert.equal(captured.options.env.SSH_AUTH_SOCK, undefined);
  assert.equal(captured.options.watchdog, true);
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--strict-config', 'agents.enabled=false', 'skip_host_skill_discovery']) assert.ok(captured.args.includes(flag));
  assert.equal(captured.args.includes('--sandbox'), false);
});

test('recovery never kills a potentially live worker', async (t) => {
  const { adapter, task, stateDir } = await fixture(t);
  await fs.writeFile(path.join(stateDir, 'tasks/1/worker.json'), JSON.stringify({ status: 'running', pid: process.pid }));
  await assert.rejects(adapter.recover(task), /may still be alive/);
});

test('recovery probes surviving process groups after the leader exits and fails closed on unknown receipts', () => {
  const targets = [];
  assert.throws(() => assertWorkerStopped({ status: 'running', pid: 12345 }, (pid) => {
    targets.push(pid);
    if (pid > 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  }), /process group -12345 may still be alive/);
  assert.deepEqual(targets, [12345, -12345]);
  for (const receipt of [null, {}, { status: 'completed' }, { status: 'running', pid: -1 }]) assert.throws(() => assertWorkerStopped(receipt), /missing or uncertain/);
  assert.throws(() => assertWorkerStopped({ status: 'running', pid: 12345 }, () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }), /status uncertain/);
  assert.doesNotThrow(() => assertWorkerStopped({ status: 'completed', pid: 12345 }, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }));
});

test('recovery without a durable worker receipt remains blocked', async (t) => {
  const { adapter, task, state } = await fixture(t);
  await assert.rejects(adapter.recover(task, state), /receipt does not match/);
});

test('repeated preparation preserves an orphan checkout and baseline before recreating the pending attempt', async (t) => {
  const { adapter, task, state, stateDir } = await fixture(t);
  await fs.writeFile(path.join(state.workspace, 'preserved.txt'), 'orphan work');
  const prepared = await adapter.prepare(task, { stage: 'pending', attempt: 0 });
  assert.equal(prepared.workspace, state.workspace);
  const entries = await fs.readdir(path.join(stateDir, 'tasks/1'));
  const orphan = entries.find((name) => name.startsWith('attempt-1-orphan-'));
  assert.ok(orphan);
  assert.equal(await fs.readFile(path.join(stateDir, 'tasks/1', orphan, 'preserved.txt'), 'utf8'), 'orphan work');
  assert.ok(entries.some((name) => name.startsWith('baseline-1.json-orphan-')));
  await assert.rejects(fs.access(path.join(state.workspace, 'preserved.txt')), { code: 'ENOENT' });
});

test('preparation refuses to rename a checkout with a live worker receipt', async (t) => {
  const { adapter, task, state, stateDir } = await fixture(t);
  await fs.writeFile(path.join(stateDir, 'tasks/1/worker.json'), JSON.stringify({ status: 'running', workspace: state.workspace, pid: process.pid }));
  await assert.rejects(adapter.prepare(task, { stage: 'pending', attempt: 0 }), /may still be alive/);
  await fs.access(state.workspace);
});

test('re-verification uses new clones and retains prior artifacts and logs', async (t) => {
  const runCommand = (command, args, options) => command === 'codex' ? Promise.resolve({ code: 0, stdout: 'mock passed' }) : runProcess(command, args, options);
  const { adapter, task, state, repoPath, stateDir } = await fixture(t, { runCommand, enforcementValidated: true });
  const compilerDir = path.join(repoPath, 'node_modules/typescript/bin');
  await fs.mkdir(compilerDir, { recursive: true });
  await fs.writeFile(path.join(compilerDir, 'tsc'), '// mock compiler');
  await fs.writeFile(path.join(state.workspace, 'src/domain/existing.ts'), 'export const value = 2;\n');
  const first = await adapter.verify(task, state);
  const taskDir = path.join(stateDir, 'tasks/1');
  const firstArtifact = JSON.parse(await fs.readFile(path.join(taskDir, 'artifact-1.json'), 'utf8'));
  const second = await adapter.verify(task, state);
  const secondArtifact = JSON.parse(await fs.readFile(path.join(taskDir, 'artifact-1.json'), 'utf8'));
  assert.notEqual(firstArtifact.workspace, secondArtifact.workspace);
  await fs.access(firstArtifact.workspace);
  await fs.access(first.evidence.acceptanceLogPath);
  assert.notEqual(first.evidence.acceptanceLogPath, second.evidence.acceptanceLogPath);
  assert.equal(await validateArtifactPath(taskDir, 1, secondArtifact.workspace), secondArtifact.workspace);
  await assert.rejects(validateArtifactPath(taskDir, 2, secondArtifact.workspace), /outside expected/);
  await assert.rejects(validateArtifactPath(taskDir, 1, path.join(taskDir, '../elsewhere')), /outside expected/);
  const symlink = path.join(taskDir, 'verification-1-00000000-0000-0000-0000-000000000000');
  await fs.symlink(secondArtifact.workspace, symlink);
  await assert.rejects(validateArtifactPath(taskDir, 1, symlink), /not a direct task directory/);
});

test('runner bounds hanging commands and output capture', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 30 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test('runner forwards input, output, and exit status through its independent watchdog', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout); process.exitCode = 7'], { input: 'watchdog integration', watchdog: true, timeoutMs: 5000 });
  assert.equal(result.code, 7);
  assert.equal(result.stdout, 'watchdog integration');
});

test('publication rejects staging transformations that change verified source bytes', async (t) => {
  const runCommand = (command, args, options) => command === 'codex' ? Promise.resolve({ code: 0, stdout: 'mock passed' }) : runProcess(command, args, options);
  const { adapter, task, state, repoPath } = await fixture(t, { runCommand, enforcementValidated: true });
  const compilerDir = path.join(repoPath, 'node_modules/typescript/bin');
  await fs.mkdir(compilerDir, { recursive: true });
  await fs.writeFile(path.join(compilerDir, 'tsc'), '// mock compiler');
  await fs.writeFile(path.join(state.workspace, 'src/domain/.gitattributes'), '*.ts ident\n');
  await fs.writeFile(path.join(state.workspace, 'src/domain/existing.ts'), "export const value = '$Id: verified-value $';\n");
  await assert.rejects(adapter.verify(task, state), /Staging changed verified bytes/);
});

test('second project uses its own identity, paths, and configured checks through the same adapter', async (t) => {
  const second = { ...policy, id: 'ledger-fixture', repository: 'fixture-owner/ledger', account: 'fixture-owner', remote: 'git@github.com:fixture-owner/ledger.git', allowedPaths: ['lib/', 'spec/'], protectedPaths: ['spec/'], checks: [{ name: 'javascript-syntax', command: '{node}', args: ['--check', '{workspace}/lib/existing.mjs'], readablePaths: [] }] };
  const calls = [];
  const runCommand = (command, args, options) => {
    if (command === 'codex') { calls.push({ args, options }); return Promise.resolve({ code: 0, stdout: 'mock passed' }); }
    return runProcess(command, args, options);
  };
  const { adapter, task, state } = await fixture(t, { policy: second, sourceFile: 'lib/existing.mjs', protectedFile: 'spec/existing.test.mjs', runCommand, enforcementValidated: true });
  await fs.writeFile(path.join(state.workspace, 'lib/existing.mjs'), 'export const value = 2;\n');
  const result = await adapter.verify(task, state);
  assert.deepEqual(result.evidence.paths, ['lib/existing.mjs']);
  assert.deepEqual(result.evidence.checks.map(check => check.name), ['javascript-syntax']);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.includes('--check'));
  assert.ok(calls[1].args.some(arg => arg.endsWith('/lib/existing.mjs')));
  assert.equal(calls.some(call => call.args.some(arg => arg.includes('typescript'))), false);
  await fs.writeFile(path.join(state.workspace, 'spec/existing.test.mjs'), 'export const bypass = true;\n');
  await assert.rejects(adapter.verify(task, state), /Existing protected file changed/);
});

test('preparation rejects baseline symlinks that would widen a writable directory grant', async (t) => {
  const scoped = { ...policy, allowedPaths: ['escape/'] };
  const { adapter, task, repoPath, git } = await fixture(t, { policy: scoped });
  await fs.symlink('../../..', path.join(repoPath, 'escape'));
  await git('add', 'escape');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'symlink fixture');
  const unsafe = { ...task, id: 'symlink', baseSha: await git('rev-parse', 'HEAD') };
  await assert.rejects(adapter.prepare(unsafe, { attempt: 0 }), /Unsafe writable directory/);
});

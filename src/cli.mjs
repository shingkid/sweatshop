#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { dirname, basename, resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import net from 'node:net';
import { runTask } from './engine.mjs';
import { createAdapter, runProcess } from './adapter.mjs';
import { cleanEnvironment, preflightSandbox } from './sandbox.mjs';
import { hash, validatePolicy, validateContract, acceptanceAllowed } from './contracts.mjs';

const controlRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await fs.open(temporary, 'w', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, path);
}
async function readJson(path, fallback) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
async function command(binary, args, options = {}) {
  const result = await runProcess(binary, args, { env: cleanEnvironment(), timeoutMs: 30000, ...options });
  if (result.code !== 0 || result.timedOut || result.oversized) throw new Error(`${binary} failed: ${result.stderr?.slice(-2000) ?? result.code}`);
  return result.stdout.trim();
}
async function github(policy, args) {
  const token = await command('gh', ['auth', 'token', '--user', policy.account]);
  return command('gh', args, { env: cleanEnvironment({ GH_TOKEN: token }) });
}
async function assertIdentity(repo, policy) {
  const remote = await command('git', ['remote', 'get-url', 'origin'], { cwd: repo });
  if (remote !== policy.remote) throw new Error('Repository remote differs from trusted policy');
  const account = JSON.parse(await github(policy, ['api', 'user']));
  if (account.login !== policy.account) throw new Error('GitHub account differs from trusted policy');
  const repository = JSON.parse(await github(policy, ['repo', 'view', policy.repository, '--json', 'nameWithOwner,defaultBranchRef,viewerPermission']));
  if (repository.nameWithOwner !== policy.repository || repository.defaultBranchRef.name !== policy.baseBranch || !['ADMIN', 'MAINTAIN', 'WRITE'].includes(repository.viewerPermission)) throw new Error('GitHub repository, base, or permissions differ from trusted policy');
  return { account: account.login, repository: repository.nameWithOwner, remote };
}
function contained(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
async function exclusive(repo) {
  // The OS releases the listener after a crash, avoiding unsafe stale file-lock takeover.
  const port = 30000 + Number.parseInt(hash(repo).slice(0, 6), 16) % 20000;
  const server = net.createServer(socket => socket.destroy());
  await new Promise((yes, no) => { server.once('error', no); server.listen({ host: '127.0.0.1', port, exclusive: true }, yes); });
  return () => new Promise(yes => server.close(yes));
}
export function argumentsFor(argv) {
  const [action, ...rest] = argv;
  if (!['doctor', 'tick', 'status'].includes(action)) throw new Error('Usage: cli.mjs doctor|tick|status --project projects/ID/project.json --repo PATH --state-root PATH [--expected-revision SHA]');
  const options = { action };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (!['--project', '--repo', '--state-root', '--expected-revision'].includes(flag) || !rest[i + 1] || rest[i + 1].startsWith('--') || options[flag.slice(2)]) throw new Error(`Invalid argument: ${flag}`);
    options[flag.slice(2)] = rest[i + 1];
  }
  if (!options.repo || !options['state-root'] || !options.project) throw new Error('--project, --repo and --state-root are required');
  return options;
}

export async function assertRegularFile(root, path) {
  if (!contained(root, path) || await fs.realpath(path) !== path || !(await fs.lstat(path)).isFile()) throw new Error('Trusted files must be regular files without symlink ancestors');
}
export async function assertTrackedFile(root, path, revision) {
  await assertRegularFile(root, path);
  const name = relative(root, path);
  await command('git', ['ls-files', '--error-unmatch', '--', name], { cwd: root });
  const committed = await runProcess('git', ['show', revision + ':' + name], { cwd: root, env: cleanEnvironment(), timeoutMs: 30000 });
  if (committed.code !== 0 || committed.timedOut || committed.oversized || hash(committed.stdout) !== hash(await fs.readFile(path))) throw new Error('Trusted file differs from pinned revision: ' + name);
}
export async function prepareState({ controlRoot: root, repo, stateRoot, policy }) {
  root = await fs.realpath(root);
  repo = await fs.realpath(repo);
  // Resolve existing ancestors before creating state, including a not-yet-created leaf.
  async function canonicalTarget(path) {
    try { return await fs.realpath(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return join(await canonicalTarget(dirname(path)), basename(path)); }
  }
  stateRoot = await canonicalTarget(resolve(stateRoot));
  const trees = [root, repo, stateRoot];
  for (let i = 0; i < trees.length; i++) for (let j = i + 1; j < trees.length; j++) {
    if (contained(trees[i], trees[j]) || contained(trees[j], trees[i])) throw new Error('State, source repository, and controller must have separate directory trees');
  }
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const stateDir = join(stateRoot, policy.id);
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (await fs.realpath(stateDir) !== stateDir) throw new Error('Project state directory cannot be a symlink');
  const identityPath = join(stateDir, 'identity.json');
  const identity = { projectId: policy.id, repo, repository: policy.repository, account: policy.account };
  try { await fs.writeFile(identityPath, JSON.stringify(identity) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await assertRegularFile(stateDir, identityPath);
    const existing = await readJson(identityPath);
    if (Object.keys(existing).length !== Object.keys(identity).length || Object.entries(identity).some(([key, value]) => existing[key] !== value)) throw new Error('State identity differs from configured project or source repository');
  }
  return stateDir;
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  const root = await fs.realpath(controlRoot);
  const projectPath = resolve(root, options.project);
  const projectRelative = relative(root, projectPath);
  if (!/^projects\/[a-z0-9]+(?:-[a-z0-9]+)*\/project\.json$/.test(projectRelative)) throw new Error('Project must be projects/ID/project.json under the controller');
  await assertRegularFile(root, projectPath);
  const policy = validatePolicy(await readJson(projectPath));
  if (projectRelative !== 'projects/' + policy.id + '/project.json') throw new Error('Project ID differs from its directory');
  const projectDir = dirname(projectPath);
  const repo = await fs.realpath(options.repo);
  const repositoryRoot = await command('git', ['rev-parse', '--show-toplevel'], { cwd: repo });
  if (await fs.realpath(repositoryRoot) !== repo) throw new Error('--repo must identify the source repository root');
  const stateDir = await prepareState({ controlRoot: root, repo, stateRoot: resolve(options['state-root']), policy });
  if (options.action === 'status') {
    console.log(JSON.stringify(await readJson(join(stateDir, 'last-tick.json'), { status: 'not-run' }), null, 2));
    return;
  }
  const unlock = await exclusive(repo);
  try {
    if (options.action === 'tick') {
      const revision = await command('git', ['rev-parse', 'HEAD'], { cwd: controlRoot });
      if (!/^[a-f0-9]{40}$/.test(options['expected-revision'] ?? '') || revision !== options['expected-revision']) throw new Error('Tick requires the installed, immutable controller revision');
      if (await command('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: controlRoot })) throw new Error('Controller checkout changed; refusing unattended execution');
      await assertTrackedFile(root, projectPath, revision);
    }
    const identity = await assertIdentity(repo, policy);
    const sandbox = preflightSandbox({ stateDir });
    const codex = await command('codex', ['--version']);
    if (options.action === 'doctor') {
      console.log(JSON.stringify({ status: 'ready', ...identity, sandbox, codex, node: process.execPath, scope: policy.allowedPaths, delivery: 'pull-request-only' }, null, 2));
      return;
    }
    const issues = JSON.parse(await github(policy, ['issue', 'list', '--repo', policy.repository, '--state', 'open', '--label', policy.eligibleLabel, '--limit', '100', '--json', 'number,title,body,labels,state,url']));
    if (issues.length === 100) throw new Error('Intake page full; refusing incomplete issue inventory');
    const report = { at: new Date().toISOString(), host: hostname(), status: 'idle', considered: issues.length, tasks: [] };
    const adapter = createAdapter({ repoPath: repo, stateDir, projectDir, policy, enforcementValidated: true });
    let tasksStarted = 0;
    for (const issue of issues.sort((a, b) => a.number - b.number)) {
      const id = `issue-${issue.number}`;
      const contractPath = join(projectDir, 'tasks', `${id}.json`);
      const contract = await readJson(contractPath, null);
      if (!contract) { report.tasks.push({ issue: issue.number, stage: 'waiting-for-contract', reason: 'A pinned acceptance contract is required' }); continue; }
      try {
        await assertTrackedFile(root, contractPath, options['expected-revision']);
        if (!acceptanceAllowed(contract.acceptancePath, policy.id)) throw new Error('Invalid acceptance path');
        const acceptancePath = join(controlRoot, contract.acceptancePath);
        await assertTrackedFile(root, acceptancePath, options['expected-revision']);
        validateContract(contract, issue, await fs.readFile(acceptancePath), policy);
        const task = { ...contract, id, projectId: policy.id, projectDir, title: issue.title, body: issue.body, acceptancePath };
        const statePath = join(stateDir, `${id}.json`);
        const state = await readJson(statePath, null);
        if (!state || !['complete', 'blocked'].includes(state.stage)) tasksStarted++;
        const result = await runTask({ task, state, adapter, save: value => atomicJson(statePath, value), limits: { ...policy, controllerRevision: options['expected-revision'], codex, node: process.version } });
        report.tasks.push({ issue: issue.number, stage: result.stage, reason: result.reason, publication: result.publication, attempt: result.attempt });
        report.status = result.stage;
        // One task per tick limits both spend and the amount of new work to review.
        if (!state || !['complete', 'blocked'].includes(state.stage)) break;
      } catch (error) {
        report.tasks.push({ issue: issue.number, stage: 'blocked', reason: error.message });
        report.status = 'blocked';
        if (tasksStarted >= policy.maxTasksPerTick) break;
      }
    }
    if (report.tasks.some(task => task.stage === 'waiting-for-contract') && report.status === 'idle') report.status = 'waiting-for-contract';
    await atomicJson(join(stateDir, 'last-tick.json'), report);
    console.log(JSON.stringify(report, null, 2));
  } finally { await unlock(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ status: 'blocked', reason: error.message })); process.exitCode = 1; });

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sandboxArgs, workerArgs, executable } from './sandbox.mjs';
import { validatePolicy } from './contracts.mjs';

const blocked = (message) => Object.assign(new Error(message), { code: 'BLOCKED' });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const cleanEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', OPENSSL_CONF: '/dev/null' });

async function treeHash(directory) {
  const entries = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    const file = path.join(directory, name), stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw blocked(`Symlink in git metadata: ${file}`);
    entries.push([name, stat.mode, stat.isDirectory() ? await treeHash(file) : digest(await fs.readFile(file))]);
  }
  return digest(JSON.stringify(entries));
}

async function assertWritableDirectory(workspace, relativePath, create = false) {
  const root = await fs.realpath(workspace);
  let current = root;
  for (const part of relativePath.split('/').filter(Boolean)) {
    if (part === '.' || part === '..') throw blocked(`Unsafe writable directory: ${relativePath}`);
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      await fs.mkdir(current);
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(current) !== current) throw blocked(`Unsafe writable directory: ${relativePath}`);
  }
  if (current === root || !current.startsWith(root + path.sep)) throw blocked(`Unsafe writable directory: ${relativePath}`);
}

// The controller owns this runner. Worker commands receive an explicit clean environment.
export async function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 120000;
    const executablePath = command === 'codex' ? executable('codex') : command;
    const child = spawn(options.watchdog ? process.execPath : executablePath,
      options.watchdog ? [fileURLToPath(new URL('./watchdog.mjs', import.meta.url)), String(timeoutMs), String(process.pid), executablePath, ...args] : args,
      { cwd: options.cwd, env: options.env ?? cleanEnv(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, oversized = false;
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs + (options.watchdog ? 1000 : 0));
    const collect = (kind, data) => {
      if (kind === 'stdout') stdout += data; else stderr += data;
      if (stdout.length + stderr.length > 4 * 1024 * 1024) { oversized = true; stop(); }
    };
    child.stdout.on('data', (data) => collect('stdout', data));
    child.stderr.on('data', (data) => collect('stderr', data));
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') { clearTimeout(timer); stop(); reject(error); } });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); stop(); resolve({ code, stdout, stderr, timedOut, oversized }); });
    Promise.resolve(options.onSpawn?.(child.pid)).then(() => child.stdin.end(options.input ?? '')).catch((error) => { stop(); reject(error); });
  });
}

export function validateChangedPaths(changes, allowedPaths, baselineFiles, protectedPaths = ['tests/']) {
  if (!changes.length) throw blocked('Worker produced no changes');
  for (const { status, file, mode } of changes) {
    if (!file || file.startsWith('/') || file.split('/').includes('..') || !allowedPaths.some((prefix) => file.startsWith(prefix))) throw blocked(`Change outside allowed paths: ${file}`);
    if (mode === '120000' || mode === '160000') throw blocked(`Symlink or submodule rejected: ${file}`);
    if (protectedPaths.some(prefix => file.startsWith(prefix)) && baselineFiles.includes(file) && status !== '?') throw blocked(`Existing protected file changed: ${file}`);
    if (status === 'R' || status === 'C') throw blocked(`Renames and copies are unsupported: ${file}`);
  }
}

export function assertWorkerStopped(receipt, probe = (pid) => process.kill(pid, 0)) {
  if (!receipt || !['running', 'completed'].includes(receipt.status) || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0) throw blocked('Worker receipt missing or uncertain; manual recovery required');
  for (const target of [receipt.pid, -receipt.pid]) {
    try { probe(target); }
    catch (error) {
      if (error.code === 'ESRCH') continue;
      throw blocked(`Worker process status uncertain for ${target}; manual recovery required`);
    }
    throw blocked(`Worker PID or process group ${target} may still be alive; manual recovery required`);
  }
}

export async function validateArtifactPath(taskDirectory, attempt, artifactWorkspace) {
  if (typeof artifactWorkspace !== 'string' || path.dirname(artifactWorkspace) !== taskDirectory ||
      !new RegExp(`^verification-${attempt}-[0-9a-f-]{36}$`).test(path.basename(artifactWorkspace))) throw blocked('Artifact workspace outside expected task directory');
  if ((await fs.lstat(artifactWorkspace)).isSymbolicLink() ||
      path.dirname(await fs.realpath(artifactWorkspace)) !== await fs.realpath(taskDirectory)) throw blocked('Artifact workspace is not a direct task directory');
  return artifactWorkspace;
}

export function createAdapter({ repoPath, stateDir, projectDir, policy, runCommand = runProcess, enforcementValidated = false, codexPath }) {
  validatePolicy(policy);
  const root = path.resolve(repoPath), stateRoot = path.resolve(stateDir);
  const projectRoot = path.resolve(projectDir);
  const run = async (command, args, options = {}) => {
    const result = await runCommand(command, args, { timeoutMs: policy.checkTimeoutMs ?? 120000, ...options });
    if (options.evidencePath) await fs.writeFile(options.evidencePath, JSON.stringify(result), { mode: 0o600 });
    if (result.code !== 0 || result.timedOut || result.oversized) throw blocked(`${command} failed: ${String(result.stderr || result.stdout || result.code).slice(-3000)}`);
    return String(result.stdout ?? '');
  };
  const git = (cwd, args) => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always', ...args], { cwd });
  let githubToken;
  const githubEnv = async () => {
    githubToken ??= (await run('gh', ['auth', 'token', '--hostname', 'github.com', '--user', policy.account])).trim();
    if (!githubToken) throw blocked('No token for configured GitHub account');
    return { ...cleanEnv(), GH_TOKEN: githubToken };
  };
  const gh = async (args) => run('gh', args, { env: await githubEnv() });
  const allowed = (task) => {
    const paths = task.allowedPaths ?? policy.allowedPaths;
    if (!Array.isArray(paths) || !paths.length || paths.some((file) => typeof file !== 'string' || !file.endsWith('/') || file.split('/').includes('..') || !policy.allowedPaths.some((prefix) => file.startsWith(prefix)))) throw blocked('Invalid task path restriction');
    return paths;
  };
  const directory = (task) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(task.id))) throw blocked('Unsafe task id');
    return path.join(stateRoot, 'tasks', String(task.id));
  };
  const receiptPath = (task) => path.join(directory(task), 'worker.json');
  const readReceipt = async (task) => { try { return JSON.parse(await fs.readFile(receiptPath(task), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const workspace = (task, state) => {
    const expected = path.join(directory(task), `attempt-${state.attempt}`);
    if (state.workspace !== expected) throw blocked('Workspace does not match task attempt');
    return expected;
  };
  const nativeArgs = (kind, context) => {
    // A host-specific probe must attest the exact generated profile before execution.
    if (enforcementValidated !== true) throw blocked('Native sandbox preflight unavailable: profile must be validated on this host');
    const profile = { workspace: context.workspace, runtimeExecutable: codexPath,
      writablePaths: kind === 'worker' ? context.allowedPaths.map((file) => path.join(context.workspace, file)) : [],
      readablePaths: [path.dirname(context.acceptancePath), path.dirname(realpathSync(process.execPath)), ...(context.readablePaths ?? []), ...(context.checkExecutable ? [path.dirname(context.checkExecutable)] : []), ...(context.protectedFiles ?? []).map((file) => path.join(context.workspace, file)), path.join(context.workspace, '.git')],
      denyPaths: [] };
    const args = kind === 'worker' ? workerArgs(profile) : sandboxArgs(profile);
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string') || args.some((arg) => /dangerously|--sandbox$|--add-dir/.test(arg))) throw blocked('Invalid sandbox configuration');
    return args;
  };
  const baseline = async (task, state) => JSON.parse(await fs.readFile(path.join(directory(task), `baseline-${state.attempt}.json`), 'utf8'));
  const inspect = async (task, state) => {
    const cwd = workspace(task, state), trusted = await baseline(task, state);
    if (await treeHash(path.join(cwd, '.git')) !== trusted.gitHash) throw blocked('Worker changed git metadata');
    if ((await git(cwd, ['rev-parse', 'HEAD'])).trim() !== trusted.baseSha) throw blocked('Worker changed HEAD');
    if ((await git(cwd, ['remote', 'get-url', 'origin'])).trim() !== root) throw blocked('Worker changed origin');
    if (digest(await fs.readFile(path.join(cwd, '.git', 'config'))) !== trusted.configHash) throw blocked('Worker changed git configuration');
    const staged = await git(cwd, ['diff', '--cached', '--name-only']);
    if (staged.trim()) throw blocked('Worker changed the index');
    const records = (await git(cwd, ['diff', '--no-renames', '--name-status', '-z', 'HEAD'])).split('\0').filter(Boolean);
    const changes = [];
    for (let i = 0; i < records.length; i += 2) changes.push({ status: records[i], file: records[i + 1] });
    for (const file of (await git(cwd, ['ls-files', '--others', '-z'])).split('\0').filter(Boolean)) changes.push({ status: '?', file });
    for (const change of changes) {
      if (change.status === 'D') continue;
      const parts = change.file.split('/');
      for (let i = 1; i <= parts.length; i++) if ((await fs.lstat(path.join(cwd, ...parts.slice(0, i)))).isSymbolicLink()) change.mode = '120000';
      if (change.mode !== '120000') change.hash = digest(await fs.readFile(path.join(cwd, change.file)));
    }
    validateChangedPaths(changes, allowed(task), trusted.files, policy.protectedPaths);
    return { cwd, trusted, changes };
  };
  return {
    async prepare(task, state) {
      if (!Number.isInteger(state.attempt) || state.attempt < 0) throw blocked('Invalid attempt');
      const attempt = state.attempt + 1;
      const dir = directory(task), cwd = path.join(dir, `attempt-${attempt}`);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      if (state.stage && state.stage !== 'pending') throw blocked('Preparation requires pending state');
      const orphanId = randomUUID();
      for (const candidate of [cwd, path.join(dir, `baseline-${attempt}.json`)]) {
        try { await fs.lstat(candidate); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        // Pending means this attempt has not crossed the durable working checkpoint.
        // A matching receipt is stronger evidence that a process was launched.
        const receipt = await readReceipt(task);
        if (receipt?.workspace === cwd) assertWorkerStopped(receipt);
        await fs.rename(candidate, `${candidate}-orphan-${orphanId}`);
      }
      const baseSha = (await git(root, ['rev-parse', `${task.baseSha || 'origin/main'}^{commit}`])).trim();
      if (!/^[a-f0-9]{40}$/.test(baseSha)) throw blocked('Invalid base commit');
      const acceptancePath = path.resolve(task.acceptancePath);
      if (!(await fs.lstat(acceptancePath)).isFile()) throw blocked('Acceptance file is not a regular file');
      const acceptanceHash = digest(await fs.readFile(acceptancePath));
      if (task.acceptanceHash !== acceptanceHash) throw blocked('Acceptance source does not match approved task hash');
      await git(root, ['clone', '--no-hardlinks', '--no-checkout', '--', root, cwd]);
      await git(cwd, ['checkout', '--detach', baseSha]);
      for (const file of allowed(task)) await assertWritableDirectory(cwd, file, true);
      const files = (await git(cwd, ['ls-files', '-z'])).split('\0').filter(Boolean);
      await fs.writeFile(path.join(dir, `baseline-${attempt}.json`), JSON.stringify({ baseSha, files, acceptancePath, acceptanceHash, gitHash: await treeHash(path.join(cwd, '.git')), configHash: digest(await fs.readFile(path.join(cwd, '.git', 'config'))) }), { flag: 'wx', mode: 0o600 });
      return { workspace: cwd, baseSha };
    },
    async recover(task, state) {
      const receipt = await readReceipt(task);
      if (state && receipt?.workspace !== workspace(task, state)) throw blocked('Worker receipt does not match interrupted workspace');
      assertWorkerStopped(receipt);
    },
    async work(task, state) {
      const cwd = workspace(task, state), trusted = await baseline(task, state);
      for (const file of allowed(task)) await assertWritableDirectory(cwd, file);
      const permission = nativeArgs('worker', { workspace: cwd, stateDir: stateRoot, allowedPaths: allowed(task), protectedFiles: trusted.files.filter(file => policy.protectedPaths.some(prefix => file.startsWith(prefix))), acceptancePath: trusted.acceptancePath });
      const disabled = ['hooks', 'memories', 'apps', 'plugins', 'browser_use', 'computer_use', 'chronicle', 'shell_snapshot'].flatMap((name) => ['--disable', name]);
      const args = ['exec', '--ignore-user-config', '--ignore-rules', '--strict-config', '--ephemeral', '-C', cwd, '-c', 'approval_policy="never"', '-c', 'agents.enabled=false', '-c', 'web_search="disabled"', '--enable', 'skip_host_skill_discovery', ...disabled, ...permission, '-'];
      const previousFailure = (state.history ?? []).findLast((entry) => ['work-failed', 'verify-failed'].includes(entry.kind));
      const prompt = `Implement issue #${task.issueNumber}: ${task.title}\n${task.body}\nOnly edit ${allowed(task).join(', ')}. Existing tests and git metadata are protected. Do not commit. Acceptance checks are independently controlled.\nPrevious attempt failure: ${previousFailure?.detail ?? 'none'}`;
      const logPath = path.join(directory(task), `worker-${state.attempt}.json`);
      let workerPid;
      const output = await run('codex', args, { cwd, input: prompt, env: cleanEnv(), evidencePath: logPath, timeoutMs: policy.workerTimeoutMs, watchdog: true, onSpawn: (pid) => {
        workerPid = pid;
        return fs.writeFile(receiptPath(task), JSON.stringify({ pid, status: 'running', workspace: cwd, startedAt: new Date().toISOString() }), { mode: 0o600 });
      } });
      await fs.writeFile(receiptPath(task), JSON.stringify({ pid: workerPid, status: 'completed', workspace: cwd, outputHash: digest(output) }), { mode: 0o600 });
      return { workerEvidence: { outputHash: digest(output), logPath } };
    },
    async verify(task, state) {
      const { cwd: workerWorkspace, trusted, changes } = await inspect(task, state);
      if (digest(await fs.readFile(trusted.acceptancePath)) !== trusted.acceptanceHash) throw blocked('Trusted acceptance changed');
      // Worker descendants retain no permission to this sibling clone. Checks and the
      // artifact commit use these captured bytes, never the live worker checkout.
      const verificationId = `${state.attempt}-${randomUUID()}`;
      const cwd = path.join(directory(task), `verification-${verificationId}`);
      await git(root, ['clone', '--no-hardlinks', '--no-checkout', '--', root, cwd]);
      await git(cwd, ['checkout', '--detach', trusted.baseSha]);
      for (const change of changes) {
        const destination = path.join(cwd, change.file);
        if (change.status === 'D') await fs.unlink(destination);
        else {
          const bytes = await fs.readFile(path.join(workerWorkspace, change.file));
          if (digest(bytes) !== change.hash) throw blocked('Worker bytes changed while capturing verification artifact');
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.writeFile(destination, bytes);
        }
      }
      const expand = value => value.replace(/\{(node|repo|workspace|project)\}/g, (_, name) => ({ node: process.execPath, repo: root, project: projectRoot, workspace: cwd })[name]);
      const readablePaths = policy.checks.flatMap(check => check.readablePaths.map(expand));
      const permission = nativeArgs('verify', { workspace: cwd, acceptancePath: trusted.acceptancePath, readablePaths, stateDir: stateRoot });
      const env = { ...cleanEnv(), FACTORY_WORKSPACE: cwd, FACTORY_SOURCE: root, FACTORY_CHANGED_FILES: JSON.stringify(changes.map(change => change.file)), FACTORY_BASELINE_FILES: JSON.stringify(trusted.files) };
      const acceptanceLogPath = path.join(directory(task), `acceptance-${verificationId}.json`);
      const acceptance = await run('codex', ['sandbox', '-C', cwd, ...permission, '--', process.execPath, '--test', trusted.acceptancePath], { cwd, env, evidencePath: acceptanceLogPath, watchdog: true });
      const checkEvidence = [];
      for (const check of policy.checks) {
        const requested = expand(check.command);
        const command = requested.includes('/') ? realpathSync(requested) : executable(requested);
        const checkPermission = nativeArgs('verify', { workspace: cwd, acceptancePath: trusted.acceptancePath, readablePaths: [...readablePaths, projectRoot], checkExecutable: command });
        const logPath = path.join(directory(task), `${check.name}-${verificationId}.json`);
        const output = await run('codex', ['sandbox', '-C', cwd, ...checkPermission, '--', command, ...check.args.map(expand)], { cwd, env, evidencePath: logPath, watchdog: true });
        checkEvidence.push({ name: check.name, outputHash: digest(output), logPath });
      }
      await git(cwd, ['add', '--', ...changes.map(({ file }) => file)]);
      for (const change of changes.filter(({ status }) => status !== 'D')) {
        const raw = (await git(cwd, ['hash-object', '--no-filters', '--', change.file])).trim();
        const staged = (await git(cwd, ['rev-parse', `:${change.file}`])).trim();
        if (raw !== staged || digest(await fs.readFile(path.join(cwd, change.file))) !== change.hash) throw blocked(`Staging changed verified bytes: ${change.file}`);
      }
      await git(cwd, ['-c', 'user.name=Factory Bot', '-c', 'user.email=factory@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', `Implement issue #${task.issueNumber}`]);
      const result = { commit: (await git(cwd, ['rev-parse', 'HEAD'])).trim(), evidence: { acceptanceHash: trusted.acceptanceHash, acceptanceOutputHash: digest(acceptance), acceptanceLogPath, checks: checkEvidence, paths: changes.map(({ file }) => file) } };
      const artifact = JSON.stringify({ workspace: cwd, ...result });
      await fs.writeFile(path.join(directory(task), `artifact-${verificationId}.json`), artifact, { flag: 'wx', mode: 0o600 });
      const pointer = path.join(directory(task), `artifact-${state.attempt}.json`);
      const temporary = `${pointer}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, artifact, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, pointer);
      return result;
    },
    async reconcile(task, state) {
      if (!Number.isInteger(task.issueNumber) || task.issueNumber < 1) throw blocked('Invalid issue number');
      const account = JSON.parse(await gh(['api', 'user']));
      if (account.login !== policy.account) throw blocked('GitHub account mismatch');
      const repository = JSON.parse(await gh(['repo', 'view', policy.repository, '--json', 'nameWithOwner']));
      if (repository.nameWithOwner !== policy.repository) throw blocked('GitHub repository mismatch');
      const prs = JSON.parse(await gh(['pr', 'list', '--repo', policy.repository, '--state', 'all', '--head', `factory/issue-${task.issueNumber}`, '--json', 'url,headRefOid,state']));
      if (prs.length > 1) throw blocked('Multiple PRs found for issue');
      if (!prs.length) return null;
      if (prs[0].headRefOid !== state.verification?.commit) throw blocked('Existing PR head differs from verified commit');
      return { url: prs[0].url, commit: prs[0].headRefOid };
    },
    async publish(task, state) {
      const existing = await this.reconcile(task, state);
      if (existing) return existing;
      workspace(task, state);
      const artifact = JSON.parse(await fs.readFile(path.join(directory(task), `artifact-${state.attempt}.json`), 'utf8'));
      const cwd = await validateArtifactPath(directory(task), state.attempt, artifact.workspace), commit = state.verification?.commit;
      if (artifact.commit !== commit) throw blocked('Artifact receipt differs from verified state');
      if (!commit || (await git(cwd, ['rev-parse', 'HEAD'])).trim() !== commit || (await git(cwd, ['status', '--porcelain'])).trim()) throw blocked('Publication requires clean verified commit');
      const remote = (await git(root, ['remote', 'get-url', 'origin'])).trim();
      if (![ policy.remote, `git@github.com:${policy.repository}.git`, `https://github.com/${policy.repository}.git`, `https://github.com/${policy.repository}` ].filter(Boolean).includes(remote)) throw blocked('Unexpected origin');
      await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', `https://github.com/${policy.repository}.git`, `${commit}:refs/heads/factory/issue-${task.issueNumber}`], { cwd, env: await githubEnv() });
      const bodyFile = path.join(directory(task), 'pr-body.md');
      await fs.writeFile(bodyFile, `Implements #${task.issueNumber}.\n\nVerified commit: ${commit}\nIndependent acceptance and configured project checks passed.\nChecks: ${state.verification.evidence.checks.map(check => check.name).join(', ')}\nAcceptance source SHA-256: ${state.verification.evidence.acceptanceHash}\n`, { mode: 0o600 });
      await gh(['pr', 'create', '--repo', policy.repository, '--base', policy.baseBranch, '--head', `factory/issue-${task.issueNumber}`, '--title', task.title, '--body-file', bodyFile]);
      const publication = await this.reconcile(task, state);
      if (!publication) throw blocked('PR creation could not be read back');
      return publication;
    },
  };
}

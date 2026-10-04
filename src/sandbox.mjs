import { realpathSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, accessSync, constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const quote = JSON.stringify;

export function executable(name) {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    const path = join(directory, name);
    try { accessSync(path, constants.X_OK); return realpathSync(path); } catch {}
  }
  throw new Error(`Required executable unavailable: ${name}`);
}

function canonical(path) {
  try { return realpathSync(path); }
  catch { return join(realpathSync(dirname(path)), path.split('/').at(-1)); }
}

export function workerArgs({ workspace, writablePaths = [], readablePaths = [], denyPaths = [], runtimeExecutable }) {
  const entries = new Map([[':minimal', 'read'], [canonical(workspace), 'read'], [dirname(runtimeExecutable ?? executable('codex')), 'read']]);
  for (const path of readablePaths) entries.set(canonical(path), 'read');
  for (const path of writablePaths) entries.set(canonical(path), 'write');
  for (const path of denyPaths) entries.set(canonical(path), 'deny');
  const filesystem = [...entries].map(([path, access]) => `${quote(path)}=${quote(access)}`).join(',');
  return ['-c', 'default_permissions="factory"', '-c', `permissions.factory.filesystem={${filesystem}}`,
    '-c', 'permissions.factory.network.enabled=false'];
}

export function sandboxArgs(options) {
  return ['-P', 'factory', '--include-managed-config', ...workerArgs(options)];
}

export function cleanEnvironment(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: 'en_US.UTF-8',
    OPENSSL_CONF: '/dev/null',
    ...extra,
  };
}

// Exercise enforcement with synthetic data. A flag in a policy file cannot bypass this check.
export function preflightSandbox({ stateDir, codex = 'codex' }) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(resolve(stateDir), 'sandbox-probe-'));
  const workspace = join(root, 'workspace');
  const writable = join(workspace, 'editable');
  const hidden = join(root, 'private.txt');
  const protectedFile = join(workspace, 'protected.txt');
  mkdirSync(writable, { recursive: true });
  writeFileSync(hidden, 'synthetic-private-value');
  writeFileSync(protectedFile, 'unchanged');
  const source = `
    const fs = require('node:fs');
    const net = require('node:net');
    const assert = require('node:assert/strict');
    assert.equal(fs.readFileSync(${quote(protectedFile)}, 'utf8'), 'unchanged');
    fs.writeFileSync(${quote(join(writable, 'allowed.txt'))}, 'allowed');
    assert.throws(() => fs.writeFileSync(${quote(protectedFile)}, 'changed'));
    assert.throws(() => fs.readFileSync(${quote(hidden)}, 'utf8'));
    const socket = net.connect({host:'127.0.0.1', port:9});
    socket.once('connect', () => { console.error('NETWORK_WAS_ALLOWED'); process.exit(2); });
    socket.once('error', e => {
      assert.ok(['EPERM','EACCES'].includes(e.code), 'Network failure must be a policy denial, got '+e.code);
      console.log('FACTORY_SANDBOX_OK');
    });
    setTimeout(() => process.exit(3), 3000).unref();
  `;
  const result = spawnSync(codex, ['sandbox', ...sandboxArgs({ workspace, writablePaths: [writable],
    readablePaths: [dirname(realpathSync(process.execPath))] }), '--', process.execPath, '-e', source], {
    cwd: workspace, env: cleanEnvironment(), encoding: 'utf8', timeout: 15000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.error || result.status !== 0 || !output.includes('FACTORY_SANDBOX_OK') ||
      readFileSync(protectedFile, 'utf8') !== 'unchanged') {
    throw new Error(`Sandbox enforcement failed; factory remains stopped. ${result.error?.message ?? output.slice(-4000)}`);
  }
  return { enforced: true, node: process.version, checkedAt: new Date().toISOString() };
}

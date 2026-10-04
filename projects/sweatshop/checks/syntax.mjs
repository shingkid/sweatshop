import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

assert.ok(process.env.FACTORY_WORKSPACE, 'FACTORY_WORKSPACE is required');
const cwd = resolve(process.env.FACTORY_WORKSPACE);
for (const file of readdirSync(join(cwd, 'src')).filter(file => file.endsWith('.mjs')).sort()) {
  const result = spawnSync(process.execPath, ['--check', join('src', file)], { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

assert.ok(process.env.FACTORY_WORKSPACE, 'FACTORY_WORKSPACE is required');
const cwd = resolve(process.env.FACTORY_WORKSPACE);
const files = readdirSync(join(cwd, 'src')).filter(file => file.endsWith('.test.mjs')).sort().map(file => join('src', file));
assert.ok(files.length, 'Candidate regression tests are required');
const result = spawnSync(process.execPath, ['--test', ...files], { cwd, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);

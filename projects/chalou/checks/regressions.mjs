import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const files = [...new Set([...JSON.parse(process.env.FACTORY_BASELINE_FILES), ...JSON.parse(process.env.FACTORY_CHANGED_FILES)])]
  .filter(file => /^tests\/.*\.test\.(?:mjs|js|ts)$/.test(file) && existsSync(join(process.env.FACTORY_WORKSPACE, file)));
if (!files.length) {
  console.log('No native Node regression tests are present in this Chalou snapshot.');
} else {
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd: process.env.FACTORY_WORKSPACE, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

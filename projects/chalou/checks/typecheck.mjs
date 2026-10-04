import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const compiler = join(process.env.FACTORY_SOURCE, 'node_modules/typescript/bin/tsc');
if (!existsSync(compiler)) throw new Error('Trusted TypeScript dependency unavailable');
const sources = JSON.parse(process.env.FACTORY_CHANGED_FILES).filter(file => file.endsWith('.ts') && existsSync(join(process.env.FACTORY_WORKSPACE, file)));
if (!sources.length) throw new Error('No TypeScript changes to verify for Chalou');
const result = spawnSync(process.execPath, [compiler, '--ignoreConfig', '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', ...sources], { cwd: process.env.FACTORY_WORKSPACE, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);

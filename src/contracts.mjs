import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
const exactKeys = (value, keys) => {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Expected a JSON object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown field: ${key}`);
  for (const key of keys) if (!(key in value)) throw new Error(`Missing field: ${key}`);
};
const safePath = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\/?$/.test(value) && !value.split('/').some(part => ['.', '..', '.git'].includes(part));
const directory = value => safePath(value) && value.endsWith('/');
export const acceptanceAllowed = (value, id) => typeof value === 'string' && new RegExp(`^projects/${id}/acceptance/[a-zA-Z0-9_-]+\\.test\\.mjs$`).test(value);
const accountName = value => typeof value === 'string' && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(value);
const validArgument = value => typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value) && !/[{}]/.test(value.replace(/\{(?:node|repo|workspace|project)\}/g, ''));

export function validatePolicy(policy) {
  exactKeys(policy, ['version', 'id', 'repository', 'account', 'remote', 'baseBranch', 'eligibleLabel', 'allowedPaths', 'protectedPaths', 'checks', 'maxAttempts', 'maxDurationMs', 'workerTimeoutMs', 'checkTimeoutMs', 'maxTasksPerTick']);
  if (policy.version !== 1 || typeof policy.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(policy.id)) throw new Error('Invalid project identity or version');
  const parts = typeof policy.repository === 'string' ? policy.repository.split('/') : [];
  if (parts.length !== 2 || !accountName(parts[0]) || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(parts[1]) || !accountName(policy.account)) throw new Error('Invalid GitHub identity');
  const remote = typeof policy.remote === 'string' && policy.remote.match(/^(?:git@[a-zA-Z0-9.-]+:|https:\/\/github\.com\/)([^\s]+?)(?:\.git)?$/);
  if (!remote || remote[1] !== policy.repository) throw new Error('Remote must name the configured repository');
  if (!safePath(policy.baseBranch) || policy.baseBranch.endsWith('/') || policy.baseBranch.includes('..') || policy.baseBranch.endsWith('.lock') || policy.baseBranch.endsWith('.') || typeof policy.eligibleLabel !== 'string' || !policy.eligibleLabel.trim() || /[\x00-\x1f\x7f]/.test(policy.eligibleLabel)) throw new Error('Invalid branch or eligible label');
  for (const key of ['allowedPaths', 'protectedPaths']) if (!Array.isArray(policy[key]) || (key === 'allowedPaths' && !policy[key].length) || policy[key].some(path => !directory(path))) throw new Error(`Invalid ${key}: expected safe directory prefixes`);
  if (!Array.isArray(policy.checks) || !policy.checks.length) throw new Error('Checks must be nonempty');
  const names = new Set();
  for (const check of policy.checks) {
    exactKeys(check, ['name', 'command', 'args', 'readablePaths']);
    if (typeof check.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(check.name) || names.has(check.name)) throw new Error('Invalid or duplicate check name');
    names.add(check.name);
    if (!validArgument(check.command) || !/^(?:\{node\}|[a-zA-Z0-9_./-]+|\{(?:repo|workspace|project)\}\/[a-zA-Z0-9_./-]+)$/.test(check.command)) throw new Error('Invalid check executable');
    if (!Array.isArray(check.args) || !check.args.every(validArgument)) throw new Error('Invalid check arguments');
    if (!Array.isArray(check.readablePaths) || check.readablePaths.some(path => typeof path !== 'string' || !/^\{(?:repo|project)\}\//.test(path) || !safePath(path.replace(/^\{(?:repo|project)\}\//, '')))) throw new Error('Invalid check readablePaths');
  }
  const bounds = { maxAttempts: 2, maxDurationMs: 1800000, workerTimeoutMs: 600000, checkTimeoutMs: 120000, maxTasksPerTick: 1 };
  for (const [key, maximum] of Object.entries(bounds)) if (!Number.isInteger(policy[key]) || policy[key] < 1 || policy[key] > maximum) throw new Error(`Invalid ${key}`);
  return policy;
}

export function validateContract(contract, issue, acceptanceBytes, policy) {
  exactKeys(contract, ['version', 'issueNumber', 'baseSha', 'titleHash', 'bodyHash', 'allowedPaths', 'acceptancePath', 'acceptanceHash']);
  if (contract.version !== 1 || !Number.isSafeInteger(contract.issueNumber) || contract.issueNumber < 1 || contract.issueNumber !== issue.number) throw new Error('Task identity mismatch');
  if (!/^[a-f0-9]{40}$/.test(contract.baseSha) || ![contract.titleHash, contract.bodyHash, contract.acceptanceHash].every(value => /^[a-f0-9]{64}$/.test(value))) throw new Error('Invalid immutable task hashes');
  if (hash(issue.title ?? '') !== contract.titleHash) throw new Error('Issue title changed after approval');
  if (hash(issue.body ?? '') !== contract.bodyHash) throw new Error('Issue requirements changed after approval');
  if (hash(acceptanceBytes) !== contract.acceptanceHash) throw new Error('Acceptance test changed after approval');
  if (!Array.isArray(contract.allowedPaths) || !contract.allowedPaths.length || contract.allowedPaths.some(path => !directory(path) || !policy.allowedPaths.some(prefix => path.startsWith(prefix)))) throw new Error('Task paths exceed project policy');
  if (!acceptanceAllowed(contract.acceptancePath, policy.id)) throw new Error('Acceptance test must be a protected single file');
  if (issue.state !== 'OPEN' || !issue.labels.some(label => label.name === policy.eligibleLabel)) throw new Error('Issue is not ready for the factory');
  return contract;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hash, validateContract, validatePolicy } from './contracts.mjs';

const policy = JSON.parse(readFileSync(new URL('../projects/chalou/project.json', import.meta.url)));
const issue = { number: 7, title: 'Specified task', body: 'Specified behavior', state: 'OPEN', labels: [{ name: 'ready-for-agent' }] };
const acceptance = 'independent test bytes';
const fixture = () => ({ version: 1, issueNumber: 7, baseSha: 'a'.repeat(40), titleHash: hash(issue.title), bodyHash: hash(issue.body), allowedPaths: ['src/domain/'], acceptancePath: 'projects/chalou/acceptance/issue-7.test.mjs', acceptanceHash: hash(acceptance) });

test('accepts the bounded project policy and approved requirements', () => {
  assert.equal(validatePolicy(policy), policy);
  assert.equal(validateContract(fixture(), issue, acceptance, policy).issueNumber, 7);
});
test('rejects typo fields and omitted controls', () => {
  assert.throws(() => validatePolicy({ ...policy, maxAttemps: 30 }), /Unknown field/);
  assert.throws(() => validateContract({ ...fixture(), dependson: [] }, issue, acceptance, policy), /Unknown field/);
  const missing = fixture(); delete missing.acceptanceHash;
  assert.throws(() => validateContract(missing, issue, acceptance, policy), /Missing field/);
});
test('rejects changed requirements and weakened acceptance bytes', () => {
  assert.throws(() => validateContract(fixture(), { ...issue, title: 'Changed' }, acceptance, policy), /title changed/);
  assert.throws(() => validateContract(fixture(), { ...issue, body: 'Changed' }, acceptance, policy), /requirements changed/);
  assert.throws(() => validateContract(fixture(), issue, 'weaker test', policy), /test changed/);
});
test('rejects paths outside the project and traversal', () => {
  for (const path of ['.github/', 'supabase/', 'src/domain/../../', 'src/domain/./', 'src/domainish/', 'src/domain/file.ts']) {
    assert.throws(() => validateContract({ ...fixture(), allowedPaths: [path] }, issue, acceptance, policy), /Task paths/);
  }
  assert.throws(() => validateContract({ ...fixture(), acceptancePath: '../../private' }, issue, acceptance, policy), /Acceptance test/);
});
test('requires the issue to remain explicitly eligible', () => {
  assert.throws(() => validateContract(fixture(), { ...issue, labels: [] }, acceptance, policy), /not ready/);
  assert.throws(() => validateContract(fixture(), { ...issue, state: 'CLOSED' }, acceptance, policy), /not ready/);
});
test('rejects unbounded retry/time or changed destination', () => {
  for (const [key, value] of [['maxAttempts', 3], ['maxDurationMs', 0], ['maxDurationMs', 1800001], ['maxTasksPerTick', 5], ['remote', 'https://example.com/chalou']]) {
    assert.throws(() => validatePolicy({ ...policy, [key]: value }));
  }
});

test('supports an independent project and arbitrary bounded paths', () => {
  const second = { ...policy, id: 'ledger', repository: 'Another-Org/accounting', account: 'automation-bot', remote: 'git@company-alias:Another-Org/accounting.git', allowedPaths: ['packages/ledger/'], protectedPaths: ['test-fixtures/'] };
  assert.equal(validatePolicy(second), second);
  const contract = { ...fixture(), allowedPaths: ['packages/ledger/core/'], acceptancePath: 'projects/ledger/acceptance/issue-7.test.mjs' };
  assert.equal(validateContract(contract, issue, acceptance, second), contract);
  assert.throws(() => validateContract(fixture(), issue, acceptance, second));
});
test('rejects malformed identities, prefixes and checks', () => {
  for (const [key, values] of Object.entries({ id: ['..', 'other/project', 'Foo'], account: ['bad/name', '-bot'], repository: ['../repo', 'org/repo/extra'], remote: ['git@host:other/repo.git', 'https://example.com/shingkid/chalou.git'], allowedPaths: [['../src/'], ['src/.git/'], ['src//lib/'], ['./src/']], protectedPaths: [['/tests/'], ['tests/../']] })) {
    for (const value of values) assert.throws(() => validatePolicy({ ...policy, [key]: value }), `${key}: ${value}`);
  }
  for (const check of [{ name: 'x', command: 'node && curl evil', args: [], readablePaths: [] }, { name: 'x', command: '{node}', args: ['{unknown}'], readablePaths: [] }, { name: 'x', command: '{node}', args: [], readablePaths: ['{repo}/../secret'] }, { name: 'x', command: '{node}', args: [], readablePaths: ['{workspace}/src'] }]) assert.throws(() => validatePolicy({ ...policy, checks: [check] }));
  assert.throws(() => validatePolicy({ ...policy, checks: [] }));
});

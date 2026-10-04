import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export class ControlConflict extends Error {}
const fail = message => { throw new ControlConflict(message); };
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const exactFile = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(value) && !value.split('/').some(part => ['.', '..', '.git'].includes(part));

// Canonical JSON makes retries independent of object property order.
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  fail('Expected finite JSON evidence');
}

function validateContract(contract) {
  if (!contract || !identifier(contract.projectId) || !identifier(contract.contractId)) fail('Invalid contract identity');
  for (const key of ['baselineSha', 'controllerSha']) if (!sha(contract[key])) fail(`Invalid ${key}`);
  if (typeof contract.acceptanceSha !== 'string' || !/^[a-f0-9]{64}$/.test(contract.acceptanceSha)) fail('Invalid acceptanceSha');
  if (!Array.isArray(contract.allowedFiles) || !contract.allowedFiles.length || !contract.allowedFiles.every(exactFile) || new Set(contract.allowedFiles).size !== contract.allowedFiles.length) fail('Expected unique exact allowed files');
  if (!Number.isInteger(contract.maxAttempts) || contract.maxAttempts < 1 || contract.maxAttempts > 2) fail('Maximum attempts must be 1 or 2');
  if (contract.deadlineAt !== undefined && (!Number.isSafeInteger(contract.deadlineAt) || contract.deadlineAt < 1)) fail('Invalid deadline');
  const maxDurationMs = contract.maxDurationMs ?? 1800000;
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 1800000) fail('Invalid duration');
  return JSON.parse(canonicalJson({ ...contract, maxDurationMs }));
}

// This is a trusted local interface. The HTTP layer must authenticate each role.
// A complete attempt records an executor report, not independent goal acceptance.
export class ControlStore {
  constructor({ databasePath, contracts, clock = Date.now }) {
    if (!Array.isArray(contracts) || !contracts.length) fail('Preconfigured contracts are required');
    const configured = contracts.map(validateContract);
    if (new Set(configured.map(item => item.projectId)).size !== configured.length) fail('Only one contract per project is permitted');
    this.clock = clock;
    this.projects = new Set(configured.map(item => item.projectId));
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec(`PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS control_goals (project_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS control_contracts (project_id TEXT PRIMARY KEY, contract_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS control_attempts (
          attempt_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, generation INTEGER NOT NULL,
          operation_id TEXT UNIQUE NOT NULL, native_identity TEXT UNIQUE, attempt_json TEXT NOT NULL,
          UNIQUE(project_id, generation));`);
      this.transaction(() => {
        for (const contract of configured) {
          const saved = this.db.prepare('SELECT contract_json FROM control_contracts WHERE project_id = ?').get(contract.projectId);
          const encoded = canonicalJson(contract);
          if (saved && saved.contract_json !== encoded) fail('Configured contract differs from immutable stored contract');
          if (!saved) this.db.prepare('INSERT INTO control_contracts VALUES (?, ?)').run(contract.projectId, encoded);
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  contract(projectId, contractId) {
    if (!this.projects.has(projectId)) fail('Project is not configured');
    const contract = JSON.parse(this.db.prepare('SELECT contract_json FROM control_contracts WHERE project_id = ?').get(projectId).contract_json);
    if (contractId !== undefined && contract.contractId !== contractId) fail('Contract identity mismatch');
    return contract;
  }

  attempts(projectId) {
    return this.db.prepare('SELECT attempt_json FROM control_attempts WHERE project_id = ? ORDER BY generation').all(projectId).map(row => JSON.parse(row.attempt_json));
  }

  deadline(contract) {
    const goal = this.db.prepare('SELECT started_at FROM control_goals WHERE project_id = ?').get(contract.projectId);
    return Math.min(contract.deadlineAt ?? Infinity, goal ? goal.started_at + contract.maxDurationMs : Infinity);
  }

  executionView(attempt, contract, firstAdmission = false) {
    return { ...attempt, mayExecute: firstAdmission && attempt.state === 'registered' && attempt.admitted === true && this.now() < this.deadline(contract) };
  }

  status(projectId) {
    const contract = this.contract(projectId);
    const attempts = this.attempts(projectId).map(attempt => this.executionView(attempt, contract));
    const startedAt = this.db.prepare('SELECT started_at FROM control_goals WHERE project_id = ?').get(projectId)?.started_at ?? null;
    return { contract, startedAt, deadlineAt: Number.isFinite(this.deadline(contract)) ? this.deadline(contract) : null, attempts, currentAttempt: attempts.at(-1) ?? null, expired: this.now() >= this.deadline(contract) };
  }

  now() {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) fail('Invalid clock value');
    return now;
  }

  save(attempt) {
    const nativeIdentity = attempt.nativeTaskId === null ? null : canonicalJson([attempt.executor, attempt.nativeTaskId]);
    this.db.prepare('UPDATE control_attempts SET native_identity = ?, attempt_json = ? WHERE attempt_id = ?').run(nativeIdentity, canonicalJson(attempt), attempt.attemptId);
    return attempt;
  }

  // Submission permission is transient. A replay cannot authorize another task.
  reserve({ projectId, contractId, operationId, executor }) {
    return this.transaction(() => {
      const contract = this.contract(projectId, contractId);
      if (!identifier(operationId) || !['cloud', 'local'].includes(executor)) fail('Invalid operation or executor');
      const previous = this.db.prepare('SELECT attempt_json FROM control_attempts WHERE operation_id = ?').get(operationId);
      if (previous) {
        const attempt = JSON.parse(previous.attempt_json);
        if (attempt.projectId !== projectId || attempt.contractId !== contractId || attempt.executor !== executor) fail('Operation identity mismatch');
        return { ...attempt, maySubmit: false };
      }
      const attempts = this.attempts(projectId);
      const current = attempts.at(-1);
      if (current && (current.state !== 'failed' || current.stopped !== true)) fail('Current attempt blocks new reservation');
      if (attempts.length >= contract.maxAttempts) fail('Attempt limit reached');
      const now = this.now();
      if (now >= this.deadline(contract)) fail('Contract deadline reached');
      const attempt = { projectId, contractId, operationId, executor, attemptId: randomUUID(), generation: attempts.length + 1, state: 'reserved', nativeTaskId: null, runnerId: null, admitted: false, reservedAt: now, updatedAt: now, stopped: false, evidence: null };
      this.db.prepare('INSERT INTO control_attempts VALUES (?, ?, ?, ?, NULL, ?)').run(attempt.attemptId, projectId, attempt.generation, operationId, canonicalJson(attempt));
      return { ...attempt, maySubmit: true };
    });
  }

  bound(binding) {
    const contract = this.contract(binding.projectId, binding.contractId);
    const current = this.attempts(binding.projectId).at(-1);
    if (!current || current.attemptId !== binding.attemptId || current.generation !== binding.generation || current.contractId !== binding.contractId) fail('Stale or mismatched attempt binding');
    return { contract, attempt: current };
  }

  markUnknown(binding) {
    return this.transaction(() => {
      const { attempt } = this.bound(binding);
      if (attempt.state !== 'reserved') return attempt;
      return this.save({ ...attempt, state: 'unknown', updatedAt: this.now() });
    });
  }

  // Only the first registration can admit execution. A lost response fails closed.
  // Reconciliation can retain identity after expiry, but cannot authorize execution.
  register(binding) {
    return this.transaction(() => {
      const { contract, attempt } = this.bound(binding);
      if (!identifier(binding.runnerId)) fail('Invalid runner identity');
      if (!identifier(binding.nativeTaskId)) fail('Invalid native task identity');
      if (attempt.nativeTaskId !== null) {
        if (attempt.nativeTaskId !== binding.nativeTaskId || attempt.runnerId !== binding.runnerId) fail('Attempt already has a different native task or runner');
        return this.executionView(attempt, contract);
      }
      if (!['reserved', 'unknown'].includes(attempt.state)) fail('Attempt cannot register a native task');
      const now = this.now();
      const admitted = now < this.deadline(contract);
      if (admitted) this.db.prepare('INSERT OR IGNORE INTO control_goals VALUES (?, ?)').run(contract.projectId, now);
      const saved = this.save({ ...attempt, nativeTaskId: binding.nativeTaskId, runnerId: binding.runnerId, admitted, state: 'registered', updatedAt: now });
      return this.executionView(saved, contract, true);
    });
  }

  finish(binding) {
    return this.transaction(() => {
      const { contract, attempt } = this.bound(binding);
      if (!attempt.nativeTaskId || binding.nativeTaskId !== attempt.nativeTaskId || binding.runnerId !== attempt.runnerId) fail('Native task identity mismatch');
      if (!['complete', 'failed'].includes(binding.outcome)) fail('Invalid terminal outcome');
      if (binding.stopped !== true) fail('Trusted stopped confirmation is required');
      const evidence = JSON.parse(canonicalJson(binding.evidence));
      for (const key of ['baselineSha', 'controllerSha', 'acceptanceSha']) if (evidence?.[key] !== contract[key]) fail(`Evidence ${key} mismatch`);
      if (!sha(evidence.candidateSha) || canonicalJson(evidence.allowedFiles) !== canonicalJson(contract.allowedFiles)) fail('Evidence candidate or allowed files mismatch');
      if (['complete', 'failed'].includes(attempt.state)) {
        if (binding.outcome !== attempt.state || canonicalJson(evidence) !== canonicalJson(attempt.evidence)) fail('Terminal evidence differs');
        return attempt;
      }
      if (attempt.state !== 'registered') fail('Native task registration is required');
      // The scheduling deadline stops admission, not evidence from admitted work.
      if (binding.outcome === 'complete' && !attempt.admitted) fail('Attempt was not admitted before the contract deadline');
      return this.save({ ...attempt, state: binding.outcome, stopped: true, evidence, updatedAt: this.now() });
    });
  }

  close() { this.db.close(); }
}

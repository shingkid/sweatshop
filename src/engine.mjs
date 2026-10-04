import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function taskFingerprint(task) {
  return fingerprint(task);
}

const validCommit = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const errorText = error => error instanceof Error ? error.message : String(error);

function publicationError(publication, verification) {
  if (!validCommit(verification?.commit)) return 'Missing immutable verified commit';
  if (!publication || publication.commit !== verification.commit) return 'Published commit does not match verified commit';
  try {
    const url = new URL(publication.url);
    if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) return null;
  } catch { /* Report the same invalid URL error below. */ }
  return 'Missing valid HTTPS pull request URL';
}

/** Durable coordinator. Adapter output is evidence, never an authoritative success flag. */
export async function runTask({ task, state = null, save, adapter, limits = {} }) {
  const { now = Date.now, ...configuration } = limits;
  const config = { maxAttempts: 2, maxDurationMs: 1_800_000, ...configuration };
  if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1 ||
      !Number.isFinite(config.maxDurationMs) || config.maxDurationMs <= 0) {
    throw new Error('Invalid factory limits');
  }
  const contract = taskFingerprint(task);
  const configFingerprint = fingerprint(config);
  let current = state ? structuredClone(state) : {
    version: 1, taskFingerprint: contract, configFingerprint,
    stage: 'pending', attempt: 0, startedAt: now(), history: [],
  };
  const checkpoint = async () => {
    await save(structuredClone(current));
  };
  const record = (kind, detail) => current.history.push({ at: now(), kind, detail });
  const block = async reason => {
    current.stage = 'blocked';
    current.reason = reason;
    record('blocked', reason);
    await checkpoint();
    return current;
  };
  const expired = () => now() - current.startedAt >= config.maxDurationMs;
  const invoke = name => adapter[name](task, structuredClone(current));
  const retry = async (kind, error) => {
    record(kind, errorText(error));
    current.stage = 'pending';
    delete current.verification;
    delete current.publication;
    await checkpoint();
  };
  const finish = async publication => {
    const invalid = publicationError(publication, current.verification);
    if (invalid) return block(invalid);
    if (expired()) return block('Maximum task duration exceeded');
    current.publication = publication;
    current.stage = 'complete';
    record('complete', publication);
    await checkpoint();
    return current;
  };
  const reconcile = async () => {
    let publication;
    try {
      publication = await invoke('reconcile');
    } catch (error) {
      return block(`Publication reconciliation failed: ${errorText(error)}`);
    }
    if (!publication) return block('Publication outcome unknown; operator reconciliation required');
    return finish(publication);
  };

  // Reject persisted schema/contract changes even for terminal records.
  if (current.version !== 1 || !Array.isArray(current.history) ||
      !Number.isInteger(current.attempt) || current.attempt < 0 ||
      !Number.isFinite(current.startedAt)) {
    throw new Error('Invalid persisted factory state');
  }
  if (current.taskFingerprint !== contract || current.configFingerprint !== configFingerprint) {
    return block('Task contract or factory policy/configuration changed');
  }
  if (current.stage === 'blocked') return current;
  if (current.stage === 'complete') {
    const invalid = publicationError(current.publication, current.verification);
    return invalid ? block(invalid) : current;
  }
  if (!['pending', 'working', 'verifying', 'publishing'].includes(current.stage)) {
    return block('Unknown persisted factory stage');
  }
  if (!state) await checkpoint();

  // Recovery must first establish that an interrupted worker cannot still mutate.
  if (current.stage === 'working') {
    try {
      await invoke('recover');
    } catch (error) {
      return block(`Worker recovery failed: ${errorText(error)}`);
    }
    await retry('recovered', 'Interrupted worker stopped; previous verification discarded');
  }
  // Publishing is deliberately never replayed after an interruption.
  if (current.stage === 'publishing') return reconcile();

  while (true) {
    if (expired()) return block('Maximum task duration exceeded');
    if (current.stage === 'pending') {
      if (current.attempt >= config.maxAttempts) return block('Maximum work attempts exhausted');
      let prepared;
      try {
        prepared = await invoke('prepare');
        if (!prepared?.workspace || !validCommit(prepared.baseSha) || prepared.baseSha !== task.baseSha) {
          throw new Error('Preparation did not establish the approved base and workspace');
        }
      } catch (error) {
        return block(`Workspace preparation failed: ${errorText(error)}`);
      }
      Object.assign(current, { workspace: prepared.workspace, baseSha: prepared.baseSha });
      if (expired()) return block('Maximum task duration exceeded');
      current.attempt += 1;
      current.stage = 'working';
      delete current.workerEvidence;
      record('attempt', current.attempt);
      await checkpoint();
      let result;
      try {
        result = await invoke('work');
      } catch (error) {
        await retry('work-failed', error);
        continue;
      }
      current.workerEvidence = result?.workerEvidence ?? null;
      record('worker-evidence', current.workerEvidence);
      current.stage = 'verifying';
      await checkpoint();
    }
    if (expired()) return block('Maximum task duration exceeded');
    let verification;
    try {
      verification = await invoke('verify');
      if (!validCommit(verification?.commit)) throw new Error('Verification missing immutable commit');
    } catch (error) {
      await retry('verify-failed', error);
      continue;
    }
    current.verification = verification;
    record('verified', verification);
    if (expired()) return block('Maximum task duration exceeded');
    current.stage = 'publishing';
    await checkpoint();
    let publication;
    try {
      publication = await invoke('publish');
      const invalid = publicationError(publication, verification);
      if (invalid) throw new Error(invalid);
    } catch (error) {
      record('publish-failed', errorText(error));
      await checkpoint();
      return reconcile();
    }
    return finish(publication);
  }
}

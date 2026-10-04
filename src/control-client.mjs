export class ControlRequestError extends Error {
  constructor(message, { status, outcomeUnknown = false } = {}) {
    super(message);
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
  }
}

export function createControlClient({ url, token, projectId, timeoutMs = 10000 }) {
  const base = new URL(url);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && local))) throw new Error('Use an HTTPS control origin or loopback HTTP');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectId) || typeof token !== 'string' || token.length < 32 || /\s/.test(token)) throw new Error('Invalid scoped client configuration');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid request timeout');
  const prefix = '/v1/projects/' + projectId;
  async function request(path, body) {
    const mutation = body !== undefined;
    let response, value;
    try {
      response = await fetch(new URL(prefix + path, base), {
        method: mutation ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: 'Bearer ' + token, ...(mutation ? { 'Content-Type': 'application/json' } : {}) },
        ...(mutation ? { body: JSON.stringify(body) } : {}),
      });
      value = await response.json();
    } catch {
      throw new ControlRequestError('Control response unavailable; reconcile before another submission', { outcomeUnknown: mutation });
    }
    if (!response.ok) throw new ControlRequestError(value.error ?? 'Control request failed', {
      status: response.status, outcomeUnknown: mutation && (response.status >= 500 || response.status < 400),
    });
    return value;
  }
  const path = attempt => {
    if (!/^[0-9a-f-]{36}$/.test(attempt.attemptId)) throw new Error('Invalid attempt identifier');
    return '/attempts/' + attempt.attemptId;
  };
  const binding = attempt => ({ contractId: attempt.contractId, generation: attempt.generation });
  return {
    status: () => request(''),
    reserve: body => request('/reservations', body),
    markUnknown: attempt => request(path(attempt) + '/unknown', binding(attempt)),
    register: (attempt, body) => request(path(attempt) + '/register', { ...binding(attempt), ...body }),
    finish: (attempt, body) => request(path(attempt) + '/finish', { ...binding(attempt), ...body }),
  };
}

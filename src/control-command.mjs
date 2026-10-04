#!/usr/bin/env node
import { createControlClient } from './control-client.mjs';

// Use an environment credential and one complete JSON input, never command-line secrets.
async function main() {
  const [action, ...extra] = process.argv.slice(2);
  if (extra.length || !['status', 'reserve', 'unknown', 'register', 'finish'].includes(action)) {
    throw new Error('Usage: control-command.mjs status|reserve|unknown|register|finish');
  }
  const client = createControlClient({
    url: process.env.SWEATSHOP_CONTROL_URL,
    projectId: process.env.SWEATSHOP_PROJECT,
    token: process.env.SWEATSHOP_CONTROL_TOKEN,
  });
  let result;
  if (action === 'status') result = await client.status();
  else {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 65536) throw new Error('Input exceeds 64 KiB');
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('Expected a JSON object');
    if (action === 'reserve') result = await client.reserve(body);
    else if (action === 'unknown') result = await client.markUnknown(body);
    else {
      const { attemptId, contractId, generation, ...details } = body;
      result = await client[action]({ attemptId, contractId, generation }, details);
    }
  }
  console.log(JSON.stringify(result));
}

main().catch(error => {
  console.error(JSON.stringify({ error: error.message, outcomeUnknown: error.outcomeUnknown === true, ...(error.status ? { status: error.status } : {}) }));
  process.exitCode = error.outcomeUnknown ? 2 : 1;
});

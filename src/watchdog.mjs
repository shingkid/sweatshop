#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';

// Only a detached process-group leader may use this wrapper: every group signal
// below targets the group created for this invocation, never the caller's group.
const [timeoutText, parentText, command, ...args] = process.argv.slice(2);
const timeout = Number(timeoutText);
const parent = Number(parentText);
let group;
try {
  group = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
} catch {
  process.exit(125);
}
if (group !== process.pid || !Number.isSafeInteger(timeout) || timeout <= 0 ||
    !Number.isSafeInteger(parent) || parent <= 1 || process.ppid !== parent || !command) {
  process.exit(125);
}

const killGroup = () => {
  try { process.kill(-process.pid, 'SIGKILL'); }
  catch { process.exit(125); }
};
const deadline = setTimeout(killGroup, Math.min(timeout, 2_147_483_647));
const parentCheck = setInterval(() => {
  if (process.ppid !== parent) return killGroup();
  try { process.kill(parent, 0); }
  catch (error) { if (error.code === 'ESRCH') killGroup(); }
}, 100);

const child = spawn(command, args, { detached: false, stdio: 'inherit', env: process.env });
let finished = false;
const finish = (code, signal) => {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  clearInterval(parentCheck);
  // Preserve the command's exit status while terminating remaining group members.
  // A process that deliberately creates another session requires OS sandbox limits.
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' }).trim().split('\n');
    for (const row of rows) {
      const [pid, pgid] = row.trim().split(/\s+/).map(Number);
      if (pgid === process.pid && pid !== process.pid) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  } catch {
    killGroup();
    return;
  }
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 125);
};
child.once('error', () => finish(125));
child.once('exit', finish);

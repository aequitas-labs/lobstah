import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  appendStatus, claimBait, confirmTrapTitle, enqueue, ensureLayout, readStatusLog,
  readSessionClaim, readTrap, requestCancel, sendMessage, signOnTrap,
} from '@lobstah/core';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const session = 'delivery-trap';
const id = '11111111-1111-4111-8111-111111111111';
let home: string;
let trapId: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-park-delivery-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  const worktree = path.join(home, 'wt');
  fs.mkdirSync(worktree);
  const signed = signOnTrap({ worktree, cwd: worktree, repo: 'web', harness: 'codex', sessionId: session, ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('unexpected hold');
  trapId = signed.ok.trapId;
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});
const env = () => ({ ...process.env, LOBSTAH_HOME: home });
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], {
  cwd: home, encoding: 'utf8', env: env(), timeout: 15_000,
  input: JSON.stringify({ session_id: session }),
});
function enqueueBait() {
  enqueue({ id, repo: 'web', for: `wt:${trapId}`, brief: 'unique original task' });
}
function claimElsewhere() {
  enqueueBait();
  claimBait(readTrap(trapId)!);
}

it.each(['codex', 'claude'])('the %s Stop hook recovers a brief claimed by an exited waiter, without an inbox nudge', (harness) => {
  const reg = readTrap(trapId)!;
  signOnTrap({ ...reg, harness, ttlMs: 60_000 });
  claimElsewhere();
  const result = run('hook', 'stop', '--timeout', '0');
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ decision: 'block' });
  expect(result.stdout).toContain(`assigned dispatch ${id}`);
  expect(result.stdout).toContain('unique original task');
  expect(result.stdout).toContain('Acknowledge this assignment now');
  expect(readStatusLog(id, 'work')).toHaveLength(1);
});

it('recovers the brief through foreground soak too', () => {
  claimElsewhere();
  const result = run('soak', '--session', session, '--wait', '--timeout', '0');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('unique original task');
  expect(readStatusLog(id, 'work')).toHaveLength(1);
});

it('the Stop hook wakes a resumed session with its trap\'s original unreported claim', () => {
  claimElsewhere();
  const reg = readTrap(trapId)!;
  const claim = readSessionClaim(id, 'work');
  const resumed = signOnTrap({ ...reg, sessionId: 'resumed-trap', ttlMs: 60_000, now: Date.now() + 60_001 });
  if (!('ok' in resumed)) throw new Error('unexpected hold');
  const result = spawnSync(process.execPath, [cli, 'hook', 'stop', '--timeout', '0'], {
    cwd: home, encoding: 'utf8', env: env(), timeout: 15_000,
    input: JSON.stringify({ session_id: 'resumed-trap' }),
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ decision: 'block' });
  expect(result.stdout).toContain('unique original task');
  expect(readSessionClaim(id, 'work')).toEqual(claim);
  expect(readStatusLog(id, 'work')).toHaveLength(1);
});

it('keeps cancellation first, and includes unread steering with an unacknowledged brief', () => {
  claimElsewhere();
  sendMessage(id, 'work', 'steering from helm', 'helm');
  const steered = run('hook', 'stop', '--timeout', '0');
  expect(steered.stdout).toContain(`lobstah inbox ${id}`);
  expect(steered.stdout).toContain('unique original task');
  requestCancel(id, 'work');
  const cancelled = run('hook', 'stop', '--timeout', '0');
  expect(cancelled.stdout).toContain('was cancelled');
  expect(cancelled.stdout).not.toContain('unique original task');
});

it('does not re-deliver after the worker acknowledges, but still delivers its inbox', () => {
  claimElsewhere();
  appendStatus(id, 'work', 'working', 'starting', undefined, undefined, true);
  expect(run('hook', 'stop', '--timeout', '0').stdout).not.toContain('unique original task');
  sendMessage(id, 'work', 'new direction', 'helm');
  const result = run('hook', 'stop', '--timeout', '0');
  expect(result.stdout).toContain(`lobstah inbox ${id}`);
  expect(result.stdout).not.toContain('unique original task');
});

it('a foreground waiter cannot consume the only wake for an already parked Codex Stop hook', { timeout: 25_000 }, async () => {
  const child = spawn(process.execPath, [cli, 'hook', 'stop', '--timeout', '8'], { cwd: home, env: env(), stdio: 'pipe' });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', () => resolve());
  });
  child.stdin.end(JSON.stringify({ session_id: session }));
  try {
    const deadline = Date.now() + 8_000;
    while (!readTrap(trapId)?.parkedAt && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(readTrap(trapId)?.parkedAt).toBeDefined();
    enqueueBait();
    const foreground = run('soak', '--session', session, '--wait', '--timeout', '0');
    confirmTrapTitle(trapId);
    await exited;
    expect(foreground.status).toBe(0);
    expect(foreground.stdout).toContain('unique original task');
    expect(JSON.parse(stdout)).toMatchObject({ decision: 'block' });
    expect(stdout).toContain('unique original task');
    expect(readStatusLog(id, 'work')).toHaveLength(1);
  } finally {
    if (child.exitCode === null) { child.kill(); await exited; }
  }
});

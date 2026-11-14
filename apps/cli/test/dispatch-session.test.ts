import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  baitBrief, claimBait, enqueue, ensureLayout, loadConfig, needsFreshTrapSession,
  queuedDescriptor, readSessionClaim, sendMessage, signOnTrap, storedDescriptor,
} from '@lobstah/core';
import type { TrapSwapOptions } from '../src/trap-swap.js';
import type { Lane } from '@lobstah/core';
import { createTrapDispatchScheduler } from '../src/trap-dispatch.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-session-choice-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = ${JSON.stringify(home)}\n`);
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

function run(...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|CODEX|LOBSTAH_TRAP_TICKET)/.test(key)));
  return spawnSync(process.execPath, [cli, ...args], { env, cwd: home, encoding: 'utf8', timeout: 10_000 });
}
function trap(harness = 'claude') {
  const signed = signOnTrap({ worktree: home, cwd: home, repo: 'r', harness, sessionId: 'old-session', ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('held');
  return signed.ok;
}

it.each([
  [false, [], 'fresh'], [false, ['--trap-any'], 'fresh'], [true, [], 'continue'],
  [true, ['--fresh'], 'fresh'], [false, ['--continue'], 'continue'],
] as const)('stores the session choice (addressed: %s, flags: %j)', (addressed, flags, mode) => {
  const reg = trap();
  const result = run('dispatch', '--repo', 'r', '--id', 'job', '--brief-text', 'work',
    ...(addressed ? ['--for', `wt:${reg.trapId}`] : []), ...flags);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(queuedDescriptor('job', 'work')?.sessionMode).toBe(mode);
  expect(run('status', 'job').stdout).toContain(`sessionMode: ${mode}`);
  expect(run('man', 'tend').stdout).toContain(`${mode} session`);
});

it('rejects conflicting session flags before queuing work', () => {
  expect(run('dispatch', '--repo', 'r', '--id', 'job', '--brief-text', 'work', '--fresh', '--continue').status).not.toBe(0);
  expect(queuedDescriptor('job', 'work')).toBeUndefined();
});

it.each(['claude', 'codex'])('hands a fresh %s claim to the swap path once', async harness => {
  const reg = trap(harness);
  enqueue({ id: 'job', repo: 'r', brief: 'new work' });
  const caught = claimBait(reg)!;
  expect(needsFreshTrapSession(caught.descriptor)).toBe(true);
  sendMessage('job', 'work', 'keep this steering', 'helm');
  let finish!: () => void;
  const swap = vi.fn(async (_id: string, _lane: Lane, options: TrapSwapOptions) => {
    expect(options).toMatchObject({ harness, newDispatch: true });
    await new Promise<void>(resolve => { finish = resolve; });
    return {} as never;
  });
  const scheduler = createTrapDispatchScheduler({ swap });
  scheduler(loadConfig(), Date.now(), () => {});
  scheduler(loadConfig(), Date.now(), () => {});
  expect(swap).toHaveBeenCalledTimes(1);
  finish();
  await vi.waitFor(() => expect(swap).toHaveResolvedTimes(1));
});

it('keeps ordinary sends and addressed continuations on their current session', () => {
  const reg = trap();
  enqueue({ id: 'job', repo: 'r', brief: 'related work', for: `wt:${reg.trapId}` });
  expect(needsFreshTrapSession(claimBait(reg)!.descriptor)).toBe(false);
  const before = readSessionClaim('job', 'work');
  expect(run('send', 'job', 'continue here').status).toBe(0);
  const swap = vi.fn();
  createTrapDispatchScheduler({ swap })(loadConfig(), Date.now(), () => {});
  expect(swap).not.toHaveBeenCalled();
  expect(readSessionClaim('job', 'work')).toEqual(before);
  expect(storedDescriptor('job', 'work')?.sessionMode).toBe('continue');
});

it('keeps repair forks and follow-ups as continuations and starts fresh tasks on a new branch', () => {
  enqueue({ id: 'repair', repo: 'r', brief: 'repair', systemRepair: {} });
  enqueue({ id: 'follow', repo: 'r', brief: 'follow', followUp: 'repair' });
  expect(queuedDescriptor('repair', 'work')?.sessionMode).toBe('continue');
  expect(queuedDescriptor('follow', 'work')?.sessionMode).toBe('continue');
  expect(baitBrief('job', { id: 'job', repo: 'r', brief: 'new work', handoff: 'Git progress', handoffFreshBranch: true })).toContain('fresh branch');
});

it('withholds fresh work from the old listener, including when it has inbox steering', () => {
  const reg = trap();
  enqueue({ id: 'job', repo: 'r', brief: 'SECRET NEW TASK', for: `wt:${reg.trapId}`, sessionMode: 'fresh' });
  const first = run('soak', '--wait', '--timeout', '0', '--session', reg.sessionId);
  expect(first.stdout).not.toContain('SECRET NEW TASK');
  expect(readSessionClaim('job', 'work')?.sessionId).toBe(reg.sessionId);
  sendMessage('job', 'work', 'New steering', 'helm');
  const second = run('soak', '--wait', '--timeout', '0', '--session', reg.sessionId);
  expect(second.stdout).not.toContain('SECRET NEW TASK');
  expect(second.stdout).not.toContain('New instruction for your dispatch');
});

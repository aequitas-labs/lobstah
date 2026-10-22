import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claimBait, dropReservation, enqueue, ensureLayout, heartbeatTrap, listNotices, listReservations,
  loadConfig, queuedDescriptor, readTrap, reservationForTicket, signOnTrap, stowTrap,
} from '@lobstah/core';
import { tick } from '@lobstah/supervisor';
import { createTrapDispatchScheduler } from '../src/trap-dispatch.js';
import type { TerminalAdapter, TerminalLaunch } from '../src/throw.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const savedClaude = process.env.CLAUDE_CONFIG_DIR, savedCodex = process.env.CODEX_HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-trap-dispatch-'));
  process.env.LOBSTAH_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
  process.env.CODEX_HOME = path.join(home, 'codex');
  ensureLayout(); fs.mkdirSync(path.join(home, 'repo'));
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = '${path.join(home, 'repo')}'\ntraps = 2\n`);
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedClaude;
  if (savedCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedCodex;
  removeTempDir(home);
});
function trap(name: string, harness = 'claude', stowed = true) {
  const worktree = path.join(home, name); fs.mkdirSync(worktree);
  const result = signOnTrap({ name, harness, repo: 'r', worktree, cwd: worktree, sessionId: name, ttlMs: 60_000 });
  if (!('ok' in result)) throw new Error('held');
  heartbeatTrap(result.ok.trapId, { parked: true });
  if (harness === 'claude') {
    const transcript = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', worktree.replace(/[^A-Za-z0-9-]/g, '-'));
    fs.mkdirSync(transcript, { recursive: true }); fs.writeFileSync(path.join(transcript, `${name}.jsonl`), '{}\n');
  }
  if (stowed) stowTrap(result.ok.trapId);
  return result.ok;
}
const pass = (scheduler: ReturnType<typeof createTrapDispatchScheduler>) => tick(() => {}, { trapStarts: scheduler, spawnRunner: () => { throw new Error('trap-only work must never spawn headless'); } });
const failures = () => listNotices(100).filter(n => n.kind === 'trap-start-failed');
function ticket(launch: TerminalLaunch) {
  const token = /--ticket (\S+)/.exec(launch.argv.at(-1)!)![1]!;
  const r = reservationForTicket(token); if (!r) throw new Error('missing reservation');
  return r;
}

it('prefers a free listening trap of another harness instead of resuming a stowed trap', () => {
  trap('early-pebble'); const free = trap('open-swift', 'codex', false);
  const start = vi.fn();
  const scheduler = createTrapDispatchScheduler({ adapter: app => ({ app, launch: start }) });
  enqueue({ id: 'job', repo: 'r', brief: 'work', trapAny: true });
  pass(scheduler);
  expect(start).not.toHaveBeenCalled(); expect(listReservations()).toEqual([]);
  expect(queuedDescriptor('job', 'work')?.for).toBeUndefined();
  expect(claimBait(free)?.descriptor.for).toBe(`wt:${free.trapId}`);
});

it.each(['claude', 'codex'])('falls through after a %s sign-on timeout, including across a daemon restart', async harness => {
  const failed = trap('early-pebble', harness), next = trap('open-swift', harness === 'claude' ? 'codex' : 'claude');
  const started: string[] = [];
  const adapter = (app: TerminalAdapter['app']): TerminalAdapter => ({ app, launch: async launch => {
    const r = ticket(launch); started.push(r.trapId);
    if (r.trapId === failed.trapId) return; // Quota exhausted: terminal opens but no session signs on.
    const result = signOnTrap({ name: r.name, trapId: r.trapId, harness: r.harness!, repo: 'r', worktree: r.worktree!, cwd: r.worktree!, sessionId: 'resumed-' + r.trapId, ttlMs: 60_000 });
    if (!('ok' in result)) throw new Error('held');
    dropReservation(r.trapId); heartbeatTrap(r.trapId, { parked: true });
  } });
  const options = { adapter, timeoutSecs: 0.03, pollMs: 1 };
  const scheduler = createTrapDispatchScheduler(options);
  enqueue({ id: 'job', repo: 'r', brief: 'work', trapAny: true });
  pass(scheduler); pass(scheduler); // Starts never stall a daemon tick or launch twice.
  await vi.waitFor(() => expect(failures().some(n => n.refId === failed.trapId)).toBe(true));
  expect(failures().some(n => n.text.includes('early-pebble'))).toBe(true);
  expect(queuedDescriptor('job', 'work')?.for).toBeUndefined();
  const restarted = createTrapDispatchScheduler(options);
  pass(restarted);
  await vi.waitFor(() => expect(readTrap(next.trapId)?.sessionId).toBe('resumed-' + next.trapId));
  expect(started).toEqual([failed.trapId, next.trapId]);
  expect(claimBait(readTrap(next.trapId)!)?.id).toBe('job');
  expect(readTrap(failed.trapId)).toBeUndefined();
});

it('leaves exhausted work unaddressed and eligible for a listener that arrives later', async () => {
  const failed = trap('early-pebble');
  const launch = vi.fn(async (_launch: TerminalLaunch) => {});
  const options = { adapter: (app: TerminalAdapter['app']) => ({ app, launch }), timeoutSecs: 0.03, pollMs: 1 };
  const scheduler = createTrapDispatchScheduler(options);
  enqueue({ id: 'job', repo: 'r', brief: 'work', trapAny: true, harness: 'claude' }, 'chore');
  pass(scheduler);
  await vi.waitFor(() => expect(failures().some(n => n.refId === failed.trapId)).toBe(true));
  pass(createTrapDispatchScheduler(options));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(launch).toHaveBeenCalledTimes(1);
  expect(queuedDescriptor('job', 'chore')).toMatchObject({ trapAny: true, harness: 'claude' });
  expect(queuedDescriptor('job', 'chore')?.for).toBeUndefined();
  const wrong = trap('quiet-crab', 'codex', false);
  expect(claimBait(wrong)).toBeNull();
  const free = trap('zippy-gull', 'claude', false);
  expect(claimBait(free)?.id).toBe('job');
});


it('does not hot-loop fresh starts when no trap signs on, even after restarting the scheduler', async () => {
  const launch = vi.fn(async (_launch: TerminalLaunch) => {});
  const options = { adapter: (app: TerminalAdapter['app']) => ({ app, launch }), timeoutSecs: 0.03, pollMs: 1 };
  enqueue({ id: 'job', repo: 'r', brief: 'work', trapAny: true });
  pass(createTrapDispatchScheduler(options));
  await vi.waitFor(() => expect(failures().some(n => n.refId === 'job')).toBe(true));
  pass(createTrapDispatchScheduler(options));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(launch).toHaveBeenCalledTimes(1);
  expect(queuedDescriptor('job', 'work')?.for).toBeUndefined();
});


it('does not launch one stowed trap twice for overlapping unrestricted and harness-specific work', async () => {
  const reg = trap('early-pebble');
  const cfg = loadConfig(); cfg.repos.r!.traps = 1;
  const launch = vi.fn(async (command: TerminalLaunch) => {
    const r = ticket(command);
    const result = signOnTrap({ trapId: r.trapId, name: r.name, repo: 'r', harness: 'claude', worktree: r.worktree!, cwd: r.worktree!, sessionId: 'returned', ttlMs: 60_000 });
    if (!('ok' in result)) throw new Error('held');
    dropReservation(r.trapId); heartbeatTrap(r.trapId, { parked: true });
  });
  const scheduler = createTrapDispatchScheduler({ adapter: app => ({ app, launch }), timeoutSecs: 1, pollMs: 1 });
  enqueue({ id: 'any', repo: 'r', brief: 'work', trapAny: true });
  enqueue({ id: 'claude', repo: 'r', brief: 'work', trapAny: true, harness: 'claude' });
  scheduler(cfg, Date.now(), () => {});
  await vi.waitFor(() => expect(readTrap(reg.trapId)?.sessionId).toBe('returned'));
  expect(launch).toHaveBeenCalledTimes(1);
  expect(failures()).toEqual([]);
  expect(queuedDescriptor('any', 'work')?.for).toBeUndefined();
  expect(queuedDescriptor('claude', 'work')?.for).toBeUndefined();
});

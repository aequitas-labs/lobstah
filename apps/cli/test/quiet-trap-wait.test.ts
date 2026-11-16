import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendStatus, claimBait, enqueue, ensureLayout, readTrap, resetWaitBackoff, signOnTrap, stowTrap, sweepGhostTraps, sendMessage, unhandled, trapWorkingStop } from '@lobstah/core';
import { HOOK_PARK_MS, PARK_RENEWAL_REASON, soakPark } from '../src/trap-park.js';
import { stopChildren } from '../../../test/child-process.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-quiet-park-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\npark="block"\n');
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await stopChildren(children.splice(0));
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it('renews the hook before its harness deadline throughout a seven-day review, without ghosting or releasing the catch', async () => {
  vi.useFakeTimers();
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const worktree = path.join(home, 'review'); fs.mkdirSync(worktree);
  const signed = signOnTrap({ repo: 'r', worktree, cwd: worktree, harness: 'codex', sessionId: 'review-session', ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('held');
  const trapId = signed.ok.trapId;
  enqueue({ id: 'review', repo: 'r', for: `wt:${trapId}`, brief: 'Wait for review' });
  claimBait(signed.ok);
  appendStatus('review', 'work', 'paused', 'Waiting for review', undefined, undefined, true);
  for (let hour = 0; hour < 7 * 24; hour += 4) {
    const start = Date.now();
    const park = soakPark(trapId, undefined);
    // Activity can reset the idle deadline, but cannot extend this hook.
    vi.setSystemTime(start + HOOK_PARK_MS - 1000);
    resetWaitBackoff('review-session');
    await vi.advanceTimersByTimeAsync(1500);
    expect(await park).toBe('timeout');
    expect(Date.now() - start).toBeLessThan(14_500_000);
    expect(JSON.parse(output.mock.calls.at(-1)![0])).toEqual({ decision: 'block', reason: PARK_RENEWAL_REASON });
    expect(sweepGhostTraps(60_000, Date.now(), 86400_000)).toEqual([]);
    expect(readTrap(trapId)?.claimed).toBe('review');
  }
});

it.each(['claude', 'codex'])('%s Stop renews quiet deadlines without a model continuation, then bait wakes it', async harness => {
  const worktree = path.join(home, 'worktree'); fs.mkdirSync(worktree);
  const signed = signOnTrap({ repo: 'r', worktree, cwd: worktree, harness, sessionId: 'idle-session', ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('held');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|CODEX|LOBSTAH_TRAP_TICKET)/.test(key)));
  const child = spawn(process.execPath, [cli, 'hook', 'stop', '--timeout', '0.05'], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let output = ''; child.stdout!.on('data', chunk => { output += String(chunk); });
  child.stdin!.end(JSON.stringify({ session_id: 'idle-session', hook_event_name: 'Stop' }));
  for (let i = 0; i < 100 && !readTrap(signed.ok.trapId)?.idleSince; i++) await sleep(20);
  const before = readTrap(signed.ok.trapId)!;
  expect(before.idleSince).toBeDefined();
  await sleep(180); // Several complete quiet deadlines.
  expect(child.exitCode).toBeNull();
  expect(output).toBe(''); // No block JSON to request a model turn.
  expect(Date.parse(readTrap(signed.ok.trapId)!.heartbeatAt)).toBeGreaterThan(Date.parse(before.heartbeatAt));
  enqueue({ id: 'real-bait', repo: 'r', brief: 'Wake for this work', for: `wt:${signed.ok.trapId}` });
  await new Promise<void>(resolve => child.once('exit', () => resolve()));
  expect(JSON.parse(output)).toMatchObject({ decision: 'block' });
  expect(output).toContain('Wake for this work');
}, 10_000);

it('a plain listener stays in its process across quiet deadlines and exits on sign-off', async () => {
  const worktree = path.join(home, 'worktree'); fs.mkdirSync(worktree);
  const signed = signOnTrap({ repo: 'r', worktree, cwd: worktree, harness: 'claude', sessionId: 'idle-session', ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('held');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|CODEX|LOBSTAH_TRAP_TICKET)/.test(key)));
  const child = spawn(process.execPath, [cli, 'soak', '--wait', '--timeout', '0.05', '--session', 'idle-session'], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = ''; child.stdout!.on('data', chunk => { output += String(chunk); });
  for (let i = 0; i < 100 && !readTrap(signed.ok.trapId)?.idleSince; i++) await sleep(20);
  await sleep(180);
  expect(child.exitCode).toBeNull();
  expect(output).not.toContain('timeout: true');
  stowTrap(signed.ok.trapId, 'test sign-off');
  await new Promise<void>(resolve => child.once('exit', () => resolve()));
  expect(output).not.toContain('timeout: true');
}, 10_000);

it.each(['paused', 'needs-decision'] as const)('a Codex trap parked on %s returns a send arriving after the hook started', async verb => {
  const worktree = path.join(home, 'worktree'); fs.mkdirSync(worktree);
  const signed = signOnTrap({ repo: 'r', worktree, cwd: worktree, harness: 'codex', sessionId: 'steered-session', ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('held');
  enqueue({ id: 'steered', repo: 'r', brief: 'Do the work', for: `wt:${signed.ok.trapId}`, sessionMode: 'continue' });
  claimBait(signed.ok);
  appendStatus('steered', 'work', verb, 'waiting for feedback', undefined, undefined, true);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|CODEX|LOBSTAH_TRAP_TICKET)/.test(key)));
  const parkedBefore = readTrap(signed.ok.trapId)?.parkedAt;
  const child = spawn(process.execPath, [cli, 'hook', 'stop'], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let output = ''; child.stdout!.on('data', chunk => { output += String(chunk); });
  let errors = ''; child.stderr!.on('data', chunk => { errors += String(chunk); });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.stdin!.end(JSON.stringify({ session_id: 'steered-session', hook_event_name: 'Stop', turn_id: 'continued', stop_hook_active: true }));
  for (let i = 0; i < 100 && readTrap(signed.ok.trapId)?.parkedAt === parkedBefore; i++) await sleep(20);
  expect(readTrap(signed.ok.trapId)?.parkedAt).not.toBe(parkedBefore);
  expect(child.exitCode).toBeNull();
  const sent = spawnSync(process.execPath, [cli, 'send', 'steered', 'Use the approved option now', '--no-reply'], { cwd: home, env, encoding: 'utf8', timeout: 5000 });
  expect(sent.status, sent.stderr).toBe(0);
  expect(sent.stdout).toContain('delivered: inbox of steered');
  await exited;
  expect(output, errors + ' exit=' + child.exitCode).not.toBe('');
  expect(JSON.parse(output)).toMatchObject({ decision: 'block', reason: expect.stringContaining('Use the approved option now') });
  expect(unhandled('steered', 'work')).toHaveLength(1);
}, 10_000);

it('an inbox wake earns a new Codex working correction without another report', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const worktree = path.join(home, 'working'); fs.mkdirSync(worktree);
  const signed = signOnTrap({ repo: 'r', worktree, cwd: worktree, harness: 'codex', sessionId: 'working-session', ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('held');
  enqueue({ id: 'working', repo: 'r', brief: 'Do the work', for: `wt:${signed.ok.trapId}` });
  claimBait(signed.ok);
  appendStatus('working', 'work', 'working', 'still executing', undefined, undefined, true);
  const reg = readTrap(signed.ok.trapId)!;
  expect(trapWorkingStop(reg, true)?.reason).toContain('about to go idle');
  expect(trapWorkingStop(reg, true)).toEqual({});
  sendMessage('working', 'work', 'Keep going', 'helm');
  expect(await soakPark(reg.trapId, '0')).toBe('woke');
  expect(JSON.parse(output.mock.calls.at(-1)![0]).reason).toContain('Keep going');
  expect(trapWorkingStop(reg, true)?.reason).toContain('about to go idle');
});

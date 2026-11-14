import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  appendStatus, claimBait, enqueue, ensureLayout, heartbeatTrap, loadConfig, readRoster, readTrap,
  reservationForTicket, resumeTrapTurn, sendTrapMessage, signOnTrap, stowIdleTrap, queuedDescriptor,
} from '@lobstah/core';
import { createIdleTrapWatch, idleTrapDue } from '../src/idle-traps.js';
import { createTrapDispatchScheduler } from '../src/trap-dispatch.js';
import { buildTendReport, renderTend } from '../src/tend.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-idle-stow-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = ${JSON.stringify(home)}\n`);
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

function trap(harness = 'claude', codexServer = false) {
  const worktree = path.join(home, 'worktree');
  fs.mkdirSync(worktree);
  const signed = signOnTrap({ repo: 'r', worktree, cwd: worktree, harness, codexServer,
    sessionId: 'old-session', ttlMs: 60_000, harnessProcess: { pid: 999999, startedAt: 'test-process' } });
  if (!('ok' in signed)) throw new Error('held');
  return heartbeatTrap(signed.ok.trapId, { parked: true })!;
}

it('counts empty park time across liveness beats and resets on real activity', () => {
  const reg = trap();
  const next = heartbeatTrap(reg.trapId, { parked: true })!;
  expect(next.idleSince).toBe(reg.idleSince);
  const due = Date.parse(reg.idleSince!) + 60 * 60_000;
  expect(idleTrapDue(next, 60, due - 1)).toBe(false);
  expect(idleTrapDue(next, 60, due)).toBe(true);
  resumeTrapTurn(next, true);
  expect(readTrap(reg.trapId)?.idleSince).toBeUndefined();
  expect(idleTrapDue(readTrap(reg.trapId)!, 60, due)).toBe(false);
});

it.each(['claude', 'codex'])('auto-stows an idle %s trap normally, preserves the checkout, and ends its verified process', async harness => {
  const reg = trap(harness), endProcess = vi.fn(async () => 'ended' as const);
  const log: string[] = [];
  const watch = createIdleTrapWatch({ endProcess });
  const now = Date.parse(reg.idleSince!) + 60 * 60_000;
  watch(loadConfig(), now, line => log.push(line));
  watch(loadConfig(), now, line => log.push(line));
  await vi.waitFor(() => expect(endProcess).toHaveBeenCalledTimes(1));
  expect(endProcess).toHaveBeenCalledWith(reg.harnessProcess);
  expect(readTrap(reg.trapId)).toBeUndefined();
  expect(readRoster(reg.trapId)).toMatchObject({ state: 'stowed', leftReason: expect.stringContaining('auto-stowed') });
  expect(fs.existsSync(reg.worktree)).toBe(true);
  expect(log.join('\n')).toContain('auto-stowed after 60 minutes idle; worktree kept');
  expect(renderTend(buildTendReport())).toContain('auto-stowed after 60 minutes idle');
});

it('stops only the idle Codex thread on the shared server', async () => {
  const reg = trap('codex', true), endProcess = vi.fn(), stopThread = vi.fn(async () => 'idle' as const);
  createIdleTrapWatch({ endProcess, stopThread })(loadConfig(), Date.parse(reg.idleSince!) + 60 * 60_000, () => {});
  await vi.waitFor(() => expect(stopThread).toHaveBeenCalledWith('old-session'));
  expect(endProcess).not.toHaveBeenCalled();
});

it.each(['work', 'paused review', 'message', 'queued', 'disabled'])('preserves a trap with %s', reason => {
  const reg = trap();
  const cfg = loadConfig(), now = Date.parse(reg.idleSince!) + 60 * 60_000;
  if (reason === 'disabled') cfg.soak.idleStowMins = 0;
  if (reason === 'work' || reason === 'paused review') {
    enqueue({ id: 'job', repo: 'r', for: `wt:${reg.trapId}`, brief: 'work' });
    claimBait(reg);
    if (reason === 'paused review') appendStatus('job', 'work', 'paused', 'Awaiting ume review');
  }
  if (reason === 'message') sendTrapMessage(reg.trapId, 'helm', 'one more thing');
  if (reason === 'queued') enqueue({ id: 'job', repo: 'r', brief: 'work', trapAny: true });
  const endProcess = vi.fn();
  createIdleTrapWatch({ endProcess })(cfg, now, () => {});
  expect(readTrap(reg.trapId)).toBeDefined();
  expect(endProcess).not.toHaveBeenCalled();
});

it('brings an auto-stowed trap back for the next trap-any dispatch', async () => {
  const reg = trap();
  createIdleTrapWatch({ endProcess: async () => 'ended' })(loadConfig(), Date.parse(reg.idleSince!) + 60 * 60_000, () => {});
  enqueue({ id: 'next-job', repo: 'r', brief: 'next work', trapAny: true });
  const scheduler = createTrapDispatchScheduler({ timeoutSecs: 1, pollMs: 1, adapter: app => ({ app, launch: async launch => {
    const ticket = /--ticket (\S+)/.exec(launch.argv.at(-1)!)![1]!;
    const reservation = reservationForTicket(ticket)!;
    expect(reservation.trapId).toBe(reg.trapId);
    const signed = signOnTrap({ trapId: reg.trapId, repo: 'r', harness: 'claude', worktree: reg.worktree,
      cwd: reg.worktree, sessionId: 'returned-session', ttlMs: 60_000 });
    if (!('ok' in signed)) throw new Error('held');
    heartbeatTrap(signed.ok.trapId, { parked: true });
  } }) });
  scheduler(loadConfig(), Date.now(), () => {});
  await vi.waitFor(() => expect(readTrap(reg.trapId)?.sessionId).toBe('returned-session'));
  expect(readTrap(reg.trapId)?.worktree).toBe(reg.worktree);
  expect(claimBait(readTrap(reg.trapId)!)?.id).toBe('next-job');
});

it('rechecks a stale idle candidate after another listener claims work', () => {
  const reg = trap();
  enqueue({ id: 'active-job', repo: 'r', brief: 'work', for: `wt:${reg.trapId}` });
  claimBait(reg);
  expect(stowIdleTrap(reg.trapId, reg.sessionId, () => true, 'auto-stow')).toBeUndefined();
  expect(readTrap(reg.trapId)?.claimed).toBe('active-job');
});

it('an old idle listener cannot resurrect or claim for an auto-stowed registration', () => {
  const reg = trap();
  expect(stowIdleTrap(reg.trapId, reg.sessionId, () => true, 'auto-stow')).toBeDefined();
  expect(heartbeatTrap(reg.trapId, { parked: true })).toBeUndefined();
  enqueue({ id: 'later-job', repo: 'r', brief: 'work', for: `wt:${reg.trapId}` });
  expect(claimBait(reg)).toBeNull();
  expect(readTrap(reg.trapId)).toBeUndefined();
  expect(queuedDescriptor('later-job', 'work')).toBeDefined();
});

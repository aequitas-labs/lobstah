import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendStatus, beatTrap, claimNext, dispatchProgress, enqueue, ensureLayout, idleWorkingTrap,
  laneDirs, listNotices, loadConfig, noticeDispatchProgress, noticeStands, trapWorkingStop, unseenNotices, resumeTrapTurn } from '../src/index.js';
import type { TrapRegistration } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let trap: TrapRegistration;
const advance = (secs: number) => vi.setSystemTime(Date.now() + secs * 1000);
function watcher(age = 0, sessionId = trap.sessionId): void {
  fs.mkdirSync(path.join(home, 'watchers'), { recursive: true });
  fs.writeFileSync(path.join(home, 'watchers', `${sessionId}.json`), JSON.stringify({ sessionId, kind: 'trap',
    trapId: trap.trapId, pid: process.pid, heartbeatAt: new Date(Date.now() - age * 1000).toISOString() }));
}
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-turn-'));
  process.env.LOBSTAH_HOME = home; ensureLayout();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
  trap = { trapId: 'seat', name: 'kind-crab', sessionId: 'session', harness: 'codex', worktree: home, cwd: home,
    claimed: 'job', repo: 'r', signedOnAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() };
  fs.writeFileSync(path.join(home, 'soaking', 'seat.json'), JSON.stringify(trap));
  enqueue({ id: 'job', repo: 'r', brief: 'b' }); claimNext('work');
  fs.writeFileSync(path.join(laneDirs('work').active, 'job', 'claim.json'), JSON.stringify({ by: 'wt:seat', sessionId: trap.sessionId, at: new Date().toISOString() }));
  appendStatus('job', 'work', 'working', 'Holding both PRs until Chris says the design is settled', undefined, undefined, true);
});
afterEach(() => { vi.useRealTimers(); delete process.env.LOBSTAH_HOME; removeTempDir(home); });

it('blocks once, passes the second Stop even without stop_hook_active, then notices at 60s with the full note', () => {
  expect(trapWorkingStop(trap)?.reason).toContain('needs-decision (state the question and who must answer)');
  expect(idleWorkingTrap(trap)).toBeUndefined();
  expect(trapWorkingStop(trap)).toEqual({});
  expect(trapWorkingStop(trap)).toEqual({});
  advance(59); noticeDispatchProgress(); expect(listNotices()).toHaveLength(0);
  advance(1); noticeDispatchProgress(); noticeDispatchProgress();
  expect(listNotices()).toHaveLength(1);
  const n = listNotices()[0]!;
  expect(n.kind).toBe('trap-idle-working');
  expect(n.refId).toBe('job');
  expect(n.text).toContain('kind-crab (wt:seat)');
  expect(n.text).toContain('Holding both PRs until Chris says the design is settled');
  expect(noticeStands(n)).toBe(true);
  expect(unseenNotices(true)).toHaveLength(1);
  advance(899); noticeDispatchProgress(); expect(unseenNotices(false)).toHaveLength(0);
  advance(1); noticeDispatchProgress(); expect(unseenNotices(true)).toHaveLength(1);
  advance(900); noticeDispatchProgress(); expect(unseenNotices(false)).toHaveLength(0);
  advance(900); noticeDispatchProgress(); expect(unseenNotices(false)).toHaveLength(1);
  expect(dispatchProgress().map((p) => p.state)).toEqual(['idle-while-working']); // Not also stalled.
});

it('honors a continued Stop, a configured threshold, and disabling notices', () => {
  expect(trapWorkingStop(trap, true)).toEqual({});
  const cfg = loadConfig(); cfg.helm.idleWorkingNoticeSecs = 10;
  advance(9); expect(dispatchProgress(Date.now(), cfg)).toHaveLength(0);
  advance(1); expect(dispatchProgress(Date.now(), cfg)[0]?.state).toBe('idle-while-working');
  cfg.helm.idleWorkingNoticeSecs = 0; advance(3600);
  expect(dispatchProgress(Date.now(), cfg)).toHaveLength(0);
});

it('a live session-owned background await passes; stale, foreign or automatic park signals do not', () => {
  watcher(); expect(trapWorkingStop(trap)).toEqual({}); expect(idleWorkingTrap(trap)).toBeUndefined();
  watcher(6); expect(trapWorkingStop(trap)?.reason).toContain('about to go idle');
  watcher(0, 'foreign'); expect(trapWorkingStop(trap)).toEqual({});
  advance(60); expect(dispatchProgress()[0]?.state).toBe('idle-while-working');
  watcher(); expect(dispatchProgress()).toHaveLength(0);
});

it('tool activity clears idleness before throttling; a new report, session or claim invalidates the marker', () => {
  beatTrap({ cwd: home, sessionId: trap.sessionId });
  trapWorkingStop(trap); trapWorkingStop(trap); advance(1);
  expect(beatTrap({ cwd: home, sessionId: trap.sessionId }).reason).toBe('throttled');
  expect(idleWorkingTrap(trap)).toBeUndefined();
  trapWorkingStop(trap); advance(60); noticeDispatchProgress();
  const n = listNotices()[0]!;
  appendStatus('job', 'work', 'working', 'actually executing', undefined, undefined, true);
  expect(noticeStands(n)).toBe(false); expect(unseenNotices(false)).toHaveLength(0);
  expect(trapWorkingStop(trap)?.reason).toContain('about to go idle');
  expect(idleWorkingTrap({ ...trap, sessionId: 'resumed' })).toBeUndefined();
  expect(trapWorkingStop({ ...trap, claimed: 'other-job' })).toBeUndefined();
});

it('does not guard claim receipts, foreign claims or a waiting/terminal report', () => {
  for (const verb of ['paused', 'needs-decision', 'blocked', 'done', 'failed'] as const) {
    appendStatus('job', 'work', verb, 'waiting', undefined, undefined, true);
    expect(trapWorkingStop(trap)).toBeUndefined();
  }
  appendStatus('job', 'work', 'working', 'claimed by trap');
  expect(trapWorkingStop(trap)).toBeUndefined();
  appendStatus('job', 'work', 'working', 'real report', undefined, undefined, true);
  fs.writeFileSync(path.join(laneDirs('work').active, 'job', 'claim.json'), JSON.stringify({ by: 'wt:foreign' }));
  expect(trapWorkingStop(trap)).toBeUndefined();
});

it('validates the idle threshold', () => {
  expect(loadConfig().helm.idleWorkingNoticeSecs).toBe(60);
  for (const value of ['-1', '"soon"', 'true', 'inf', 'nan']) {
    fs.writeFileSync(path.join(home, 'config.toml'), `[helm]\nidleWorkingNoticeSecs = ${value}\n`);
    expect(() => loadConfig()).toThrow('idleWorkingNoticeSecs must be a non-negative number');
  }
});

it('a new user turn clears idleness and gets a fresh one-shot correction without a new report', () => {
  trapWorkingStop(trap); trapWorkingStop(trap); advance(60);
  expect(dispatchProgress()[0]?.state).toBe('idle-while-working');
  resumeTrapTurn(trap, true);
  expect(dispatchProgress()).toHaveLength(0);
  expect(trapWorkingStop(trap)?.reason).toContain('about to go idle');
  expect(trapWorkingStop(trap)).toEqual({});
});

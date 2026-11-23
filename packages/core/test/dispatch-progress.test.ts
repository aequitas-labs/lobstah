import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendStatus, claimNext, dispatchProgress, dispatchQueueReason, enqueue, ensureLayout,
  laneDirs, listNotices, loadConfig, noticeDispatchProgress, noticeStands, unseenNotices, writeActivity, touchEvents, requeue, queuedAt, requestCancel } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-progress-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
  fs.writeFileSync(path.join(home, 'config.toml'), '[repos.r]\npath = "/unused"\n');
});
afterEach(() => { vi.useRealTimers(); delete process.env.LOBSTAH_HOME; removeTempDir(home); });
const advance = (secs: number) => vi.setSystemTime(Date.now() + secs * 1000);

it('queues wake at 180s, dedupe across scans/restarts, back off, and clear when claimed', () => {
  enqueue({ id: 'queued', repo: 'r', brief: 'work', for: 'wt:missing' });
  advance(179);
  noticeDispatchProgress();
  expect(listNotices()).toHaveLength(0);
  advance(1);
  noticeDispatchProgress(); noticeDispatchProgress();
  expect(listNotices()).toHaveLength(1);
  expect(unseenNotices(true)[0]?.text).toContain('not signed on');
  expect(dispatchProgress()[0]?.text).toContain('re-dispatch unaddressed');
  advance(899); noticeDispatchProgress();
  expect(unseenNotices(false)).toHaveLength(0);
  advance(1); noticeDispatchProgress();
  expect(unseenNotices(true)).toHaveLength(1);
  advance(900); noticeDispatchProgress();
  expect(unseenNotices(false)).toHaveLength(0);
  advance(900); noticeDispatchProgress();
  expect(unseenNotices(false)).toHaveLength(1);
  const n = listNotices()[0]!;
  expect(noticeStands(n)).toBe(true);
  claimNext('work');
  expect(dispatchProgress()).toHaveLength(0); // No activity signal yet: unknown.
  expect(noticeStands(n)).toBe(false);
  expect(unseenNotices(false)).toHaveLength(0); // No obsolete wake after a claim.
});

it('uses the newest note, activity or runner event and exempts waiting/terminal verbs', () => {
  enqueue({ id: 'silent', repo: 'r', brief: 'work' }); claimNext('work');
  appendStatus('silent', 'work', 'working', 'reading the brief');
  advance(1199); expect(dispatchProgress()).toHaveLength(0);
  advance(1); noticeDispatchProgress();
  expect(dispatchProgress()[0]?.text).toContain('last note: reading the brief');
  writeActivity('silent', 'work', { at: new Date().toISOString(), kind: 'tool', summary: 'testing' });
  expect(dispatchProgress()).toHaveLength(0);
  expect(unseenNotices(false)).toHaveLength(0);
  advance(1200); expect(dispatchProgress()).toHaveLength(1);
  appendStatus('silent', 'work', 'working', 'new note');
  expect(dispatchProgress()).toHaveLength(0);
  for (const verb of ['paused', 'needs-decision', 'blocked', 'done', 'failed'] as const) {
    appendStatus('silent', 'work', verb, 'waiting or finished'); advance(3600);
    expect(dispatchProgress()).toHaveLength(0);
  }
});

it('recognizes a silent headless launch and clears on a fresh event', () => {
  enqueue({ id: 'headless', repo: 'r', brief: 'work' }); claimNext('work');
  fs.writeFileSync(path.join(laneDirs('work').active, 'headless', 'runner.json'), JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }));
  advance(1200);
  expect(dispatchProgress()[0]?.state).toBe('stalled');
  touchEvents('headless', 'work');
  expect(dispatchProgress()).toHaveLength(0);
});

it.each([1, 2])('keeps chores quiet while all %i chore slots are progressing', (choreConcurrent: number) => {
  const cfg = loadConfig();
  cfg.limits.choreConcurrent = choreConcurrent;
  for (let slot = 0; slot < choreConcurrent; slot++) {
    const id = `review-${slot}`;
    enqueue({ id, repo: 'r', brief: 'review a PR' }, 'chore');
    claimNext('chore');
    appendStatus(id, 'chore', 'working', 'reading the diff');
  }
  for (const id of ['queued-review', 'queued-repair']) {
    enqueue({ id, repo: 'r', brief: 'review or repair a PR' }, 'chore');
  }
  advance(cfg.helm.queuedNoticeSecs);
  expect(dispatchProgress(Date.now(), cfg)).toEqual([]);
  noticeDispatchProgress(Date.now(), cfg);
  expect(listNotices()).toEqual([]);
});

it('restores queued chore notices when one holder stalls and clears them when activity resumes', () => {
  const cfg = loadConfig();
  cfg.limits.choreConcurrent = 2;
  for (const id of ['silent-review', 'busy-review']) {
    enqueue({ id, repo: 'r', brief: 'review a PR' }, 'chore');
    claimNext('chore');
    appendStatus(id, 'chore', 'working', 'reading the diff');
  }
  for (const id of ['queued-review', 'queued-repair']) {
    enqueue({ id, repo: 'r', brief: 'review or repair a PR' }, 'chore');
  }
  advance(cfg.helm.stalledNoticeSecs);
  touchEvents('busy-review', 'chore');
  expect(dispatchProgress(Date.now(), cfg)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'silent-review', state: 'stalled' }),
    expect.objectContaining({ id: 'queued-review', state: 'queued-too-long' }),
    expect.objectContaining({ id: 'queued-repair', state: 'queued-too-long' }),
  ]));
  noticeDispatchProgress(Date.now(), cfg);
  const notices = listNotices();
  expect(notices).toHaveLength(3);
  expect(notices.every((notice) => noticeStands(notice))).toBe(true);
  touchEvents('silent-review', 'chore');
  expect(dispatchProgress(Date.now(), cfg)).toEqual([]);
  expect(notices.every((notice) => !noticeStands(notice))).toBe(true);
});

it('still reports queued work while healthy chores and work hold every headless slot', () => {
  const cfg = loadConfig();
  cfg.limits.choreConcurrent = 1;
  cfg.limits.maxConcurrent = 1;
  for (const lane of ['work', 'chore'] as const) {
    enqueue({ id: `active-${lane}`, repo: 'r', brief: 'active dispatch' }, lane);
    claimNext(lane);
    appendStatus(`active-${lane}`, lane, 'working');
    enqueue({ id: `queued-${lane}`, repo: 'r', brief: 'waiting dispatch' }, lane);
  }
  advance(cfg.helm.queuedNoticeSecs);
  expect(dispatchProgress(Date.now(), cfg)).toEqual([
    expect.objectContaining({ id: 'queued-work', lane: 'work', state: 'queued-too-long' }),
  ]);
});

it.each([0, 1])('reports a queued chore when %i of two chore slots are occupied', (occupied: number) => {
  const cfg = loadConfig();
  cfg.limits.choreConcurrent = 2;
  for (let slot = 0; slot < occupied; slot++) {
    enqueue({ id: `review-${slot}`, repo: 'r', brief: 'review a PR' }, 'chore');
    claimNext('chore');
    appendStatus(`review-${slot}`, 'chore', 'working');
  }
  enqueue({ id: 'queued-review', repo: 'r', brief: 'review a PR' }, 'chore');
  advance(cfg.helm.queuedNoticeSecs);
  expect(dispatchProgress(Date.now(), cfg)).toEqual([
    expect.objectContaining({ id: 'queued-review', state: 'queued-too-long' }),
  ]);
});

it('reports queued chores when chore slots are disabled', () => {
  const cfg = loadConfig();
  cfg.limits.choreConcurrent = 0;
  enqueue({ id: 'queued-review', repo: 'r', brief: 'review a PR' }, 'chore');
  advance(cfg.helm.queuedNoticeSecs);
  expect(dispatchProgress(Date.now(), cfg)).toEqual([
    expect.objectContaining({ id: 'queued-review', state: 'queued-too-long' }),
  ]);
});

it('does not count an interactive chore catch as an occupied headless slot', () => {
  const cfg = loadConfig();
  cfg.limits.choreConcurrent = 1;
  enqueue({ id: 'trap-review', repo: 'r', brief: 'review a PR' }, 'chore');
  claimNext('chore');
  fs.writeFileSync(path.join(laneDirs('chore').active, 'trap-review', 'claim.json'),
    JSON.stringify({ by: 'wt:reviewer', at: new Date().toISOString() }));
  appendStatus('trap-review', 'chore', 'working');
  enqueue({ id: 'queued-review', repo: 'r', brief: 'review a PR' }, 'chore');
  advance(cfg.helm.queuedNoticeSecs);
  expect(dispatchProgress(Date.now(), cfg)).toEqual([
    expect.objectContaining({ id: 'queued-review', state: 'queued-too-long' }),
  ]);
});

it.each(['cancelled', 'done', 'failed', 'paused'] as const)('does not suppress queued chores behind a %s chore', (state) => {
  const cfg = loadConfig();
  cfg.limits.choreConcurrent = 1;
  enqueue({ id: 'review', repo: 'r', brief: 'review a PR' }, 'chore');
  claimNext('chore');
  appendStatus('review', 'chore', 'working');
  if (state === 'cancelled') requestCancel('review', 'chore');
  else appendStatus('review', 'chore', state);
  enqueue({ id: 'queued-review', repo: 'r', brief: 'review a PR' }, 'chore');
  advance(cfg.helm.queuedNoticeSecs);
  expect(dispatchProgress(Date.now(), cfg)).toEqual([
    expect.objectContaining({ id: 'queued-review', state: 'queued-too-long' }),
  ]);
});

it('explains busy/absent traps, headless capacity and unknown repos without changing routing', () => {
  enqueue({ id: 'other-job', repo: 'r', brief: 'b' }); claimNext('work');
  fs.writeFileSync(path.join(home, 'soaking', 'seat.json'), JSON.stringify({ trapId: 'seat', name: 'young-foam',
    sessionId: 'session', harness: 'codex', worktree: home, cwd: home, repo: 'r', claimed: 'other-job',
    heartbeatAt: new Date().toISOString(), signedOnAt: new Date().toISOString() }));
  expect(dispatchQueueReason({ id: 'q', repo: 'r', brief: 'b', for: 'wt:seat' }, 'work')).toContain('young-foam (wt:seat), busy on dispatch other-job');
  appendStatus('other-job', 'work', 'done');
  expect(dispatchQueueReason({ id: 'q', repo: 'r', brief: 'b', for: 'wt:seat' }, 'work')).not.toContain('busy');
  expect(dispatchQueueReason({ id: 'q', repo: 'absent', brief: 'b' }, 'work')).toContain('not configured');
  const cfg = loadConfig(); cfg.limits.maxConcurrent = 0;
  expect(dispatchQueueReason({ id: 'q', repo: 'r', brief: 'b' }, 'work', cfg)).toContain('no free headless slot');
});

it('honors configured thresholds and disabling either condition', () => {
  fs.appendFileSync(path.join(home, 'config.toml'), '\n[helm]\nqueuedNoticeSecs = 10\nstalledNoticeSecs = 30\n');
  enqueue({ id: 'q', repo: 'r', brief: 'b' }); advance(10);
  expect(dispatchProgress()[0]?.state).toBe('queued-too-long');
  claimNext('work'); appendStatus('q', 'work', 'working'); advance(30);
  expect(dispatchProgress()[0]?.state).toBe('stalled');
  fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\nqueuedNoticeSecs = 0\nstalledNoticeSecs = 0\n');
  expect(dispatchProgress()).toHaveLength(0);
});

it('starts a fresh queue age when a long-running catch is requeued, preserving its descriptor', () => {
  enqueue({ id: 'retry', repo: 'r', brief: 'preserve me', for: 'wt:missing' }); claimNext('work');
  advance(3600); requeue('retry', 'work');
  expect(queuedAt('retry', 'work')).toBe(new Date().toISOString());
  expect(dispatchProgress()).toHaveLength(0);
  advance(180);
  expect(dispatchProgress()[0]?.state).toBe('queued-too-long');
});

it.each(['queuedNoticeSecs', 'stalledNoticeSecs'])('validates %s instead of silently disabling notices', (key) => {
  for (const value of ['-1', '"soon"', 'true', 'inf', 'nan']) {
    fs.writeFileSync(path.join(home, 'config.toml'), `[helm]\n${key} = ${value}\n`);
    expect(() => loadConfig()).toThrow(`${key} must be a non-negative number`);
  }
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendStatus, claimNext, dispatchProgress, dispatchQueueReason, enqueue, ensureLayout,
  laneDirs, listNotices, loadConfig, noticeDispatchProgress, noticeStands, unseenNotices, writeActivity, touchEvents, requeue, queuedAt } from '../src/index.js';
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

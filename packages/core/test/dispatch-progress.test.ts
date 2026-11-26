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

it('reports only the stalled holder while queued chores wait their turn', () => {
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
  ]));
  noticeDispatchProgress(Date.now(), cfg);
  const notices = listNotices();
  expect(notices).toHaveLength(1);
  expect(notices.every((notice) => noticeStands(notice))).toBe(true);
  touchEvents('silent-review', 'chore');
  expect(dispatchProgress(Date.now(), cfg)).toEqual([]);
  expect(notices.every((notice) => !noticeStands(notice))).toBe(true);
});

it('keeps both queues quiet while work and chore capacity is running', () => {
  const cfg = loadConfig();
  cfg.limits.choreConcurrent = 2;
  cfg.limits.maxConcurrent = 2;
  for (const lane of ['work', 'chore'] as const) {
    for (const slot of [0, 1]) {
      const id: string = `active-${lane}-${slot}`;
      enqueue({ id, repo: 'r', brief: 'active dispatch' }, lane);
      claimNext(lane);
      appendStatus(id, lane, 'working');
    }
    const queued = { id: `queued-${lane}`, repo: 'r', brief: 'waiting dispatch' };
    enqueue(queued, lane);
    expect(dispatchQueueReason(queued, lane, cfg)).toBe(`queued behind 2 running ${lane === 'chore' ? 'chores' : 'work dispatches'} (0 ahead)`);
  }
  advance(cfg.helm.queuedNoticeSecs);
  expect(dispatchProgress(Date.now(), cfg)).toEqual([]);
});

it.each([0, 1])('reports a queued chore only with no running chores (%i of two slots occupied)', (occupied: number) => {
  const cfg = loadConfig();
  cfg.limits.choreConcurrent = 2;
  for (let slot = 0; slot < occupied; slot++) {
    enqueue({ id: `review-${slot}`, repo: 'r', brief: 'review a PR' }, 'chore');
    claimNext('chore');
    appendStatus(`review-${slot}`, 'chore', 'working');
  }
  enqueue({ id: 'queued-review', repo: 'r', brief: 'review a PR' }, 'chore');
  advance(cfg.helm.queuedNoticeSecs);
  expect(dispatchProgress(Date.now(), cfg)).toEqual(occupied ? [] : [
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

it.each(['done', 'failed', 'paused'] as const)('does not suppress queued chores behind a %s chore', (state) => {
  const cfg = loadConfig();
  cfg.limits.choreConcurrent = 1;
  enqueue({ id: 'review', repo: 'r', brief: 'review a PR' }, 'chore');
  claimNext('chore');
  appendStatus('review', 'chore', 'working');
  appendStatus('review', 'chore', state);
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
  expect(dispatchQueueReason({ id: 'q', repo: 'r', brief: 'b', for: 'wt:seat' }, 'work')).toContain('queued behind 1 running dispatch on r · young-foam (wt:seat)');
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

it.each(['queuedNoticeSecs', 'choreQueuedNoticeSecs', 'stalledNoticeSecs'])('validates %s instead of silently disabling notices', (key) => {
  for (const value of ['-1', '"soon"', 'true', 'inf', 'nan']) {
    fs.writeFileSync(path.join(home, 'config.toml'), `[helm]\n${key} = ${value}\n`);
    expect(() => loadConfig()).toThrow(`${key} must be a non-negative number`);
  }
});

/** A live runner keeps producing events while another chore waits for its slot. */
function queueBehindLiveChore(): void {
  enqueue({ id: 'holder', repo: 'r', brief: 'review a PR' }, 'chore');
  claimNext('chore');
  appendStatus('holder', 'chore', 'working');
  fs.writeFileSync(path.join(laneDirs('chore').active, 'holder', 'runner.json'),
    JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }));
  enqueue({ id: 'waiting', repo: 'r', brief: 'review another PR' }, 'chore');
}

it('keeps a running chore queue quiet beyond the former long-wait threshold', () => {
  queueBehindLiveChore();
  advance(3600);
  touchEvents('holder', 'chore');
  expect(dispatchProgress()).toEqual([]);
  noticeDispatchProgress();
  expect(listNotices()).toEqual([]);
  // A terminal report releases capacity even while its active directory remains.
  appendStatus('holder', 'chore', 'done');
  expect(dispatchProgress()).toEqual([
    expect.objectContaining({ id: 'waiting', state: 'queued-too-long', thresholdSecs: 180 }),
  ]);
  expect(dispatchProgress()[0]?.text).toContain('Check or cancel the chore.');
  noticeDispatchProgress();
  const notice = listNotices()[0]!;
  expect(noticeStands(notice)).toBe(true);
  enqueue({ id: 'next-holder', repo: 'r', brief: 'review' }, 'chore');
  claimNext('chore', (d) => d.id !== 'next-holder');
  appendStatus('next-holder', 'chore', 'working');
  expect(noticeStands(notice)).toBe(false);
});

it('accepts the legacy chore wait setting without escalating a running queue', () => {
  fs.appendFileSync(path.join(home, 'config.toml'), '\n[helm]\nchoreQueuedNoticeSecs = 600\n');
  queueBehindLiveChore();
  advance(600);
  expect(dispatchProgress()).toEqual([]);
  const cfg = loadConfig();
  cfg.helm.choreQueuedNoticeSecs = 0;
  advance(3600);
  touchEvents('holder', 'chore');
  expect(dispatchProgress(Date.now(), cfg)).toEqual([]);
});

it('keeps a cancelling chore queue quiet until its holder finishes', () => {
  queueBehindLiveChore();
  requestCancel('holder', 'chore');
  advance(180);
  expect(dispatchProgress()).toEqual([]);
});

it('reports a dead slot holder even when its last activity is recent', () => {
  queueBehindLiveChore();
  advance(180);
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
  });
  try {
    expect(dispatchProgress()[0]?.id).toBe('waiting');
    expect(dispatchProgress()[0]?.text).toContain('Check or cancel the chore.');
    noticeDispatchProgress();
    expect(noticeStands(listNotices()[0]!)).toBe(true);
  } finally { kill.mockRestore(); }
  expect(dispatchProgress()).toEqual([]);
  expect(noticeStands(listNotices()[0]!)).toBe(false);
});

it('reports a stalled holder without raising queued notices for its waiting chores', () => {
  queueBehindLiveChore();
  advance(1200);
  expect(dispatchProgress()).toHaveLength(1);
  const stalled = dispatchProgress()[0]!;
  expect(stalled.id).toBe('holder');
  expect(stalled.text).toContain('Check the chore with lobstah status holder, or cancel it.');
});

it.each(['work', 'chore'] as const)('keeps addressed %s quiet only while its signed-on trap is busy', (lane) => {
  enqueue({ id: 'holder', repo: 'r', brief: 'work' }, lane);
  claimNext(lane);
  appendStatus('holder', lane, 'working');
  fs.writeFileSync(path.join(home, 'soaking', 'seat.json'), JSON.stringify({ trapId: 'seat', name: 'young-foam',
    sessionId: 'session', harness: 'codex', worktree: home, cwd: home, repo: 'r', claimed: 'holder',
    heartbeatAt: new Date().toISOString(), signedOnAt: new Date().toISOString() }));
  enqueue({ id: 'waiting', repo: 'r', brief: 'work', for: 'wt:seat' }, lane);
  enqueue({ id: 'absent', repo: 'r', brief: 'work', for: 'wt:absent' }, lane);
  advance(180);
  expect(dispatchProgress()).toEqual([
    expect.objectContaining({ id: 'absent', state: 'queued-too-long', text: expect.stringContaining('not signed on') }),
  ]);
  fs.rmSync(path.join(home, 'soaking', 'seat.json'));
  expect(dispatchProgress().map((item) => item.id).sort()).toEqual(['absent', 'waiting']);
});

it.each(['work', 'chore'] as const)('does not let the other lane hide a stalled %s queue', (lane) => {
  const other = lane === 'work' ? 'chore' : 'work';
  enqueue({ id: 'holder', repo: 'r', brief: 'work' }, other);
  claimNext(other);
  appendStatus('holder', other, 'working');
  enqueue({ id: 'waiting', repo: 'r', brief: 'work' }, lane);
  advance(180);
  expect(dispatchProgress()).toEqual([
    expect.objectContaining({ id: 'waiting', lane, state: 'queued-too-long' }),
  ]);
});

it('does not hide an addressed chore behind unrelated healthy capacity', () => {
  queueBehindLiveChore();
  enqueue({ id: 'addressed', repo: 'r', brief: 'review', for: 'wt:absent' }, 'chore');
  advance(180);
  expect(dispatchProgress()).toEqual([
    expect.objectContaining({ id: 'addressed', text: expect.stringContaining('not signed on') }),
  ]);
  expect(dispatchProgress()[0]?.text).not.toContain('re-address');
});

it('does not call a holder dead when process access is denied', () => {
  queueBehindLiveChore();
  advance(180);
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('Permission denied'), { code: 'EPERM' });
  });
  try { expect(dispatchProgress()).toEqual([]); }
  finally { kill.mockRestore(); }
});

it('keeps a configured target quiet only while its matching signed-on trap is busy', () => {
  const target = { kind: 'configured-trap' as const, profile: 'inspector', grounds: 'home', surface: 'terminal' as const };
  enqueue({ id: 'waiting', brief: 'inspect', target, for: 'trap:inspector' });
  fs.writeFileSync(path.join(home, 'soaking', 'seat.json'), JSON.stringify({ trapId: 'seat', name: 'young-foam',
    sessionId: 'session', harness: 'codex', worktree: home, cwd: home, configured: target, hostedCatch: 'remote-work',
    heartbeatAt: new Date().toISOString(), signedOnAt: new Date().toISOString() }));
  advance(180);
  expect(dispatchProgress()).toEqual([]);
  expect(dispatchQueueReason({ id: 'waiting', brief: 'inspect', target, for: 'trap:inspector' }, 'work')).toContain('queued behind 1 running dispatch');
  fs.rmSync(path.join(home, 'soaking', 'seat.json'));
  expect(dispatchProgress()).toEqual([
    expect.objectContaining({ id: 'waiting', state: 'queued-too-long', text: expect.stringContaining('not signed on') }),
  ]);
});

it('keeps trap-any work quiet behind matching busy traps without hiding an unrelated queue', () => {
  enqueue({ id: 'holder', repo: 'r', brief: 'work' });
  claimNext('work');
  appendStatus('holder', 'work', 'working');
  fs.writeFileSync(path.join(home, 'soaking', 'seat.json'), JSON.stringify({ trapId: 'seat', name: 'young-foam',
    sessionId: 'session', harness: 'codex', worktree: home, cwd: home, repo: 'r', claimed: 'holder',
    heartbeatAt: new Date().toISOString(), signedOnAt: new Date().toISOString() }));
  enqueue({ id: 'waiting', repo: 'r', brief: 'work', trapAny: true, harness: 'codex' });
  enqueue({ id: 'other', repo: 'r', brief: 'work', trapAny: true, harness: 'claude' });
  advance(180);
  expect(dispatchProgress().map((item) => item.id)).toEqual(['other']);
});

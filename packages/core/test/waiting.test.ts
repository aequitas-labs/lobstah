import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendStatus,
  claimBait,
  enqueue,
  ensureLayout,
  heartbeatTrap,
  listNotices,
  parseUntil,
  pausedWaiting,
  pendingIds,
  readStatusLog,
  readTrap,
  signOnTrap,
  sweepGhostTraps,
  waitingText,
  waitingView,
} from '../src/index.js';
import type { TrapRegistration } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-waiting-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

describe('paused --waiting-on: the status entry says what it waits on', () => {
  it('round-trips waitingOn, link, and until', () => {
    const now = Date.now();
    appendStatus('p1', 'work', 'paused', 'in human review', undefined, {
      waitingOn: 'review',
      link: 'https://ume.example.com/s/abc',
      until: '4h',
    });
    const e = readStatusLog('p1', 'work').at(-1)!;
    expect(e).toMatchObject({ verb: 'paused', note: 'in human review', waitingOn: 'review', link: 'https://ume.example.com/s/abc' });
    expect(Date.parse(e.until!) - now).toBeGreaterThanOrEqual(4 * 3600_000 - 1000);
    expect(Date.parse(e.until!) - now).toBeLessThanOrEqual(4 * 3600_000 + 5000);
    expect(pausedWaiting(e)).toBe(true);
    const v = waitingView(e, Date.parse(e.at) + 12 * 60_000)!;
    expect(waitingText(v)).toBe('waiting on review for 12m https://ume.example.com/s/abc');
  });

  it('allows --waiting-on and --link only with paused, needs-decision, blocked', () => {
    for (const verb of ['needs-decision', 'blocked']) {
      expect(appendStatus('p2', 'work', verb, 'q', undefined, { waitingOn: 'person', link: 'http://x.test/' }).waitingOn).toBe('person');
    }
    for (const verb of ['working', 'done', 'failed']) {
      expect(() => appendStatus('p3', 'work', verb, undefined, undefined, { waitingOn: 'review' })).toThrow(/valid only with/);
      expect(() => appendStatus('p3', 'work', verb, undefined, undefined, { link: 'https://x.test' })).toThrow(/valid only with/);
    }
    expect(() => appendStatus('p3', 'work', 'blocked', undefined, undefined, { until: '1h' })).toThrow(/--until is valid only with paused/);
    expect(() => appendStatus('p3', 'work', 'paused', undefined, undefined, { waitingOn: 'lunch' })).toThrow(/invalid --waiting-on/);
    expect(() => appendStatus('p3', 'work', 'paused', undefined, undefined, { link: 'javascript:alert(1)' })).toThrow(/http or https/);
    expect(() => appendStatus('p3', 'work', 'paused', undefined, undefined, { until: 'soon' })).toThrow(/invalid --until/);
    expect(readStatusLog('p3', 'work')).toEqual([]);
  });

  it('parses --until as ISO or a duration', () => {
    const now = Date.parse('2026-09-28T12:00:00.000Z');
    expect(parseUntil('30m', now)).toBe('2026-09-28T12:30:00.000Z');
    expect(parseUntil('2d', now)).toBe('2026-09-30T12:00:00.000Z');
    expect(parseUntil('2026-10-01T09:00Z', now)).toBe('2026-10-01T09:00:00.000Z');
  });

  it('paused without --waiting-on is not a wait on something external', () => {
    expect(pausedWaiting(appendStatus('p4', 'work', 'paused'))).toBe(false);
    expect(pausedWaiting(appendStatus('p4', 'work', 'blocked', 'x', undefined, { waitingOn: 'deploy' }))).toBe(false);
  });
});

describe('the ghost sweep keeps a paused catch until the pause expires', () => {
  const TTL = 120_000;
  const PAUSED_TTL = 3600_000;

  function pausedTrap(waiting?: { until?: string }): { reg: TrapRegistration; at: number } {
    enqueue({ id: 'w1', repo: 'web', brief: 'x' });
    const worktree = path.join(home, 'wt');
    fs.mkdirSync(worktree, { recursive: true });
    const res = signOnTrap({ sessionId: 's1', harness: 'claude', repo: 'web', worktree, cwd: worktree, ttlMs: TTL });
    if (!('ok' in res)) throw new Error('held');
    claimBait(res.ok);
    heartbeatTrap(res.ok.trapId, { parked: true });
    const e = appendStatus('w1', 'work', 'paused', 'waiting on review', undefined, { waitingOn: 'review', ...waiting });
    return { reg: readTrap(res.ok.trapId)!, at: Date.parse(e.at) };
  }

  it('skips it until pausedTtlSecs from the report, then sweeps with a pause-expired notice', () => {
    const { reg, at } = pausedTrap();
    expect(sweepGhostTraps(TTL, at + TTL + 60_000, PAUSED_TTL)).toEqual([]);
    expect(sweepGhostTraps(TTL, at + PAUSED_TTL - 1, PAUSED_TTL)).toEqual([]);
    expect(readTrap(reg.trapId)).toBeDefined();
    expect(sweepGhostTraps(TTL, at + PAUSED_TTL + 1, PAUSED_TTL)).toEqual([{ trapId: reg.trapId, requeued: 'w1', pauseExpired: true }]);
    expect(pendingIds('work')).toEqual(['w1']);
    const ghosted = listNotices().filter((n) => n.kind === 'trap-ghosted');
    expect(ghosted).toHaveLength(1);
    expect(ghosted[0]!.text).toMatch(/pause expired/);
  });

  it('--until overrides pausedTtlSecs', () => {
    const { reg, at } = pausedTrap({ until: '10m' });
    expect(sweepGhostTraps(TTL, at + 9 * 60_000, PAUSED_TTL)).toEqual([]);
    expect(sweepGhostTraps(TTL, at + 11 * 60_000, PAUSED_TTL)).toEqual([{ trapId: reg.trapId, requeued: 'w1', pauseExpired: true }]);
  });
});

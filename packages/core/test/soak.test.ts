import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendStatus,
  claimBait,
  daemonSkip,
  enqueue,
  ensureLayout,
  hasOpenCatch,
  heartbeatTrap,
  laneDirs,
  listNotices,
  listTraps,
  noticeOrphanedBait,
  pendingIds,
  readEvidence,
  readSessionClaim,
  readTrap,
  readStatusLog,
  releaseCatch,
  requestCancel,
  signOnTrap,
  stowTrap,
  sweepGhostTraps,
  trapBySession,
  trapIdAt,
} from '../src/index.js';
import type { TrapRegistration } from '../src/index.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-soak-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

const TTL_MS = 1800_000;

function trap(sessionId: string, repo?: string): TrapRegistration {
  const worktree = path.join(home, 'wt', sessionId);
  fs.mkdirSync(worktree, { recursive: true });
  const res = signOnTrap({ sessionId, harness: 'claude', repo, worktree, cwd: worktree, ttlMs: TTL_MS });
  if ('held' in res) throw new Error('unexpected hold');
  return res.ok;
}

describe('trap registry (worktree-anchored)', () => {
  it('signs on with a worktree-anchored id, heartbeats, and stows', () => {
    const reg = trap('s1', 'web');
    expect(trapIdAt(reg.worktree)).toBe(reg.trapId);
    expect(readTrap(reg.trapId)?.repo).toBe('web');
    const beat = heartbeatTrap(reg.trapId);
    expect(Date.parse(beat!.heartbeatAt)).toBeGreaterThanOrEqual(Date.parse(reg.heartbeatAt));
    expect(listTraps()).toHaveLength(1);
    expect(stowTrap(reg.trapId)?.sessionId).toBe('s1');
    expect(readTrap(reg.trapId)).toBeUndefined();
  });

  it('the trap id survives sessions: a new session in the same worktree keeps the address', () => {
    const first = trap('s1', 'web');
    stowTrap(first.trapId);
    const worktree = first.worktree;
    const res = signOnTrap({ sessionId: 's2', harness: 'claude', repo: 'web', worktree, cwd: worktree, ttlMs: TTL_MS });
    expect('ok' in res && res.ok.trapId).toBe(first.trapId);
    expect(trapBySession('s2')?.trapId).toBe(first.trapId);
  });

  it('session lock: a live foreign session refuses; a stale one is adopted', () => {
    const reg = trap('s1', 'web');
    const res = signOnTrap({ sessionId: 's2', harness: 'claude', repo: 'web', worktree: reg.worktree, cwd: reg.worktree, ttlMs: TTL_MS });
    expect('held' in res && res.held.sessionId).toBe('s1');
    const later = signOnTrap({
      sessionId: 's2',
      harness: 'claude',
      repo: 'web',
      worktree: reg.worktree,
      cwd: reg.worktree,
      ttlMs: TTL_MS,
      now: Date.now() + TTL_MS + 60_000,
    });
    expect('ok' in later && later.ok.sessionId).toBe('s2');
  });

  it('re-signing keeps the original signedOnAt and any open claim', () => {
    const first = trap('s1', 'web');
    heartbeatTrap(first.trapId, { claimed: 'abc' });
    const again = trap('s1', 'web');
    expect(again.signedOnAt).toBe(first.signedOnAt);
    expect(again.claimed).toBe('abc');
  });

  it('first park is recorded and raises a trap-listening notice', () => {
    const reg = trap('s1', 'web');
    expect(reg.firstParkedAt).toBeUndefined();
    heartbeatTrap(reg.trapId, { parked: true });
    expect(readTrap(reg.trapId)?.firstParkedAt).toBeDefined();
    expect(listNotices().map((n) => n.kind)).toContain('trap-listening');
  });
});

describe('claimBait', () => {
  it('takes addressed bait before older repo-matching bait and stamps the delivery receipt', () => {
    const reg = trap('s1', 'web');
    enqueue({ id: 'older', repo: 'web', brief: 'general work' });
    enqueue({ id: 'mine', repo: 'other', brief: 'targeted work', for: `wt:${reg.trapId}` });
    const caught = claimBait(reg);
    expect(caught?.id).toBe('mine');
    expect(readSessionClaim('mine', 'work')?.by).toBe(`wt:${reg.trapId}`);
    const ev = readEvidence('mine', 'work');
    expect(ev.sessionId).toBe('s1');
    expect(ev.deliveredTo).toBe(`wt:${reg.trapId}`);
    expect(ev.deliveredAt).toBeDefined();
    expect(readTrap(reg.trapId)?.claimed).toBe('mine');
  });

  it('never takes bait addressed to another trap', () => {
    enqueue({ id: 'theirs', repo: 'web', brief: 'x', for: 'wt:deadbeef' });
    expect(claimBait(trap('s1', 'web'))).toBeNull();
    expect(pendingIds('work')).toEqual(['theirs']);
  });

  it('takes unaddressed bait only on a repo match', () => {
    enqueue({ id: 'w1', repo: 'web', brief: 'x' });
    expect(claimBait(trap('s1', 'other'))).toBeNull();
    expect(claimBait(trap('s2'))).toBeNull(); // no repo key: addressed work only
    expect(claimBait(trap('s3', 'web'))?.id).toBe('w1');
  });

  it('one catch per trap: an open claim blocks further bait', () => {
    enqueue({ id: 'w1', repo: 'web', brief: 'x' });
    enqueue({ id: 'w2', repo: 'web', brief: 'y' });
    const reg = trap('s1', 'web');
    expect(claimBait(reg)?.id).toBe('w1');
    expect(claimBait(readTrap(reg.trapId)!)).toBeNull();
    appendStatus('w1', 'work', 'done', 'finished');
    expect(claimBait(readTrap(reg.trapId)!)?.id).toBe('w2');
  });
});

describe('daemonSkip (sticky addressing)', () => {
  it('addressed bait is NEVER the daemon\'s — registration or no registration', () => {
    const reg = trap('s1', 'web');
    const skip = daemonSkip([reg], 90_000);
    expect(skip({ id: 'a', repo: 'x', brief: 'b', for: `wt:${reg.trapId}` })).toBe(true);
    expect(skip({ id: 'a', repo: 'x', brief: 'b', for: 'wt:gone' })).toBe(true); // sticky even orphaned
    expect(daemonSkip([], 90_000)({ id: 'a', repo: 'x', brief: 'b', for: 'wt:gone' })).toBe(true);
  });

  it('defers unaddressed matching bait only while the heartbeat is fresh', () => {
    const reg = trap('s1', 'web');
    expect(daemonSkip([reg], 90_000)({ id: 'a', repo: 'web', brief: 'b' })).toBe(true);
    expect(daemonSkip([reg], 90_000)({ id: 'a', repo: 'other', brief: 'b' })).toBe(false);
    const stale = { ...reg, heartbeatAt: new Date(Date.now() - 3600_000).toISOString() };
    expect(daemonSkip([stale], 90_000)({ id: 'a', repo: 'web', brief: 'b' })).toBe(false);
  });

  it('a trap mid-catch defers nothing unaddressed', () => {
    enqueue({ id: 'w1', repo: 'web', brief: 'x' });
    const reg = trap('s1', 'web');
    claimBait(reg);
    expect(daemonSkip([readTrap(reg.trapId)!], 90_000)({ id: 'a', repo: 'web', brief: 'b' })).toBe(false);
  });
});

describe('orphaned addressed bait', () => {
  it('surfaces once as a helm notice instead of falling to the daemon', () => {
    enqueue({ id: 'orphan-1', repo: 'web', brief: 'x', for: 'wt:gone' });
    noticeOrphanedBait();
    noticeOrphanedBait(); // deduped
    const orphans = listNotices().filter((n) => n.kind === 'bait-orphaned');
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.refId).toBe('orphan-1');
    expect(pendingIds('work')).toEqual(['orphan-1']); // still queued — the helm decides
  });

  it('bait addressed to a live trap raises nothing', () => {
    const reg = trap('s1', 'web');
    enqueue({ id: 'fine-1', repo: 'web', brief: 'x', for: `wt:${reg.trapId}` });
    noticeOrphanedBait();
    expect(listNotices().filter((n) => n.kind === 'bait-orphaned')).toEqual([]);
  });
});

describe('releaseCatch and the ghost-trap sweep', () => {
  function caughtTrap(sessionId: string, baitId: string): TrapRegistration {
    enqueue({ id: baitId, repo: 'web', brief: 'x' });
    const reg = trap(sessionId, 'web');
    claimBait(reg);
    return readTrap(reg.trapId)!;
  }

  it('releaseCatch requeues an open catch and strips the claim', () => {
    const reg = caughtTrap('s1', 'w1');
    expect(hasOpenCatch(reg)).toBe(true);
    expect(releaseCatch(reg)).toEqual({ requeued: 'w1' });
    expect(pendingIds('work')).toEqual(['w1']);
    expect(fs.existsSync(path.join(laneDirs('work').active, 'w1'))).toBe(false);
  });

  it('releaseCatch finalizes a cancelled catch as failed instead of requeueing', () => {
    const reg = caughtTrap('s1', 'w1');
    requestCancel('w1', 'work');
    expect(releaseCatch(reg)).toEqual({ finalized: 'w1' });
    expect(pendingIds('work')).toEqual([]);
    expect(fs.existsSync(path.join(laneDirs('work').done, 'w1'))).toBe(true);
    expect(readStatusLog('w1', 'work').at(-1)?.verb).toBe('failed');
  });

  it('sweeps a stale registration that HAS parked before', () => {
    const reg = trap('s1', 'web');
    heartbeatTrap(reg.trapId, { parked: true });
    const actions = sweepGhostTraps(1000, Date.now() + 60_000);
    expect(actions).toEqual([{ trapId: reg.trapId }]);
    expect(readTrap(reg.trapId)).toBeUndefined();
    expect(listNotices().map((n) => n.kind)).toContain('trap-ghosted');
  });

  it('a never-parked stale trap is a defective enlistment: noticed once, never swept', () => {
    const reg = trap('s1', 'web');
    const first = sweepGhostTraps(1000, Date.now() + 60_000);
    expect(first).toEqual([{ trapId: reg.trapId, defective: true }]);
    expect(readTrap(reg.trapId)).toBeDefined(); // registration stays — the address keeps protecting its bait
    expect(sweepGhostTraps(1000, Date.now() + 120_000)).toEqual([]); // deduped
    expect(listNotices().filter((n) => n.kind === 'trap-defective')).toHaveLength(1);
  });

  it('sweeps a stale caught trap and requeues its bait', () => {
    const reg = caughtTrap('s1', 'w1');
    const actions = sweepGhostTraps(1000, Date.now() + 60_000);
    expect(actions).toEqual([{ trapId: reg.trapId, requeued: 'w1' }]);
    expect(pendingIds('work')).toEqual(['w1']);
  });

  it('a fresh status report keeps a stale-heartbeat trap out of the sweep', () => {
    const reg = caughtTrap('s1', 'w1');
    appendStatus('w1', 'work', 'working', 'mid-turn, not parked');
    expect(sweepGhostTraps(120_000, Date.now() + 100_000)).toEqual([]);
    expect(readTrap(reg.trapId)).toBeDefined();
  });
});

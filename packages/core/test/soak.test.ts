import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendStatus,
  claimBait,
  enqueue,
  ensureLayout,
  hasOpenCatch,
  heartbeatSoak,
  laneDirs,
  listSoaking,
  pendingIds,
  readEvidence,
  readSessionClaim,
  readSoak,
  readStatusLog,
  releaseCatch,
  requestCancel,
  signOnSoak,
  soakSkip,
  stowSoak,
  sweepGhostTraps,
} from '../src/index.js';
import type { SoakRegistration } from '../src/index.js';

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

function trap(sessionId: string, repo?: string): SoakRegistration {
  return signOnSoak({ sessionId, harness: 'claude', repo, worktree: `/wt/${sessionId}`, cwd: `/wt/${sessionId}` });
}

describe('soak registry', () => {
  it('signs on, heartbeats, and stows', () => {
    const reg = trap('s1', 'web');
    expect(readSoak('s1')?.repo).toBe('web');
    const beat = heartbeatSoak('s1');
    expect(Date.parse(beat!.heartbeatAt)).toBeGreaterThanOrEqual(Date.parse(reg.heartbeatAt));
    expect(listSoaking()).toHaveLength(1);
    expect(stowSoak('s1')?.sessionId).toBe('s1');
    expect(readSoak('s1')).toBeUndefined();
  });

  it('re-signing keeps the original signedOnAt and any open claim', () => {
    const first = trap('s1', 'web');
    heartbeatSoak('s1', { claimed: 'abc' });
    const again = trap('s1', 'web');
    expect(again.signedOnAt).toBe(first.signedOnAt);
    expect(again.claimed).toBe('abc');
  });
});

describe('claimBait', () => {
  it('takes addressed bait before older repo-matching bait', () => {
    enqueue({ id: 'older', repo: 'web', brief: 'general work' });
    enqueue({ id: 'mine', repo: 'other', brief: 'targeted work', for: 'session:s1' });
    const caught = claimBait(trap('s1', 'web'));
    expect(caught?.id).toBe('mine');
    expect(readSessionClaim('mine', 'work')?.by).toBe('session:s1');
    expect(readEvidence('mine', 'work').sessionId).toBe('s1');
    expect(readSoak('s1')?.claimed).toBe('mine');
  });

  it('never takes bait addressed to another session', () => {
    enqueue({ id: 'theirs', repo: 'web', brief: 'x', for: 'session:s2' });
    expect(claimBait(trap('s1', 'web'))).toBeNull();
    expect(pendingIds('work')).toEqual(['theirs']);
  });

  it('takes unaddressed bait only on a repo match', () => {
    enqueue({ id: 'w1', repo: 'web', brief: 'x' });
    expect(claimBait(trap('s1', 'other'))).toBeNull();
    expect(claimBait(trap('s2'))).toBeNull(); // no repo key: addressed bait only
    expect(claimBait(trap('s3', 'web'))?.id).toBe('w1');
  });

  it('one catch per trap: an open claim blocks further bait', () => {
    enqueue({ id: 'w1', repo: 'web', brief: 'x' });
    enqueue({ id: 'w2', repo: 'web', brief: 'y' });
    const reg = trap('s1', 'web');
    expect(claimBait(reg)?.id).toBe('w1');
    expect(claimBait(readSoak('s1')!)).toBeNull();
    appendStatus('w1', 'work', 'done', 'finished');
    expect(claimBait(readSoak('s1')!)?.id).toBe('w2');
  });
});

describe('soakSkip (the daemon deference predicate)', () => {
  it('always skips bait addressed to a registered trap, fresh or stale', () => {
    const stale = { ...trap('s1', 'web'), heartbeatAt: new Date(Date.now() - 3600_000).toISOString() };
    const skip = soakSkip([stale], 90_000);
    expect(skip({ id: 'a', repo: 'x', brief: 'b', for: 'session:s1' })).toBe(true);
    expect(skip({ id: 'a', repo: 'x', brief: 'b', for: 'session:ghost' })).toBe(false);
  });

  it('defers unaddressed matching bait only while the heartbeat is fresh', () => {
    const reg = trap('s1', 'web');
    expect(soakSkip([reg], 90_000)({ id: 'a', repo: 'web', brief: 'b' })).toBe(true);
    expect(soakSkip([reg], 90_000)({ id: 'a', repo: 'other', brief: 'b' })).toBe(false);
    const stale = { ...reg, heartbeatAt: new Date(Date.now() - 3600_000).toISOString() };
    expect(soakSkip([stale], 90_000)({ id: 'a', repo: 'web', brief: 'b' })).toBe(false);
  });

  it('a trap mid-catch defers nothing', () => {
    enqueue({ id: 'w1', repo: 'web', brief: 'x' });
    const reg = trap('s1', 'web');
    claimBait(reg);
    expect(soakSkip([readSoak('s1')!], 90_000)({ id: 'a', repo: 'web', brief: 'b' })).toBe(false);
  });
});

describe('releaseCatch and the ghost-trap sweep', () => {
  function caughtTrap(sessionId: string, baitId: string): SoakRegistration {
    enqueue({ id: baitId, repo: 'web', brief: 'x' });
    const reg = trap(sessionId, 'web');
    claimBait(reg);
    return readSoak(sessionId)!;
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

  it('sweeps a stale idle registration', () => {
    trap('s1', 'web');
    expect(sweepGhostTraps(1000, Date.now() + 60_000)).toEqual([{ sessionId: 's1' }]);
    expect(readSoak('s1')).toBeUndefined();
  });

  it('sweeps a stale caught trap and requeues its bait', () => {
    caughtTrap('s1', 'w1');
    const actions = sweepGhostTraps(1000, Date.now() + 60_000);
    expect(actions).toEqual([{ sessionId: 's1', requeued: 'w1' }]);
    expect(pendingIds('work')).toEqual(['w1']);
  });

  it('a fresh status report keeps a stale-heartbeat trap out of the sweep', () => {
    caughtTrap('s1', 'w1');
    appendStatus('w1', 'work', 'working', 'mid-turn, not parked');
    expect(sweepGhostTraps(120_000, Date.now() + 100_000)).toEqual([]);
    expect(readSoak('s1')).toBeDefined();
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  anchoredWorktree,
  soakWorktreeFor,
  writeTrapAnchor,
  appendStatus,
  beatTrap,
  claimBait,
  readActivity,
  readBeat,
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
  readTrapAnchor,
  readRoster,
  observeSessionWorker,
  reserveTrapName,
  trapByAddress,
  trapLabel,
  TRAP_FIRST_WORDS,
  TRAP_LAST_WORDS,
  readStatusLog,
  releaseCatch,
  requestCancel,
  signOnTrap,
  stowTrap,
  sweepGhostTraps,
  trapBySession,
  trapIdAt,
  unseenNotices,
} from '../src/index.js';
import type { TrapRegistration } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';
import { generatedTrapNameForId } from '../src/trap-names.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-soak-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
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
  it('shares the observed model and config with the roster while preserving generated provenance', () => {
    observeSessionWorker({ session_id: 'roster-worker', hook_event_name: 'SessionStart', model: 'claude-opus-5-5', permission_mode: 'acceptEdits' }, 'claude');
    const first = trap('roster-worker');
    expect(first).toMatchObject({ model: 'claude-opus-5-5', config: { effort: null, permissionMode: 'acceptEdits' } });
    expect(readRoster(first.trapId)).toMatchObject({ name: first.name, model: first.model, config: { permissionMode: first.config!.permissionMode } });
    stowTrap(first.trapId);
    // A returning trap restores the roster name even if the anchor lost it.
    writeTrapAnchor(first.worktree, { trapId: first.trapId });
    const back = signOnTrap({ sessionId: first.sessionId, harness: 'claude', worktree: first.worktree, cwd: first.worktree, ttlMs: TTL_MS });
    expect(back).toMatchObject({ ok: { name: first.name, model: first.model, config: first.config } });
    expect(generatedTrapNameForId(first.trapId)).toBe(first.name);
    expect(readRoster(first.trapId)).toMatchObject({ state: 'live', name: first.name, model: first.model });
  });

  it('records generated provenance and preserves it through re-soak, stow and ghosting', () => {
    const first = trap('provenance');
    expect(generatedTrapNameForId(first.trapId)).toBe(first.name);
    signOnTrap({ sessionId: first.sessionId, harness: 'claude', worktree: first.worktree, cwd: first.worktree, ttlMs: TTL_MS });
    expect(generatedTrapNameForId(first.trapId)).toBe(first.name);
    stowTrap(first.trapId);
    signOnTrap({ sessionId: 'resumed', harness: 'claude', worktree: first.worktree, cwd: first.worktree, ttlMs: TTL_MS });
    expect(generatedTrapNameForId(first.trapId)).toBe(first.name);
    sweepGhostTraps(1000, Date.now() + 60_000);
    expect(generatedTrapNameForId(first.trapId)).toBe(first.name);
  });

  it('never infers provenance from a chosen or older generated-looking name', () => {
    reserveTrapName('custom', 'kind-crab');
    expect(generatedTrapNameForId('custom')).toBeUndefined();
    fs.writeFileSync(path.join(home, 'trap-names', 'amber-gull.json'), JSON.stringify({ trapId: 'legacy' }));
    reserveTrapName('legacy');
    expect(generatedTrapNameForId('legacy')).toBeUndefined();
    const first = trap('same-name');
    signOnTrap({ sessionId: first.sessionId, harness: 'claude', worktree: first.worktree, cwd: first.worktree, ttlMs: TTL_MS, name: first.name });
    expect(generatedTrapNameForId(first.trapId)).toBeUndefined();
  });

  it('restores an anchor with a lost name record without claiming generated provenance', () => {
    const first = trap('lost-record');
    fs.unlinkSync(path.join(home, 'trap-names', `${first.name}.json`));
    stowTrap(first.trapId);
    const again = signOnTrap({ sessionId: 'resumed', harness: 'claude', worktree: first.worktree, cwd: first.worktree, ttlMs: TTL_MS });
    expect('ok' in again && again.ok.name).toBe(first.name);
    expect(generatedTrapNameForId(first.trapId)).toBeUndefined();
  });

  it('assigns distinct two-word names and resolves either address', () => {
    const one = trap('one');
    const two = trap('two');
    expect(one.name).toMatch(/^[a-z]{2,8}-[a-z]{2,8}$/);
    expect(two.name).not.toBe(one.name);
    expect(trapByAddress(one.name!)?.trapId).toBe(one.trapId);
    expect(trapByAddress(`wt:${one.name}`)?.trapId).toBe(one.trapId);
    expect(trapByAddress(`wt:${one.trapId}`)?.trapId).toBe(one.trapId);
    expect(trapLabel(one)).toBe(`${one.name} (wt:${one.trapId})`);
  });

  it('skips a collision and keeps a chosen name through stow and re-soak', () => {
    expect(reserveTrapName('first', undefined, 0)).toBe(`${TRAP_FIRST_WORDS[0]}-${TRAP_LAST_WORDS[0]}`);
    expect(reserveTrapName('second', undefined, 0)).toBe(`${TRAP_FIRST_WORDS[0]}-${TRAP_LAST_WORDS[1]}`);
    const first = trap('one');
    const selected = signOnTrap({ sessionId: 'one', harness: 'claude', worktree: first.worktree, cwd: first.worktree, ttlMs: TTL_MS, name: 'amber-gull' });
    expect('ok' in selected && selected.ok.name).toBe('amber-gull');
    stowTrap(first.trapId);
    const again = signOnTrap({ sessionId: 'new', harness: 'claude', worktree: first.worktree, cwd: first.worktree, ttlMs: TTL_MS });
    expect('ok' in again && again.ok.name).toBe('amber-gull');
    expect(readTrapAnchor(first.worktree)?.name).toBe('amber-gull');
  });

  it('refuses malformed and taken names and upgrades a legacy registration', () => {
    const first = trap('one');
    expect(() => signOnTrap({ sessionId: 'one', harness: 'claude', worktree: first.worktree, cwd: first.worktree, ttlMs: TTL_MS, name: 'Amber Gull' })).toThrow('invalid trap name');
    const second = trap('two');
    expect(() => signOnTrap({ sessionId: 'two', harness: 'claude', worktree: second.worktree, cwd: second.worktree, ttlMs: TTL_MS, name: first.name })).toThrow('already taken');
    const old = readTrap(first.trapId)!;
    delete old.name;
    fs.writeFileSync(path.join(home, 'soaking', `${first.trapId}.json`), JSON.stringify(old));
    const upgraded = signOnTrap({ sessionId: 'one', harness: 'claude', worktree: first.worktree, cwd: first.worktree, ttlMs: TTL_MS });
    expect('ok' in upgraded && upgraded.ok.name).toBe(first.name);
  });

  it('keeps its name after a ghost sweep and re-soak', () => {
    const first = trap('one');
    heartbeatTrap(first.trapId, { parked: true });
    sweepGhostTraps(1000, Date.now() + 60_000);
    const again = signOnTrap({ sessionId: 'new', harness: 'claude', worktree: first.worktree, cwd: first.worktree, ttlMs: TTL_MS });
    expect('ok' in again && again.ok.name).toBe(first.name);
  });

  it('keeps both word lists short, lowercase, and unique', () => {
    for (const words of [TRAP_FIRST_WORDS, TRAP_LAST_WORDS]) {
      expect(new Set(words).size).toBe(words.length);
      expect(words.every((word) => /^[a-z]{2,8}$/.test(word))).toBe(true);
    }
  });

  it('signs on with a worktree-anchored id, heartbeats, and stows', () => {
    const reg = trap('s1', 'web');
    expect(trapIdAt(reg.worktree)).toBe(reg.trapId);
    expect(readTrap(reg.trapId)?.repo).toBe('web');
    const beat = heartbeatTrap(reg.trapId);
    expect(Date.parse(beat!.heartbeatAt)).toBeGreaterThanOrEqual(Date.parse(reg.heartbeatAt));
    expect(listTraps()).toHaveLength(1);
    expect(stowTrap(reg.trapId)?.sessionId).toBe('s1');
    expect(readTrap(reg.trapId)).toBeUndefined();
    const stowed = listNotices().filter((n) => n.kind === 'trap-stowed');
    expect(stowed).toHaveLength(1);
    expect(stowed[0]!.refId).toBe(reg.trapId);
  });

  it('the trap id survives sessions: a new session in the same worktree keeps the address', () => {
    const first = trap('s1', 'web');
    stowTrap(first.trapId);
    const worktree = first.worktree;
    const res = signOnTrap({ sessionId: 's2', harness: 'claude', repo: 'web', worktree, cwd: worktree, ttlMs: TTL_MS });
    expect('ok' in res && res.ok.trapId).toBe(first.trapId);
    expect(trapBySession('s2')?.trapId).toBe(first.trapId);
  });

  it('re-enlistment notices again, even for the same session', () => {
    const first = trap('s1', 'web');
    heartbeatTrap(first.trapId, { parked: true });
    stowTrap(first.trapId);
    signOnTrap({ sessionId: 's1', harness: 'claude', repo: 'web', worktree: first.worktree, cwd: first.worktree, ttlMs: TTL_MS });
    heartbeatTrap(first.trapId, { parked: true });
    const kinds = listNotices(50).map((n) => n.kind);
    expect(kinds.filter((k) => k === 'trap-signed-on')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'trap-available')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'trap-stowed')).toHaveLength(1);
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

  it('first park is recorded and raises one waking trap-available notice; a batch trap\'s is quiet', () => {
    const reg = trap('s1', 'web');
    expect(reg.firstParkedAt).toBeUndefined();
    heartbeatTrap(reg.trapId, { parked: true });
    heartbeatTrap(reg.trapId, { parked: true });
    expect(readTrap(reg.trapId)?.firstParkedAt).toBeDefined();
    const available = listNotices().filter((n) => n.kind === 'trap-available');
    expect(available).toHaveLength(1);
    expect(available[0]!.quiet).toBeUndefined();
    expect(unseenNotices(true).map((n) => n.kind)).toEqual(['trap-available']);
    const worktree = path.join(home, 'wt', 'batch');
    fs.mkdirSync(worktree, { recursive: true });
    const res = signOnTrap({ sessionId: 's9', harness: 'claude', repo: 'web', worktree, cwd: worktree, batch: 'b1', ttlMs: TTL_MS });
    heartbeatTrap(('ok' in res ? res.ok : res.held).trapId, { parked: true });
    expect(listNotices().filter((n) => n.kind === 'trap-available').at(-1)?.quiet).toBe(true);
    expect(unseenNotices(true)).toEqual([]);
  });

  it('a ghost sweep of an idle trap is quiet; one holding a catch wakes', () => {
    const idle = trap('s1', 'web');
    const busy = trap('s2', 'web');
    heartbeatTrap(idle.trapId, { parked: true });
    heartbeatTrap(busy.trapId, { parked: true });
    enqueue({ id: 'held', repo: 'web', brief: 'b', for: `wt:${busy.trapId}` });
    claimBait(readTrap(busy.trapId)!);
    unseenNotices(true);
    sweepGhostTraps(1_000, Date.now() + 3_600_000);
    const ghosts = listNotices(50).filter((n) => n.kind === 'trap-ghosted');
    expect(ghosts.find((n) => n.refId === idle.trapId)?.quiet).toBe(true);
    expect(ghosts.find((n) => n.refId === busy.trapId)?.quiet).toBeUndefined();
    expect(unseenNotices(true).filter((n) => n.kind === 'trap-ghosted').map((n) => n.refId)).toEqual([busy.trapId]);
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

  it('writes the first status entry: working, at the claim time, noting the trap', () => {
    const reg = trap('s1', 'web');
    enqueue({ id: 'w1', repo: 'web', brief: 'x' });
    claimBait(reg);
    const claim = readSessionClaim('w1', 'work')!;
    expect(readStatusLog('w1', 'work')).toEqual([{ at: claim.at, verb: 'working', note: `claimed by wt:${reg.trapId}` }]);
    expect(readEvidence('w1', 'work').deliveredAt).toBe(claim.at);
  });

  it('a re-claim after requeue appends another claim entry', () => {
    const reg = trap('s1', 'web');
    enqueue({ id: 'w1', repo: 'web', brief: 'x' });
    claimBait(reg);
    releaseCatch(readTrap(reg.trapId)!);
    const again = trap('s2', 'web');
    claimBait(again);
    const log = readStatusLog('w1', 'work');
    expect(log.map((e) => e.verb)).toEqual(['working', 'working']);
    expect(log.at(-1)).toMatchObject({ at: readSessionClaim('w1', 'work')!.at, note: `claimed by wt:${again.trapId}` });
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

  it.each(['done', 'failed'] as const)('releaseCatch finalizes %s without requeueing', (verb) => {
    const reg = caughtTrap('s1', 'w1');
    appendStatus('w1', 'work', verb, 'finished');
    expect(releaseCatch(reg)).toEqual({ finalized: 'w1' });
    expect(pendingIds('work')).toEqual([]);
    expect(fs.existsSync(path.join(laneDirs('work').done, 'w1'))).toBe(true);
    expect(readStatusLog('w1', 'work').at(-1)?.verb).toBe(verb);
  });

  it.each(['done', 'failed'] as const)('a stale %s trap leaves no orphaned bait', (verb) => {
    const reg = trap('s1', 'web');
    enqueue({ id: 'w1', repo: 'web', brief: 'x', for: `wt:${reg.trapId}` });
    claimBait(reg);
    appendStatus('w1', 'work', verb, 'finished');
    expect(sweepGhostTraps(1000, Date.now() + 60_000)).toEqual([{ trapId: reg.trapId, finalized: 'w1' }]);
    noticeOrphanedBait();
    expect(pendingIds('work')).toEqual([]);
    expect(listNotices().some((n) => n.kind === 'bait-orphaned')).toBe(false);
    expect(fs.existsSync(path.join(laneDirs('work').done, 'w1'))).toBe(true);
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

  it('the claim entry does not keep a dead trap alive past the TTL', () => {
    const reg = caughtTrap('s1', 'w1');
    const claimAt = Date.parse(readStatusLog('w1', 'work')[0]!.at);
    const beatAt = Date.parse(reg.heartbeatAt);
    // The claim entry is never newer than the heartbeat written with it.
    expect(claimAt).toBeLessThanOrEqual(beatAt);
    const ttl = 120_000;
    expect(sweepGhostTraps(ttl, beatAt + ttl)).toEqual([]); // still inside the TTL
    expect(sweepGhostTraps(ttl, beatAt + ttl + 1)).toEqual([{ trapId: reg.trapId, requeued: 'w1' }]);
  });

  it('a fresh status report keeps a stale-heartbeat trap out of the sweep', () => {
    const reg = caughtTrap('s1', 'w1');
    appendStatus('w1', 'work', 'working', 'mid-turn, not parked');
    expect(sweepGhostTraps(120_000, Date.now() + 100_000)).toEqual([]);
    expect(readTrap(reg.trapId)).toBeDefined();
  });
});

describe('window capture', () => {
  it('maps terminal identity from the environment', async () => {
    const { captureWindow } = await import('../src/window.js');
    const ref = captureWindow({
      __CFBundleIdentifier: 'com.googlecode.iterm2',
      TERM_PROGRAM: 'iTerm.app',
      ITERM_SESSION_ID: 'w0t2p0:UUID',
      TMUX_PANE: '%3',
    } as NodeJS.ProcessEnv);
    expect(ref?.bundleId).toBe('com.googlecode.iterm2');
    expect(ref?.itermSession).toBe('w0t2p0:UUID');
    expect(ref?.tmuxPane).toBe('%3');
  });
});

describe('soak beat (post-tool hook liveness)', () => {
  function caught(sessionId: string, baitId: string): TrapRegistration {
    enqueue({ id: baitId, repo: 'web', brief: 'x' });
    const reg = trap(sessionId, 'web');
    claimBait(reg);
    return readTrap(reg.trapId)!;
  }

  it('refreshes the beat and writes activity for the claimed catch, from a subdirectory', () => {
    const reg = caught('s1', 'w1');
    const sub = path.join(reg.worktree, 'src', 'deep');
    fs.mkdirSync(sub, { recursive: true });
    const res = beatTrap({
      cwd: sub,
      sessionId: 's1',
      toolName: 'Edit',
      toolInput: { file_path: path.join(reg.worktree, 'src', 'a.ts'), new_string: 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8' },
    });
    expect(res).toEqual({ beat: true, trapId: reg.trapId, activityFor: 'w1' });
    expect(readBeat(reg.trapId)?.sessionId).toBe('s1');
    const a = readActivity('w1', 'work')!;
    expect(a.kind).toBe('tool');
    expect(a.summary).toBe('Edit src/a.ts');
  });

  it('is throttled per trap', () => {
    const reg = caught('s1', 'w1');
    const now = Date.now();
    expect(beatTrap({ cwd: reg.worktree, toolName: 'Read', now }).beat).toBe(true);
    expect(beatTrap({ cwd: reg.worktree, toolName: 'Edit', now: now + 29_000 })).toEqual({ beat: false, reason: 'throttled' });
    expect(readActivity('w1', 'work')?.summary).toBe('Read');
    expect(beatTrap({ cwd: reg.worktree, toolName: 'Edit', now: now + 30_000 }).beat).toBe(true);
  });

  it('is inert outside a soaking worktree and for another session', () => {
    const elsewhere = path.join(home, 'plain');
    fs.mkdirSync(elsewhere, { recursive: true });
    expect(beatTrap({ cwd: elsewhere, toolName: 'Read' })).toEqual({ beat: false, reason: 'not-soaking' });
    const reg = trap('s1', 'web');
    stowTrap(reg.trapId);
    expect(beatTrap({ cwd: reg.worktree, toolName: 'Read' })).toEqual({ beat: false, reason: 'not-soaking' });
    const again = trap('s2', 'web');
    expect(beatTrap({ cwd: again.worktree, sessionId: 'someone-else' })).toEqual({ beat: false, reason: 'other-session' });
    expect(readBeat(again.trapId)).toBeUndefined();
  });

  it('outside the trap worktree, resolves the trap from the session id', () => {
    const elsewhere = path.join(home, 'primary-checkout');
    fs.mkdirSync(elsewhere, { recursive: true });
    const reg = caught('s1', 'w1');
    expect(beatTrap({ cwd: elsewhere, sessionId: 's1', toolName: 'Read' })).toEqual({ beat: true, trapId: reg.trapId, activityFor: 'w1' });
    expect(beatTrap({ cwd: elsewhere, sessionId: 's9', toolName: 'Read' })).toEqual({ beat: false, reason: 'not-soaking' });
  });

  it('a worktree soak created is marked on every sign-on, from its anchor', () => {
    const reg = trap('s1', 'web');
    expect(reg.createdWorktree).toBeUndefined();
    writeTrapAnchor(reg.worktree, { trapId: reg.trapId, createdBy: 'soak', sessionId: 's1', repo: 'web', branch: 'lobstah/soak-x' });
    stowTrap(reg.trapId);
    const again = trap('s1', 'web');
    expect(again).toMatchObject({ trapId: reg.trapId, createdWorktree: true });
    expect(soakWorktreeFor(path.dirname(reg.worktree), 's1', 'web')).toBe(reg.worktree);
    expect(soakWorktreeFor(path.dirname(reg.worktree), 's2', 'web')).toBeUndefined();
    expect(anchoredWorktree(path.dirname(reg.worktree), reg.trapId)).toBe(reg.worktree);
  });

  it('beats without a catch refresh liveness only', () => {
    const reg = trap('s1', 'web');
    expect(beatTrap({ cwd: reg.worktree, toolName: 'Read' })).toEqual({ beat: true, trapId: reg.trapId });
  });

  it('the ghost sweep honors a fresh beat, then sweeps once it goes stale', () => {
    const reg = caught('s1', 'w1');
    const ttl = 120_000;
    const beatAt = Date.parse(reg.heartbeatAt) + 100_000;
    beatTrap({ cwd: reg.worktree, toolName: 'Bash', now: beatAt });
    // Heartbeat and claim entry are both past the TTL; the beat is not.
    expect(sweepGhostTraps(ttl, beatAt + ttl)).toEqual([]);
    expect(readTrap(reg.trapId)).toBeDefined();
    expect(sweepGhostTraps(ttl, beatAt + ttl + 1)).toEqual([{ trapId: reg.trapId, requeued: 'w1' }]);
    expect(readBeat(reg.trapId)).toBeUndefined();
  });

  it('a live beat holds the session lock like a live heartbeat', () => {
    const reg = trap('s1', 'web');
    const later = Date.parse(reg.heartbeatAt) + TTL_MS + 60_000;
    beatTrap({ cwd: reg.worktree, now: later - 1000 });
    const res = signOnTrap({ sessionId: 's2', harness: 'claude', repo: 'web', worktree: reg.worktree, cwd: reg.worktree, ttlMs: TTL_MS, now: later });
    expect('held' in res).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendStatus, claimBait, daemonSkip, dispatchQueueReason, enqueue, ensureLayout, guardNewTraps, heartbeatTrap, listRoster,
  loadConfig, queuedDescriptor, readRoster, readTrap, repoTrapCount, reserveTrap, selectRepoTrap, signOnTrap, stowTrap, sweepGhostTraps, trapAvailability } from '../src/index.js';
import type { TrapRegistration } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const NOW = Date.parse('2026-10-12T12:00:00Z');
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-reuse-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.mkdirSync(path.join(home, 'repo'));
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = '${path.join(home, 'repo')}'\ntraps = 2\n`);
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

function trap(name: string, harness = 'claude', repo = 'r'): TrapRegistration {
  const worktree = path.join(home, name);
  fs.mkdirSync(worktree);
  const r = signOnTrap({ name, harness, repo, worktree, cwd: worktree, sessionId: name, ttlMs: 60_000, now: NOW });
  if (!('ok' in r)) throw new Error('held');
  return r.ok;
}
function busy(r: TrapRegistration, id = 'job'): TrapRegistration {
  enqueue({ id, repo: 'r', brief: 'b', for: `wt:${r.trapId}` });
  expect(claimBait(r)?.id).toBe(id);
  return readTrap(r.trapId)!;
}

describe('trap availability and selection', () => {
  for (const verb of ['done', 'failed', 'paused', 'needs-decision', 'blocked', 'working'] as const) {
    it(`${verb}: terminal claims are free, all open catches stay busy`, () => {
      const r = busy(trap('amber-gull'));
      appendStatus('job', 'work', verb, 'note', '2026-10-12T11:57:00Z', verb === 'paused' ? { waitingOn: 'external' } : {});
      const view = trapAvailability(r, NOW);
      expect(view.state).toBe(['done', 'failed'].includes(verb) ? 'free' : 'busy');
      if (view.state === 'busy') expect(view.text).toBe(`busy on job (${verb}, 3m)`);
      else expect(view.dispatch).toBeUndefined();
    });
  }

  it('does not select a trap with sticky work already queued to it', () => {
    const r = trap('amber-gull');
    enqueue({ id: 'queued', repo: 'r', brief: 'b', for: `wt:${r.trapId}`, queuedAt: '2026-10-12T11:59:00Z' });
    expect(trapAvailability(r, NOW).text).toBe('busy on queued (queued, 60s)');
    expect(selectRepoTrap(loadConfig(), 'r', undefined, NOW).action).toBe('new');
  });

  it('selects free live before stowed, matches harness, and excludes quiet registrations', () => {
    const stowed = trap('amber-gull');
    stowTrap(stowed.trapId);
    const live = trap('kind-crab', 'codex');
    expect(selectRepoTrap(loadConfig(), 'r', undefined, NOW)).toMatchObject({ action: 'reuse', registration: { trapId: live.trapId } });
    expect(selectRepoTrap(loadConfig(), 'r', 'claude', NOW)).toMatchObject({ action: 'return', row: { trapId: stowed.trapId } });
    // The codex trap has gone quiet but is still registered: it holds a slot; the stowed one doesn't, so there is room for a new one.
    expect(selectRepoTrap(loadConfig(), 'r', 'codex', NOW + 3600_000).action).toBe('new');
  });

  it('prefers a listening free trap and skips failed return candidates', () => {
    const unparked = trap('amber-gull');
    const listening = trap('zippy-crab', 'codex');
    heartbeatTrap(listening.trapId, { parked: true });
    expect(selectRepoTrap(loadConfig(), 'r', undefined, NOW)).toMatchObject({ action: 'reuse', registration: { trapId: listening.trapId } });
    stowTrap(unparked.trapId); stowTrap(listening.trapId);
    expect(selectRepoTrap(loadConfig(), 'r', undefined, NOW, new Set([unparked.trapId]))).toMatchObject({ action: 'return', row: { trapId: listening.trapId } });
  });

  it('returns a safely stowed trap before creating, otherwise creates below capacity', () => {
    expect(selectRepoTrap(loadConfig(), 'r', undefined, NOW).action).toBe('new');
    const r = trap('amber-gull');
    stowTrap(r.trapId);
    expect(selectRepoTrap(loadConfig(), 'r', undefined, NOW)).toMatchObject({ action: 'return', row: { trapId: r.trapId } });
    fs.rmSync(r.worktree, { recursive: true }); // no protected ref: not safe to recreate
    expect(selectRepoTrap(loadConfig(), 'r', undefined, NOW).action).toBe('new');
  });

  it('at the count waits trap-only, reports all busy, and binds the first free claimant stickily', () => {
    const a = busy(trap('amber-gull'), 'a');
    busy(trap('kind-crab', 'codex'), 'b');
    const cfg = loadConfig();
    expect(selectRepoTrap(cfg, 'r', undefined, NOW)).toEqual({ action: 'wait', why: 'all 2 r traps are busy' });
    const d = { id: 'waiting', repo: 'r', brief: 'b', trapAny: true, harness: 'claude' };
    enqueue(d);
    expect(dispatchQueueReason(d, 'work', cfg, NOW)).toBe('all 2 r traps are busy; waiting for a claude trap');
    expect(daemonSkip([], 0, NOW)(d)).toBe(true);
    const wrong = trap('young-foam', 'codex');
    expect(claimBait(wrong)).toBeNull();
    appendStatus('a', 'work', 'done');
    expect(claimBait(a)).toMatchObject({ id: 'waiting', descriptor: { for: `wt:${a.trapId}`, trapAny: true } });
    expect(queuedDescriptor('waiting', 'work')).toBeUndefined();
    expect(claimBait(wrong)).toBeNull();
  });

  it('trap-only chores also wait for the matching harness', () => {
    const a = trap('amber-gull');
    const b = trap('kind-crab', 'codex');
    enqueue({ id: 'chore', repo: 'r', brief: 'b', trapAny: true, harness: 'claude' }, 'chore');
    expect(claimBait(b)).toBeNull();
    expect(claimBait(a)?.lane).toBe('chore');
  });
});

describe('new guard and roster capacity', () => {
  it('requires a nonblank reason when free or stowed traps exist; capacity cannot be overridden', () => {
    const a = trap('amber-gull');
    const cfg = loadConfig();
    expect(() => guardNewTraps(cfg, 'r', 1)).toThrow('--reason');
    expect(() => guardNewTraps(cfg, 'r', 1, '   ')).toThrow('--reason');
    expect(() => guardNewTraps(cfg, 'r', 1, 'need another harness')).not.toThrow();
    stowTrap(a.trapId);
    expect(() => guardNewTraps(cfg, 'r', 1)).toThrow('stowed');
    trap('kind-crab');
    trap('young-foam');
    expect(repoTrapCount(cfg, 'r')).toMatchObject({ used: 2, limit: 2, stowed: 1, ghosted: 0, text: '2/2 traps in use +1 stowed/ghosted' });
    expect(() => guardNewTraps(cfg, 'r', 1, 'reason')).toThrow('cannot bring 1 more into use');
  });

  it('counts ghosted and new reservations once, and reports a lowered cap without removing records', () => {
    const a = trap('amber-gull');
    heartbeatTrap(a.trapId, { parked: true });
    sweepGhostTraps(1000, Date.now() + 60_000);
    expect(readRoster(a.trapId)?.state).toBe('ghosted');
    const b = reserveTrap({ repo: 'r' }).reservation;
    // The ghosted trap holds no slot; the starting reservation does.
    expect(repoTrapCount(loadConfig(), 'r')).toMatchObject({ used: 1, ghosted: 1, stowed: 0 });
    const cfg = loadConfig(); cfg.repos.r!.traps = 0;
    expect(repoTrapCount(cfg, 'r').text).toContain('over limit');
    expect(listRoster()).toHaveLength(1);
    expect(b.trapId).not.toBe(a.trapId);
    expect(() => guardNewTraps(cfg, 'r', 1, 'reason')).toThrow('cannot bring');
  });

  it('counts only traps in use: free and busy live ones and starting ones; stowed, ghosted and held ones show apart', () => {
    const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-claude-'));
    process.env.CLAUDE_CONFIG_DIR = claude;
    try {
      fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = '${path.join(home, 'repo')}'\ntraps = 3\n`);
      const cfg = loadConfig();
      // Stowed, and two ghosted: one whose Claude session is still running (held).
      stowTrap(trap('stowed-one').trapId);
      const ghost = trap('ghost-gone');
      const held = trap('ghost-held');
      for (const r of [ghost, held]) heartbeatTrap(r.trapId, { parked: true });
      sweepGhostTraps(1000, Date.now() + 60_000);
      fs.mkdirSync(path.join(claude, 'sessions'));
      fs.writeFileSync(path.join(claude, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'ghost-held' }));
      // In use: one free, one busy, one starting.
      const free = trap('free-one');
      busy(trap('busy-one'));
      reserveTrap({ repo: 'r' });
      const count = repoTrapCount(cfg, 'r');
      expect(count).toMatchObject({ used: 3, limit: 3, stowed: 1, ghosted: 2, held: ['ghost-held'] });
      expect(count.names).toEqual(expect.arrayContaining(['free-one', 'busy-one']));
      expect(count.text).toBe('3/3 traps in use +3 stowed/ghosted; ghost-held ghosted with its session still open (end it)');
      // A free trap in use takes the work; once it's busy too, neither a new trap nor a stowed one coming back gets a slot: the work waits.
      expect(selectRepoTrap(cfg, 'r', undefined, NOW)).toMatchObject({ action: 'reuse', registration: { trapId: free.trapId } });
      busy(free, 'job2');
      expect(selectRepoTrap(cfg, 'r', undefined, NOW).action).toBe('wait');
      expect(() => guardNewTraps(cfg, 'r', 1, 'reason')).toThrow('3/3 traps in use');
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
      removeTempDir(claude);
    }
  });

  it('missing limit is unlimited; creation reason survives stow and return', () => {
    const cfg = loadConfig(); delete cfg.repos.r!.traps;
    expect(() => guardNewTraps(cfg, 'r', 20)).not.toThrow();
    const dir = path.join(home, 'reason'); fs.mkdirSync(dir);
    const r = signOnTrap({ name: 'amber-gull', harness: 'claude', repo: 'r', worktree: dir, cwd: dir, sessionId: 's', ttlMs: 1, creationReason: 'different harness needed', now: NOW });
    if (!('ok' in r)) throw new Error('held');
    stowTrap(r.ok.trapId);
    signOnTrap({ worktree: dir, cwd: dir, repo: 'r', harness: 'claude', sessionId: 's2', ttlMs: 1, now: NOW + 1000 });
    expect(readRoster(r.ok.trapId)?.creationReason).toBe('different harness needed');
  });
});

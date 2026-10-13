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
    expect(selectRepoTrap(loadConfig(), 'r', 'codex', NOW + 3600_000).action).toBe('wait');
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
    expect(repoTrapCount(cfg, 'r')).toMatchObject({ used: 2, limit: 2, text: '2/2 traps' });
    expect(() => guardNewTraps(cfg, 'r', 1, 'reason')).toThrow('cannot create');
  });

  it('counts ghosted and new reservations once, and reports a lowered cap without removing records', () => {
    const a = trap('amber-gull');
    heartbeatTrap(a.trapId, { parked: true });
    sweepGhostTraps(1000, Date.now() + 60_000);
    expect(readRoster(a.trapId)?.state).toBe('ghosted');
    const b = reserveTrap({ repo: 'r' }).reservation;
    expect(repoTrapCount(loadConfig(), 'r').used).toBe(2);
    const cfg = loadConfig(); cfg.repos.r!.traps = 0;
    expect(repoTrapCount(cfg, 'r').text).toContain('over limit');
    expect(listRoster()).toHaveLength(1);
    expect(b.trapId).not.toBe(a.trapId);
    expect(() => guardNewTraps(cfg, 'r', 1, 'reason')).toThrow('cannot create');
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

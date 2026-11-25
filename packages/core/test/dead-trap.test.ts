import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, beatTrap, claimBait, enqueue, ensureLayout, readRoster, readTrap, signOnTrap, sweepGhostTraps, trapSessionLiveness, type TrapRegistration } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let claudeHome: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-dead-trap-'));
  claudeHome = path.join(home, 'claude');
  process.env.LOBSTAH_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  removeTempDir(home);
});

/** A legacy Claude registration with no captured harness process. */
function legacyTrap(): TrapRegistration {
  const worktree = path.join(home, 'checkout');
  fs.mkdirSync(worktree);
  const signed = signOnTrap({ worktree, cwd: worktree, harness: 'claude', repo: 'web', sessionId: 'legacy-session', ttlMs: 1800_000 });
  if (!('ok' in signed)) throw new Error('unexpected hold');
  return signed.ok;
}

it('uses Claude session records to release a legacy dead session without ever parking', () => {
  const reg = legacyTrap();
  expect(trapSessionLiveness(reg)).toBe('unknown');
  fs.mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true });
  expect(trapSessionLiveness(reg)).toBe('dead');
  enqueue({ id: 'work', repo: 'web', for: `wt:${reg.trapId}`, brief: 'task' });
  claimBait(reg);
  const later = Date.now() + 120_001;
  expect(sweepGhostTraps(1800_000, later)).toMatchObject([{ trapId: reg.trapId, requeued: 'work' }]);
  expect(readTrap(reg.trapId)).toBeUndefined();
  expect(readRoster(reg.trapId)).toMatchObject({ state: 'ghosted', sessionId: 'legacy-session', worktree: reg.worktree });
  expect(fs.existsSync(reg.worktree)).toBe(true);
});

it('keeps a legacy session with a live process even after its heartbeat expires', () => {
  const reg = legacyTrap();
  fs.mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: reg.sessionId }));
  expect(trapSessionLiveness(reg)).toBe('alive');
  expect(sweepGhostTraps(1800_000, Date.now() + 7200_000)).toEqual([]);
});

it.each(['report', 'beat'] as const)('a fresh %s protects a dead session until it goes quiet', (signal) => {
  const reg = legacyTrap();
  fs.mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true });
  enqueue({ id: 'work', repo: 'web', for: `wt:${reg.trapId}`, brief: 'task' });
  claimBait(reg);
  const at = Date.now() + 100_000;
  if (signal === 'report') appendStatus('work', 'work', 'working', 'progress', new Date(at).toISOString());
  else beatTrap({ cwd: reg.worktree, sessionId: reg.sessionId, now: at });
  expect(sweepGhostTraps(1800_000, at + 120_000)).toEqual([]);
  expect(sweepGhostTraps(1800_000, at + 120_001)).toMatchObject([{ trapId: reg.trapId, requeued: 'work' }]);
});

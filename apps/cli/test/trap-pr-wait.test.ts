import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimBait, claimNext, enqueue, ensureLayout, mergeEvidence, readStatusLog, readTrap, signOnTrap, trapAvailability } from '@lobstah/core';
import type { TrapRegistration } from '@lobstah/core';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * A trap never parks on its own PR's CI or review: `report paused
 * --waiting-on pr|review` about its own PR is recorded as `done --pr`, which
 * frees the trap; the PR's watch starts the next round. Other waits, and
 * headless dispatches, keep their pause.
 */

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const PR = 'https://github.com/acme/web/pull/7';
let home: string;
let bin: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-trap-pr-wait-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.mkdirSync(path.join(home, 'repo'));
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.web]\npath = '${path.join(home, 'repo')}'\ntraps = 1\n`);
  // No GitHub here: a gh that always fails.
  bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const report = (...args: string[]) =>
  spawnSync(process.execPath, [cli, 'report', ...args], {
    env: { ...process.env, LOBSTAH_HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    encoding: 'utf8',
    timeout: 20_000,
  });

function trapOn(id: string): TrapRegistration {
  const worktree = path.join(home, 'wt');
  fs.mkdirSync(worktree, { recursive: true });
  const r = signOnTrap({ name: 'amber-gull', harness: 'claude', repo: 'web', worktree, cwd: worktree, sessionId: 's1', ttlMs: 60_000 });
  if (!('ok' in r)) throw new Error('held');
  enqueue({ id, repo: 'web', brief: 'b', for: `wt:${r.ok.trapId}` });
  expect(claimBait(r.ok)?.id).toBe(id);
  mergeEvidence(id, 'work', { prUrl: PR });
  return readTrap(r.ok.trapId)!;
}

describe('a trap waiting on its own PR', () => {
  it.each(['review', 'pr'])('paused --waiting-on %s is recorded as done --pr, and frees the trap', (waitingOn) => {
    const trap = trapOn('job');
    expect(trapAvailability(trap).state).toBe('busy');
    const out = report('job', 'paused', 'PR is up; waiting for review', '--waiting-on', waitingOn);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain(`recorded done --pr ${PR}`);
    expect(readStatusLog('job', 'work').at(-1)).toMatchObject({ verb: 'done', note: 'PR is up; waiting for review' });
    expect(readStatusLog('job', 'work').at(-1)?.waitingOn).toBeUndefined();
    expect(trapAvailability(readTrap(trap.trapId)!).state).toBe('free');
  });

  it('with --link to its own PR too', () => {
    trapOn('job');
    expect(report('job', 'paused', 'in review', '--waiting-on', 'review', '--link', PR).status).toBe(0);
    expect(readStatusLog('job', 'work').at(-1)?.verb).toBe('done');
  });
});

describe('waits that keep their pause', () => {
  it('a trap waiting on another PR it depends on, or on a deploy, stays paused', () => {
    trapOn('job');
    expect(report('job', 'paused', 'needs #9 first', '--waiting-on', 'pr', '--link', 'https://github.com/acme/api/pull/9').status).toBe(0);
    expect(readStatusLog('job', 'work').at(-1)).toMatchObject({ verb: 'paused', waitingOn: 'pr' });
    expect(report('job', 'paused', 'deploying', '--waiting-on', 'deploy').status).toBe(0);
    expect(readStatusLog('job', 'work').at(-1)).toMatchObject({ verb: 'paused', waitingOn: 'deploy' });
  });

  it('a headless dispatch waiting on its PR stays paused', () => {
    enqueue({ id: 'headless', repo: 'web', brief: 'b' });
    expect(claimNext('work')).toBe('headless');
    mergeEvidence('headless', 'work', { prUrl: PR });
    expect(report('headless', 'paused', 'in review', '--waiting-on', 'review').status).toBe(0);
    expect(readStatusLog('headless', 'work').at(-1)).toMatchObject({ verb: 'paused', waitingOn: 'review' });
  });
});

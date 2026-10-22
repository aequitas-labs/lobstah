import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  appendStatus, cacheDirectories, claimBait, clearTrapCaches, enqueue, ensureLayout, GB, listNotices,
  loadConfig, planTrapCaches, readTrap, recoverTrapCaches, requestCancel, signOnTrap, stowTrap, validCacheGlob,
  withTrapCacheLock,
  type TrapRegistration,
} from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let repo: string;
const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const cache = (trap: TrapRegistration): string => path.join(trap.worktree, 'apps/web/.next/cache');

function config(patterns: string[] = ['apps/*/.next/cache', '.temp/*DerivedData*'], limit = 50): void {
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = ${JSON.stringify(repo)}\ncacheDirs = ${JSON.stringify(patterns)}\n[limits]\ncacheMinFreeGB = ${limit}\n`);
}
function trap(name: string, bytes = 8192): TrapRegistration {
  const worktree = path.join(home, 'worktrees', name);
  git(repo, 'worktree', 'add', '-b', name, worktree);
  const result = signOnTrap({ sessionId: name, harness: 'codex', repo: 'r', worktree, cwd: worktree, ttlMs: 60_000 });
  if (!('ok' in result)) throw new Error('trap sign-on failed');
  fs.mkdirSync(cache(result.ok), { recursive: true });
  fs.writeFileSync(path.join(cache(result.ok), 'build.bin'), Buffer.alloc(bytes, 1));
  return result.ok;
}
function working(reg: TrapRegistration): string {
  const id = `dispatch-${reg.trapId}`;
  enqueue({ id, repo: 'r', brief: 'work', for: `wt:${reg.trapId}` });
  expect(claimBait(reg)?.id).toBe(id);
  return id;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-caches-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  repo = path.join(home, 'repo'); fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'apps/\n.temp/\n');
  git(repo, 'add', '.gitignore'); git(repo, 'commit', '-m', 'init');
  config();
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

describe('cache deletion safety', () => {
  it('keeps lock paths inside their dedicated directory even with a traversal-shaped trap id', () => {
    withTrapCacheLock('..', () => expect(fs.existsSync(path.join(home, 'cache-locks/trap-..'))).toBe(true));
    expect(fs.existsSync(repo)).toBe(true);
  });
  it('validates relative globs and the pressure threshold before loading config', () => {
    expect(loadConfig().repos.r?.cacheDirs).toEqual(['apps/*/.next/cache', '.temp/*DerivedData*']);
    for (const pattern of ['', '../cache', 'apps/../cache', '/tmp/cache', 'C:/cache', 'C:\\cache', '\\\\server\\cache', '**/.git', '**/.GIT', '.', '**/..', 'bad\0path']) {
      expect(validCacheGlob(pattern), pattern).toBe(false);
      config([pattern]); expect(() => loadConfig()).toThrow('cacheDirs');
    }
    fs.writeFileSync(path.join(home, 'config.toml'), '[repos.r]\ncacheDirs = "cache"\n');
    expect(() => loadConfig()).toThrow('cacheDirs');
    for (const value of ['-1', '"50"', 'nan', 'inf']) {
      fs.writeFileSync(path.join(home, 'config.toml'), `[limits]\ncacheMinFreeGB = ${value}\n`);
      expect(() => loadConfig()).toThrow('cacheMinFreeGB');
    }
  });

  it('never follows a symlinked match or ancestor outside the worktree', () => {
    const reg = trap('safe');
    const outside = path.join(home, 'outside'); fs.mkdirSync(path.join(outside, '.next/cache'), { recursive: true });
    const precious = path.join(outside, '.next/cache/precious'); fs.writeFileSync(precious, 'keep');
    fs.symlinkSync(outside, path.join(reg.worktree, 'apps/leak'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.mkdirSync(path.join(reg.worktree, '.temp'), { recursive: true });
    fs.symlinkSync(outside, path.join(reg.worktree, '.temp/BuildDerivedData'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(clearTrapCaches(reg)).toBeGreaterThan(0);
    expect(fs.readFileSync(precious, 'utf8')).toBe('keep');
    expect(fs.existsSync(path.join(reg.worktree, '.temp/BuildDerivedData'))).toBe(true);
  });

  it('preserves a whole match containing even one tracked file, including newly staged files', () => {
    const reg = trap('tracked');
    const file = path.join(cache(reg), 'tracked.txt'); fs.writeFileSync(file, 'keep');
    git(reg.worktree, 'add', '-f', 'apps/web/.next/cache/tracked.txt');
    expect(clearTrapCaches(reg)).toBe(0);
    expect(fs.existsSync(path.join(cache(reg), 'build.bin'))).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('keep');
  });

  it('preserves a tracked path whose index casing differs from its filesystem casing', () => {
    const reg = trap('case-alias');
    const file = path.join(cache(reg), 'tracked.txt'); fs.writeFileSync(file, 'keep');
    const blob = git(reg.worktree, 'hash-object', '-w', file).trim();
    git(reg.worktree, 'update-index', '--add', '--cacheinfo', `100644,${blob},APPS/web/.next/cache/tracked.txt`);
    expect(clearTrapCaches(reg)).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('keep');
  });

  it('refuses primary checkouts, foreign repositories, and nested repository matches', () => {
    const reg = trap('identity');
    expect(clearTrapCaches({ ...reg, worktree: repo })).toBe(0);
    const cfg = loadConfig(); cfg.repos.r!.path = reg.worktree; // a linked checkout of the same repo is still the same identity
    expect(planTrapCaches(cfg)).toHaveLength(1);
    const foreign = path.join(home, 'foreign'); fs.mkdirSync(foreign); git(foreign, 'init');
    cfg.repos.r!.path = foreign;
    expect(clearTrapCaches(reg, cfg)).toBe(0);
    fs.mkdirSync(path.join(cache(reg), '.git'));
    expect(clearTrapCaches(reg)).toBe(0);
    expect(fs.existsSync(path.join(cache(reg), 'build.bin'))).toBe(true);
  });

  it('handles recursive globs and overlaps once, without matching the root or Git metadata', () => {
    const reg = trap('globs');
    const patterns = ['apps/**/cache', 'apps/*/.next/cache', '**'];
    const matches = cacheDirectories(reg.worktree, patterns);
    expect(matches).toEqual([path.join(reg.worktree, 'apps')]);
    expect(matches).not.toContain(reg.worktree);
    expect(fs.existsSync(path.join(reg.worktree, '.git'))).toBe(true);
  });
});

describe('trap lifecycle and pressure cleanup', () => {
  it('never clears a working trap; a paused report keeps caches until pressure cleanup', () => {
    const reg = trap('working'); const id = working(reg);
    expect(planTrapCaches()).toEqual([]);
    expect(clearTrapCaches(reg)).toBe(0);
    expect(recoverTrapCaches(loadConfig(), home, () => 0)).toBe(0);
    expect(fs.existsSync(cache(reg))).toBe(true);
    appendStatus(id, 'work', 'paused', 'waiting for CI');
    expect(fs.existsSync(cache(reg))).toBe(true);
    expect(recoverTrapCaches(loadConfig(), home, () => 0)).toBeGreaterThan(0);
    expect(fs.existsSync(cache(reg))).toBe(false);
  });

  it.each(['done', 'failed'])('clears caches and logs bytes on a %s report', (verb) => {
    const reg = trap(verb); const id = working(reg);
    appendStatus(id, 'work', verb, 'finished');
    expect(fs.existsSync(cache(reg))).toBe(false);
    expect(listNotices(20).some((notice) => notice.kind === 'caches-cleared' && notice.text.includes('cache bytes'))).toBe(true);
  });

  it('clears on stow and after cancellation completes, never just on a cancellation request', () => {
    const stowed = trap('stowed'); working(stowed);
    stowTrap(stowed.trapId);
    expect(fs.existsSync(cache(stowed))).toBe(false);
    const cancelled = trap('cancelled'); const id = working(cancelled);
    requestCancel(id, 'work');
    expect(fs.existsSync(cache(cancelled))).toBe(true);
    appendStatus(id, 'work', 'failed', 'cancelled');
    expect(fs.existsSync(cache(cancelled))).toBe(false);
  });

  it('clears biggest idle traps first, stops at the threshold, and announces recovered space', () => {
    config(undefined, 0.0004);
    const small = trap('small', 100_000), big = trap('big', 300_000), medium = trap('medium', 200_000);
    const busy = trap('busy', 900_000); working(busy);
    const order: string[] = [];
    const read = (): number => {
      for (const reg of [big, medium, small]) if (!fs.existsSync(cache(reg)) && !order.includes(reg.sessionId)) order.push(reg.sessionId);
      return [big, medium, small].reduce((sum, reg) => sum + (fs.existsSync(cache(reg)) ? 0 : reg === big ? 300_000 : reg === medium ? 200_000 : 100_000), 0);
    };
    expect(planTrapCaches().map((plan) => plan.trapId)).toEqual([big.trapId, medium.trapId, small.trapId]);
    expect(recoverTrapCaches(loadConfig(), home, read)).toBeGreaterThan(0);
    expect(order).toEqual(['big', 'medium']);
    expect(fs.existsSync(cache(small))).toBe(true);
    expect(fs.existsSync(cache(busy))).toBe(true);
    expect(listNotices(30).find((notice) => notice.kind === 'caches-cleared')?.text).toContain('2 idle trap(s)');
  });

  it('rechecks a preview when a trap starts working and leaves unconfigured repos unchanged', () => {
    const reg = trap('raced'); expect(planTrapCaches()).toHaveLength(1);
    working(reg);
    expect(clearTrapCaches(reg)).toBe(0);
    expect(readTrap(reg.trapId)?.claimed).toBeDefined();
    const cfg = loadConfig(); delete cfg.repos.r!.cacheDirs;
    let reads = 0;
    expect(recoverTrapCaches(cfg, home, () => { reads++; return 0; })).toBe(0);
    expect(reads).toBe(0);
    expect(planTrapCaches(cfg)).toEqual([]);
    expect(fs.existsSync(cache(reg))).toBe(true);
  });

  it('preserves lifecycle behavior without cacheDirs and can disable pressure cleanup independently', () => {
    const reg = trap('opt-out');
    config(undefined, 0);
    expect(recoverTrapCaches(loadConfig(), home, () => { throw new Error('must not read'); })).toBe(0);
    fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = ${JSON.stringify(repo)}\n`);
    expect(loadConfig().limits.cacheMinFreeGB).toBe(50);
    const id = working(reg);
    appendStatus(id, 'work', 'done');
    stowTrap(reg.trapId);
    expect(fs.existsSync(cache(reg))).toBe(true);
  });

  it('includes retained stowed worktrees left with caches by an older install', () => {
    const reg = trap('old-stowed'); stowTrap(reg.trapId);
    fs.mkdirSync(cache(reg), { recursive: true });
    fs.writeFileSync(path.join(cache(reg), 'leftover.bin'), Buffer.alloc(8192, 1));
    expect(planTrapCaches().map((plan) => plan.trapId)).toEqual([reg.trapId]);
    expect(recoverTrapCaches(loadConfig(), home, () => 0)).toBeGreaterThan(0);
    expect(fs.existsSync(cache(reg))).toBe(false);
  });
});

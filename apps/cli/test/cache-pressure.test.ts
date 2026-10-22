import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureLayout, GB, listNotices, loadConfig, signOnTrap } from '@lobstah/core';
import { spaceGuard } from '@lobstah/supervisor';
import { createSoakWorktree } from '../src/soak-worktree.js';
import { runCull } from '../src/cull.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string, repo: string, cache: string;
const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const free = (): number => fs.existsSync(cache) ? 0 : GB;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-cache-pressure-'));
  process.env.LOBSTAH_HOME = home; ensureLayout();
  repo = path.join(home, 'repo'); fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.cache/\n');
  git(repo, 'add', '.gitignore'); git(repo, 'commit', '-m', 'init');
  const origin = path.join(home, 'origin.git'); git(home, 'clone', '--bare', repo, origin);
  git(repo, 'remote', 'add', 'origin', origin);
  const worktree = path.join(home, 'worktrees/idle'); git(repo, 'worktree', 'add', '-b', 'idle', worktree);
  signOnTrap({ sessionId: 'idle', harness: 'codex', repo: 'r', worktree, cwd: worktree, ttlMs: 60_000 });
  cache = path.join(worktree, '.cache'); fs.mkdirSync(cache); fs.writeFileSync(path.join(cache, 'build.bin'), Buffer.alloc(16_384, 1));
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = ${JSON.stringify(repo)}\ncacheDirs = [".cache"]\n[limits]\nminFreeGB = 0.00001\ncacheMinFreeGB = 0.00001\n`);
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

it('recovers idle caches before the daemon culler can remove a whole worktree', () => {
  let culls = 0;
  expect(spaceGuard(loadConfig(), { freeBytes: free, culler: {
    retention: () => 0, pressure: () => { culls++; return 0; },
  } }, () => {})).toBe(true);
  expect(culls).toBe(0);
  expect(fs.existsSync(cache)).toBe(false);
  expect(listNotices(20).some((notice) => notice.kind === 'caches-cleared')).toBe(true);
});

it('recovers idle caches before refusing a fresh trap for low space', async () => {
  const made = await createSoakWorktree({ repoKey: 'r', repo: loadConfig().repos.r!, sessionId: 'new-trap', minFreeGB: 0.00001, freeBytes: free });
  expect(fs.existsSync(made.dir)).toBe(true);
  expect(fs.existsSync(cache)).toBe(false);
});

it('cull previews clearable cache space without deleting it', () => {
  const output = runCull(365, false, free);
  expect(output).toMatch(/caches: .* GB clearable in 1 idle trap\(s\)/);
  expect(fs.existsSync(cache)).toBe(true);
});

it('an applied cull clears caches under pressure while keeping the live worktree', () => {
  const output = runCull(365, true, free);
  expect(output).toContain('cache pressure cleanup');
  expect(fs.existsSync(cache)).toBe(false);
  expect(fs.existsSync(path.dirname(cache))).toBe(true);
});

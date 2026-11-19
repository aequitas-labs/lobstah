import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  appendStatus, enqueue, ensureLayout, GB, laneDirs, loadConfig, planReviewWaitCaches,
  readPr, recoverTrapCaches, reviewWaitWorktrees, upsertPr, worktreeGitDir, writePr,
} from '@lobstah/core';
import { planPressureCull, applyCull, runCull } from '../src/cull.js';
import { runCullWorker } from '../src/background-cull.js';
import { diskRow } from '../src/doctor.js';
import { chooseWorktree, prepareReuse } from '@lobstah/worktree';
import { removeTempDir } from '../../../test/temp-dir.js';
import type { PrEvidence } from '@lobstah/core';

let home: string;
let repo: string;
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
  cwd, encoding: 'utf8', stdio: 'pipe',
}).trim();

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-review-pressure-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  repo = path.join(home, 'repo'); fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\ncache/\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'initial');
  const origin = path.join(home, 'origin.git');
  git(repo, 'clone', '-q', '--bare', repo, origin);
  git(repo, 'remote', 'add', 'origin', origin); git(repo, 'fetch', '-q', 'origin');
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = ${JSON.stringify(repo)}\ntrunk = "main"\ncacheDirs = ["node_modules", "cache"]\n[limits]\nminFreeGB = 10\ncacheMinFreeGB = 20\n`);
});
afterEach(() => { vi.restoreAllMocks(); removeTempDir(home); delete process.env.LOBSTAH_HOME; });

/** A finished implementation whose observed PR has green checks and needs a review. */
function waiting(id = 'implementation', number = 1): string {
  const directory = path.join(home, 'worktrees', id);
  git(repo, 'worktree', 'add', '-q', '-b', id, directory);
  const done = path.join(laneDirs('work').done, id); fs.mkdirSync(done);
  fs.writeFileSync(path.join(done, 'descriptor.json'), JSON.stringify({ id, repo: 'r', brief: 'finished' }));
  appendStatus(id, 'work', 'done', 'ready for review');
  upsertPr({ url: `https://github.com/o/r/pull/${number}`, number, state: 'OPEN', draft: false,
    headSha: git(directory, 'rev-parse', 'HEAD'), headRefName: id, baseRefName: 'main',
    reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED',
    review: { unresolvedThreads: 0, changesRequested: false },
    checks: { total: 1, passed: 1, failed: 0, pending: 0 }, observedAt: new Date().toISOString(),
  } satisfies PrEvidence, id);
  for (const name of ['node_modules', 'cache']) {
    fs.mkdirSync(path.join(directory, name)); fs.writeFileSync(path.join(directory, name, 'data'), Buffer.alloc(8192));
  }
  return directory;
}

it('clears review-wait caches first and keeps the checkout when that recovers enough space', async () => {
  const directory = waiting();
  const stamp = path.join(worktreeGitDir(directory)!, 'lobstah-setup.json'); fs.writeFileSync(stamp, '{}');
  expect(planReviewWaitCaches()).toHaveLength(1);
  const free = () => fs.existsSync(path.join(directory, 'node_modules')) ? GB : 30 * GB;
  await runCullWorker(Date.now(), () => {}, free);
  expect(fs.existsSync(path.join(directory, 'node_modules'))).toBe(false);
  expect(fs.existsSync(path.join(directory, 'cache'))).toBe(false);
  expect(fs.existsSync(stamp)).toBe(false);
  expect(fs.existsSync(directory)).toBe(true);
});

it('removes clean published review-wait checkouts after caches, including under cacheMinFreeGB alone', async () => {
  const directory = waiting();
  fs.writeFileSync(path.join(home, 'config.toml'), fs.readFileSync(path.join(home, 'config.toml'), 'utf8').replace('minFreeGB = 10', 'minFreeGB = 0'));
  const events: string[] = [];
  const free = () => !fs.existsSync(directory) ? 30 * GB : fs.existsSync(path.join(directory, 'node_modules')) ? GB : 5 * GB;
  await runCullWorker(Date.now(), (message) => events.push(message), free);
  expect(events.findIndex((event) => event.startsWith('cache pressure cleanup:'))).toBeLessThan(events.findIndex((event) => event.startsWith('free-space cull:')));
  expect(fs.existsSync(directory)).toBe(false);
  expect(fs.existsSync(path.join(laneDirs('work').done, 'implementation'))).toBe(true);
  expect(readPr('pr:o/r#1')!.state).toBe('OPEN');
  expect(git(repo, 'branch', '--list', 'implementation')).toContain('implementation');
  enqueue({ id: 'next-round', repo: 'r', brief: 'continue', followUp: 'implementation' });
  expect(await chooseWorktree({ id: 'next-round', lane: 'work', repoKey: 'r', repo: loadConfig().repos.r!, followUp: 'implementation' })).toMatchObject({ reuse: false, reason: 'origin worktree is gone' });
});

it('reruns setup when a cache was cleared without a lockfile change', async () => {
  const directory = waiting();
  const repoConfig = { ...loadConfig().repos.r!, setup: ['node -e "require(\'fs\').mkdirSync(\'node_modules\',{recursive:true})"'] };
  await prepareReuse(repoConfig, directory);
  recoverTrapCaches(loadConfig(), path.join(home, 'worktrees'), () => GB);
  expect(fs.existsSync(path.join(directory, 'node_modules'))).toBe(false);
  expect(await prepareReuse(repoConfig, directory)).toEqual({ setupRan: true });
  expect(fs.existsSync(path.join(directory, 'node_modules'))).toBe(true);
});

it.each(['dirty', 'unpushed'])('keeps %s review-wait work when whole-worktree cleanup runs', (reason) => {
  const directory = waiting();
  fs.writeFileSync(path.join(directory, 'work.txt'), 'local work');
  if (reason === 'unpushed') { git(directory, 'add', 'work.txt'); git(directory, 'commit', '-qm', 'local only'); }
  expect(planPressureCull()).toEqual([]);
  expect(runCull(0, false)).toContain(`1 ${reason},`);
  expect(diskRow(loadConfig(), () => GB).detail).toContain(`1 ${reason},`);
  expect(fs.existsSync(path.join(directory, 'work.txt'))).toBe(true);
});

it('explains open-PR retention and sizes it in both previews', () => {
  const directory = waiting();
  const pr = readPr('pr:o/r#1')!; pr.checks.pending = 1; pr.checks.passed = 0; writePr(pr);
  expect(reviewWaitWorktrees()).toEqual([]);
  expect(runCull(0, false)).toContain('1 kept for open PRs,');
  expect(diskRow(loadConfig(), () => GB).detail).toContain('1 kept for open PRs,');
  expect(fs.existsSync(directory)).toBe(true);
});

it.each(['pending', 'failed', 'unknown', 'conflict', 'feedback', 'draft', 'approved', 'unobserved'])('preserves PR checkouts that are %s rather than only waiting for review', (condition) => {
  waiting();
  const pr = readPr('pr:o/r#1')!;
  if (condition === 'pending') pr.checks.pending = 1;
  if (condition === 'failed') pr.checks.failed = 1;
  if (condition === 'unknown') pr.checks.unknown = 'no permission';
  if (condition === 'conflict') pr.mergeStateStatus = 'DIRTY';
  if (condition === 'feedback') pr.review!.unresolvedThreads = 1;
  if (condition === 'draft') pr.draft = true;
  if (condition === 'approved') pr.reviewDecision = 'APPROVED';
  if (condition === 'unobserved') pr.discoveryPending = true;
  writePr(pr);
  expect(reviewWaitWorktrees()).toEqual([]);
  expect(planReviewWaitCaches()).toEqual([]);
  expect(planPressureCull()).toEqual([]);
});

it('rechecks shared-checkout use after planning, before removing caches or the checkout', () => {
  const directory = waiting();
  const plan = planPressureCull(); expect(plan).toHaveLength(1);
  enqueue({ id: 'followup', repo: 'r', brief: 'continue', followUp: 'implementation' });
  expect(recoverTrapCaches(loadConfig(), path.join(home, 'worktrees'), () => GB)).toBe(0);
  expect(applyCull(plan)).toEqual([]);
  expect(fs.existsSync(path.join(directory, 'node_modules'))).toBe(true);
});

it('rechecks PR state after planning, before removing a checkout', () => {
  const directory = waiting();
  const plan = planPressureCull();
  const pr = readPr('pr:o/r#1')!; pr.review!.changesRequested = true; writePr(pr);
  expect(applyCull(plan)).toEqual([]);
  expect(fs.existsSync(directory)).toBe(true);
});


it('requires every PR sharing a checkout to be only waiting for review', () => {
  waiting();
  const second = { ...readPr('pr:o/r#1')!, url: 'https://github.com/o/r/pull/2', number: 2,
    checks: { total: 1, passed: 0, failed: 1, pending: 0 } };
  upsertPr(second, 'implementation');
  expect(reviewWaitWorktrees()).toEqual([]);
  expect(planPressureCull()).toEqual([]);
});

it.each(['dirty', 'unpushed'])('preserves work that becomes %s after the pressure plan', (reason) => {
  const directory = waiting();
  const plan = planPressureCull(); expect(plan).toHaveLength(1);
  fs.writeFileSync(path.join(directory, 'new-work.txt'), 'keep');
  if (reason === 'unpushed') { git(directory, 'add', 'new-work.txt'); git(directory, 'commit', '-qm', 'new local work'); }
  expect(applyCull(plan)).toEqual([]);
  expect(fs.existsSync(path.join(directory, 'new-work.txt'))).toBe(true);
});

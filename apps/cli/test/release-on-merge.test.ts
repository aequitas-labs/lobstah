import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  appendStatus,
  claimNext,
  enqueue,
  ensureLayout,
  laneDirs,
  listNotices,
  loadConfig,
  mergeEvidence,
  prRecordFile,
  readEvidence,
  readKeptWorktrees,
  signOnTrap,
  readPr,
  upsertPr,
} from '@lobstah/core';
import { planCull, planPressureCull } from '../src/cull.js';
import { retentionPass } from '@lobstah/supervisor';
import { cliCuller } from '../src/auto-cull.js';
import { diskRow } from '../src/doctor.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * `[limits].releaseOnMerge`: a merged PR's worktree goes on the next cull
 * pass, only when every dispatch in the chain is finished, the worktree is
 * clean, and no work is newer than the observed PR heads. Real git: a local bare repo is the
 * remote.
 */

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let root: string;
let home: string;
let repo: string;
let origin: string;
let now: number;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const wtOf = (id: string) => path.join(home, 'worktrees', id);

function config(releaseOnMerge: boolean): void {
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    `[repos.r]\npath = ${JSON.stringify(repo)}\ntrunk = "main"\n[limits]\nreleaseOnMerge = ${releaseOnMerge}\n`,
  );
}

function lobstah(...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 30_000 });
}

interface Opts {
  followUp?: string;
  /** Ran in this dispatch's worktree instead of its own. */
  reused?: string;
  /** Push the branch after committing. Default true. */
  push?: boolean;
  /** Leave an uncommitted file behind. */
  dirty?: boolean;
  pr?: number;
}

/** A finished dispatch with a real worktree and a commit on lobstah/<owner>. */
function finished(id: string, opts: Opts = {}): void {
  const owner = opts.reused ?? id;
  const wt = wtOf(owner);
  if (!opts.reused) git(repo, 'worktree', 'add', '-q', '-b', `lobstah/${id}`, wt, 'origin/main');
  fs.writeFileSync(path.join(wt, `${id}.txt`), id);
  git(wt, 'add', '.');
  git(wt, 'commit', '-q', '-m', `work of ${id}`);
  if (opts.push !== false) git(wt, 'push', '-q', 'origin', `lobstah/${owner}`);
  if (opts.dirty) fs.writeFileSync(path.join(wt, 'uncommitted.txt'), 'wip');
  enqueue({ id, repo: 'r', brief: 'b', ...(opts.followUp ? { followUp: opts.followUp } : {}) });
  expect(claimNext('work')).toBe(id);
  fs.writeFileSync(
    path.join(laneDirs('work').active, id, 'worktree.json'),
    JSON.stringify(opts.reused ? { path: wt, of: owner } : { path: wt }),
  );
  mergeEvidence(id, 'work', {
    worktree: wt,
    ...(opts.reused ? { worktreeOf: owner } : {}),
    branch: `lobstah/${owner}`,
    commits: [`abc1234 work of ${id}`],
    ...(opts.pr ? { prUrl: `https://github.com/o/r/pull/${opts.pr}` } : {}),
  });
  appendStatus(id, 'work', 'done', 'finished');
  fs.renameSync(path.join(laneDirs('work').active, id), path.join(laneDirs('work').done, id));
}

function pr(n: number, state: 'OPEN' | 'MERGED' | 'CLOSED', dispatches: string[], headRefName?: string): void {
  const key = `pr:o/r#${n}`;
  fs.mkdirSync(path.dirname(prRecordFile(key)), { recursive: true });
  fs.writeFileSync(
    prRecordFile(key),
    JSON.stringify({
      key,
      repo: 'o/r',
      url: `https://github.com/o/r/pull/${n}`,
      number: n,
      state,
      draft: false,
      reviewDecision: '',
      mergeStateStatus: 'UNKNOWN',
      headSha: headRefName && fs.existsSync(path.join(origin, 'refs', 'heads', headRefName)) ? git(origin, 'rev-parse', headRefName) : 'x',
      headRefName,
      checks: { total: 0, passed: 0, failed: 0, pending: 0 },
      dispatches,
      standingSince: {},
      observedAt: new Date(now).toISOString(),
    }),
  );
}

/** One daemon cull pass (the hourly throttle is reset by moving the clock). */
function pass(): string[] {
  now += 3_600_000;
  const log: string[] = [];
  retentionPass(loadConfig(), { culler: cliCuller, now: () => now }, (m) => log.push(m));
  return log;
}

const released = () => listNotices().filter((n) => n.kind === 'worktree-released');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-release-'));
  home = path.join(root, 'home');
  fs.mkdirSync(home);
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  now = Date.now();
  origin = path.join(root, 'origin.git');
  repo = path.join(root, 'clone');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, repo);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(repo, 'push', '-q', 'origin', 'main');
  config(true);
});
afterEach(() => {
  removeTempDir(root);
  delete process.env.LOBSTAH_HOME;
});

describe('releaseOnMerge', () => {
  function squash(id = 'd1'): void {
    finished(id, { pr: 1 });
    pr(1, 'MERGED', [id], `lobstah/${id}`);
    git(repo, 'merge', '--squash', `lobstah/${id}`);
    git(repo, 'commit', '-q', '-m', 'squash');
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'push', '-q', 'origin', '--delete', `lobstah/${id}`);
    git(repo, 'fetch', '--prune', 'origin');
  }

  it('releases a clean squash merge with its branch deleted, without fetching', () => {
    squash();
    git(repo, 'remote', 'set-url', 'origin', path.join(root, 'missing.git'));
    pass();
    expect(fs.existsSync(wtOf('d1'))).toBe(false);
    expect(git(repo, 'branch', '--list', 'lobstah/d1')).toContain('lobstah/d1');
  });

  it('keeps extra local commits as ahead of PR head, including in retention and pressure culls', () => {
    squash();
    git(wtOf('d1'), 'commit', '--allow-empty', '-m', 'local only');
    pass();
    expect(readKeptWorktrees()).toMatchObject([{ reason: 'ahead of PR head (1 commits)' }]);
    const future = now + 100 * 86_400_000;
    expect(planCull(1, future, { measure: false }).filter((i) => ['d1', 'pr:o/r#1'].includes(i.id))).toEqual([]);
    expect(planPressureCull(future).some((i) => i.id === 'd1')).toBe(false);
    expect(fs.existsSync(wtOf('d1'))).toBe(true);
  });

  it('never releases dirty squash-merged work, including untracked files', () => {
    squash();
    fs.writeFileSync(path.join(wtOf('d1'), 'local.txt'), 'keep');
    pass();
    expect(readKeptWorktrees()).toMatchObject([{ reason: 'dirty (1 files)' }]);
    expect(planCull(1, now + 100 * 86_400_000, { measure: false }).some((i) => i.id === 'd1')).toBe(false);
    expect(planPressureCull().some((i) => i.id === 'd1')).toBe(false);
  });

  it('retains every observed PR head and releases an older observed head', () => {
    finished('d1', { pr: 1 });
    pr(1, 'OPEN', ['d1'], 'lobstah/d1');
    const first = readPr('pr:o/r#1')!;
    upsertPr({ ...first, headSha: 'a'.repeat(40) });
    upsertPr({ ...first, state: 'MERGED', headSha: 'b'.repeat(40) });
    expect(readPr(first.key)?.observedHeadShas).toEqual([first.headSha, 'a'.repeat(40), 'b'.repeat(40)]);
    pass();
    expect(fs.existsSync(wtOf('d1'))).toBe(false);
  });

  it.each(['merge', 'rebase'])('releases work published to trunk by a %s merge', (kind) => {
    finished('d1', { pr: 1 });
    pr(1, 'MERGED', ['d1']); // legacy record: no usable PR head
    if (kind === 'merge') git(repo, 'merge', '--no-ff', '-m', 'merge', 'lobstah/d1');
    else git(repo, 'cherry-pick', 'lobstah/d1');
    git(repo, 'push', '-q', 'origin', 'main');
    pass();
    expect(fs.existsSync(wtOf('d1'))).toBe(false);
  });

  it('keeps unknown work after a failed fetch and retries after remote recovery', () => {
    finished('d1', { pr: 1 });
    pr(1, 'MERGED', ['d1']);
    git(repo, 'remote', 'set-url', 'origin', path.join(root, 'missing.git'));
    pass();
    expect(readKeptWorktrees()).toMatchObject([{ reason: 'unknown (fetch failed, remote state unknown; retry next pass)' }]);
    expect(fs.existsSync(wtOf('d1'))).toBe(true);
    git(repo, 'remote', 'set-url', 'origin', origin);
    git(wtOf('d1'), 'push', '-q', 'origin', 'HEAD:main');
    pass();
    expect(fs.existsSync(wtOf('d1'))).toBe(false);
  });

  it('off (the default): a merge removes nothing', () => {
    config(false);
    expect(loadConfig().limits.releaseOnMerge).toBe(false);
    finished('d1', { pr: 1 });
    pr(1, 'MERGED', ['d1'], 'lobstah/d1');
    pass();
    expect(fs.existsSync(wtOf('d1'))).toBe(true);
    expect(released()).toEqual([]);
  });

  it('on: a clean, pushed worktree is removed on the next pass; branch, record, and evidence stay', () => {
    finished('d1', { pr: 1 });
    pr(1, 'MERGED', ['d1'], 'lobstah/d1');
    const log = pass();
    expect(fs.existsSync(wtOf('d1'))).toBe(false);
    // Compare worktree paths, not the list text: a short commit hash can contain "d1".
    const paths = git(repo, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => path.basename(l.slice('worktree '.length)));
    expect(paths).not.toContain('d1');
    expect(git(repo, 'branch', '--list', 'lobstah/d1')).toContain('lobstah/d1');
    expect(git(origin, 'branch', '--list', 'lobstah/d1')).toContain('lobstah/d1');
    expect(fs.existsSync(path.join(laneDirs('work').done, 'd1', 'descriptor.json'))).toBe(true);
    expect(readEvidence('d1', 'work')).toMatchObject({ branch: 'lobstah/d1', prUrl: 'https://github.com/o/r/pull/1' });
    expect(readEvidence('d1', 'work').worktreeReleased).toBeTruthy();
    expect(released()).toHaveLength(1);
    expect(log.some((l) => l.startsWith('released on merge: 1 worktree(s)'))).toBe(true);

    const caught = lobstah('catch', 'd1');
    expect(caught.stdout).toContain('branch: lobstah/d1');
    expect(caught.stdout).toContain('prUrl: https://github.com/o/r/pull/1');
    expect(caught.stdout).toContain('abc1234 work of d1');
    expect(caught.stdout).toMatch(/worktree: released on merge \(/);

    // Nothing more to release: no second notice.
    pass();
    expect(released()).toHaveLength(1);
  });

  it('an unpushed worktree is kept with a reason, and doctor shows it', () => {
    finished('d1', { pr: 1, push: false });
    pr(1, 'MERGED', ['d1'], 'lobstah/d1');
    const log = pass();
    expect(fs.existsSync(wtOf('d1'))).toBe(true);
    expect(readKeptWorktrees()).toMatchObject([{ id: 'd1', reason: 'unknown (recorded PR heads unavailable; retry next pass)', pr: 'pr:o/r#1' }]);
    expect(log).toContain('release on merge: kept worktree d1 (unknown (recorded PR heads unavailable; retry next pass))');
    const row = diskRow(loadConfig(), () => 100 * 1024 ** 3);
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('kept: 1 worktree(s) of merged PRs: d1 unknown');
    expect(lobstah('catch', 'd1').stdout).toContain('worktreeKept: unknown (recorded PR heads unavailable; retry next pass)');
    expect(released()).toEqual([]);

    // Once the work is pushed, the next pass releases it and the kept entry clears.
    git(wtOf('d1'), 'push', '-q', 'origin', 'lobstah/d1');
    pr(1, 'MERGED', ['d1'], 'lobstah/d1');
    pass();
    expect(fs.existsSync(wtOf('d1'))).toBe(false);
    expect(readKeptWorktrees()).toEqual([]);
  }, 30_000);

  it('a dirty worktree is kept with a reason', () => {
    finished('d1', { pr: 1, dirty: true });
    pr(1, 'MERGED', ['d1'], 'lobstah/d1');
    pass();
    expect(fs.readFileSync(path.join(wtOf('d1'), 'uncommitted.txt'), 'utf8')).toBe('wip');
    expect(readKeptWorktrees()).toMatchObject([{ id: 'd1', reason: 'dirty (1 files)' }]);
  });

  it('a PR closed without merge releases nothing', () => {
    finished('d1', { pr: 1 });
    pr(1, 'CLOSED', ['d1'], 'lobstah/d1');
    pass();
    expect(fs.existsSync(wtOf('d1'))).toBe(true);
    expect(readKeptWorktrees()).toEqual([]);
  });

  it('merged evidence without a PR record releases too', () => {
    finished('d1', { pr: 1 });
    mergeEvidence('d1', 'work', {
      pr: {
        url: 'https://github.com/o/r/pull/1',
        number: 1,
        state: 'MERGED',
        draft: false,
        reviewDecision: '',
        mergeStateStatus: 'UNKNOWN',
        headSha: git(wtOf('d1'), 'rev-parse', 'HEAD'),
        checks: { total: 0, passed: 0, failed: 0, pending: 0 },
        observedAt: new Date(now).toISOString(),
      },
    });
    pass();
    expect(fs.existsSync(wtOf('d1'))).toBe(false);
  });

  it('a trap’s worktree is never touched', () => {
    finished('d1', { pr: 1 });
    pr(1, 'MERGED', ['d1'], 'lobstah/d1');
    const res = signOnTrap({ worktree: wtOf('d1'), cwd: wtOf('d1'), repo: 'r', harness: 'claude', sessionId: 's', ttlMs: 3_600_000 });
    expect('ok' in res).toBe(true);
    pass();
    expect(fs.existsSync(wtOf('d1'))).toBe(true);
    expect(released()).toEqual([]);
  });

  it('releases every worktree of the chain on that PR, in one notice', () => {
    finished('origin', { pr: 1 });
    finished('fu', { followUp: 'origin', reused: 'origin' });
    // A later follow-up that allocated its own worktree and pushed to the PR's branch.
    git(repo, 'worktree', 'add', '-q', '-b', 'side', wtOf('fu2'), 'origin/lobstah/origin');
    git(wtOf('fu2'), 'push', '-q', 'origin', 'HEAD:lobstah/origin');
    enqueue({ id: 'fu2', repo: 'r', brief: 'b', followUp: 'fu' });
    expect(claimNext('work')).toBe('fu2');
    mergeEvidence('fu2', 'work', { worktree: wtOf('fu2'), branch: 'lobstah/origin' });
    appendStatus('fu2', 'work', 'done', 'finished');
    fs.renameSync(path.join(laneDirs('work').active, 'fu2'), path.join(laneDirs('work').done, 'fu2'));
    // An unrelated dispatch with its own merged-elsewhere worktree stays.
    finished('other');
    pr(1, 'MERGED', ['origin'], 'lobstah/origin');

    pass();
    expect(fs.existsSync(wtOf('origin'))).toBe(false);
    expect(fs.existsSync(wtOf('fu2'))).toBe(false);
    expect(fs.existsSync(wtOf('other'))).toBe(true);
    expect(released()).toHaveLength(1);
    expect(released()[0]!.text).toMatch(/released on merge: 2 worktree\(s\)/);
    expect(readEvidence('fu', 'work').worktreeReleased).toBeTruthy();
    expect(lobstah('catch', 'fu').stdout).toMatch(/worktree: released on merge \(/);
  });

  it('nothing is released while a chain member is queued', () => {
    finished('origin', { pr: 1 });
    pr(1, 'MERGED', ['origin'], 'lobstah/origin');
    enqueue({ id: 'waiting', repo: 'r', brief: 'b', followUp: 'origin' });
    pass();
    expect(fs.existsSync(wtOf('origin'))).toBe(true);
    expect(readKeptWorktrees()).toEqual([]);
  });
});

describe('the release fetch and the per-repo git lock', () => {
  it('waits while another process holds the repo lock, then fetches and releases', () => {
    config(true);
    finished('d1', { pr: 42 });
    pr(42, 'MERGED', ['d1']);
    // Old records lack a usable head. A fresh trunk fetch can still prove all work published.
    const oldTrunk = git(repo, 'rev-parse', 'origin/main');
    git(wtOf('d1'), 'push', '-q', 'origin', 'HEAD:main');
    git(repo, 'update-ref', 'refs/remotes/origin/main', oldTrunk);
    const lock = path.join(repo, '.git', 'lobstah-git.lock');
    const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(lock)},JSON.stringify({pid:process.pid,at:new Date().toISOString()}));setTimeout(()=>{fs.rmSync(${JSON.stringify(lock)},{force:true});process.exit(0)},1200);`;
    const holder = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    try {
      const pause = new Int32Array(new SharedArrayBuffer(4));
      for (let i = 0; i < 200 && !fs.existsSync(lock); i++) Atomics.wait(pause, 0, 0, 25);
      const t0 = Date.now();
      pass();
      expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
      expect(fs.existsSync(wtOf('d1'))).toBe(false);
      expect(fs.existsSync(lock)).toBe(false);
    } finally {
      holder.kill('SIGKILL');
    }
  });
});

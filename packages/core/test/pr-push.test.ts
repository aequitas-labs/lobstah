import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMovedHeadRejection, pushPrBranch } from '../src/pr-push.js';

let root: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function identity(dir: string, name: string): void {
  git(dir, 'config', 'user.name', name);
  git(dir, 'config', 'user.email', `${name.toLowerCase()}@example.test`);
  git(dir, 'config', 'core.autocrlf', 'false');
}

function commit(dir: string, file: string, text: string, message = file): string {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/** origin with main and a PR branch; a worker checkout and a rival checkout of the PR branch. */
function fixture(): { bare: string; worker: string; rival: string } {
  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  fs.mkdirSync(bare);
  git(bare, 'init', '-q', '--bare');
  git(root, 'clone', '-q', bare, seed);
  identity(seed, 'Seed');
  commit(seed, 'README.md', 'start\n');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  git(seed, 'switch', '-q', '-c', 'feature/pr');
  commit(seed, 'feature.txt', 'feature\n');
  git(seed, 'push', '-q', 'origin', 'feature/pr');
  const worker = path.join(root, 'worker');
  const rival = path.join(root, 'rival');
  for (const [dir, name] of [[worker, 'Worker'], [rival, 'Rival']] as const) {
    git(root, 'clone', '-q', bare, dir);
    identity(dir, name);
    git(dir, 'switch', '-q', 'feature/pr');
  }
  return { bare, worker, rival };
}

/** A pre-push hook that prints a banner and counts its runs; `fail` makes it a real test error. */
function hook(dir: string, opts: { fail?: boolean } = {}): string {
  const hooks = path.join(root, `hooks-${path.basename(dir)}`);
  fs.mkdirSync(hooks, { recursive: true });
  const count = path.join(hooks, 'runs');
  const body = [
    '#!/bin/sh',
    `echo run >> "${count.replace(/\\/g, '/')}"`,
    'echo "== pre-push checks =="',
    ...(opts.fail ? ["echo \"src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\"", 'exit 1'] : ['exit 0']),
  ].join('\n');
  fs.writeFileSync(path.join(hooks, 'pre-push'), `${body}\n`);
  fs.chmodSync(path.join(hooks, 'pre-push'), 0o755);
  git(dir, 'config', 'core.hooksPath', hooks.replace(/\\/g, '/'));
  return count;
}
const runs = (count: string) => (fs.existsSync(count) ? fs.readFileSync(count, 'utf8').split('\n').filter(Boolean).length : 0);
const branches = (bare: string) => git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').sort();

/** The rival moves the PR branch on origin. */
function race(rival: string, n: number): string {
  git(rival, 'pull', '-q', '--rebase', 'origin', 'feature/pr');
  commit(rival, `rival-${n}.txt`, `rival ${n}\n`);
  git(rival, 'push', '-q', 'origin', 'feature/pr');
  return git(rival, 'rev-parse', 'HEAD');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-pr-push-'));
  process.env.LOBSTAH_HOME = path.join(root, 'home');
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('isMovedHeadRejection', () => {
  it('matches non-fast-forward, fetch first, and stale lease rejections only', () => {
    expect(isMovedHeadRejection(' ! [rejected]        HEAD -> feature (non-fast-forward)')).toBe(true);
    expect(isMovedHeadRejection(' ! [rejected]        HEAD -> feature (fetch first)')).toBe(true);
    expect(isMovedHeadRejection('== checks ==\n ! [rejected]        HEAD -> feature (stale info)\nerror: failed to push')).toBe(true);
    expect(isMovedHeadRejection("error TS2322: Type 'string'\nerror: failed to push some refs to 'origin'")).toBe(false);
    expect(isMovedHeadRejection(' ! [remote rejected] HEAD -> feature (pre-receive hook declined)')).toBe(false);
  });
});

describe('pushPrBranch', { timeout: 60_000 }, () => {
  it('a push rejected once is fetched, replayed onto the moved head, checked again, and accepted', () => {
    const { bare, worker, rival } = fixture();
    const count = hook(worker);
    const work = commit(worker, 'fix.txt', 'fix\n', 'repair');
    let moved = '';
    const result = pushPrBranch({
      cwd: worker, branch: 'feature/pr', retries: 3,
      beforeAttempt: (n) => { if (n === 1) moved = race(rival, n); },
    });
    expect(result).toMatchObject({ kind: 'pushed', branch: 'feature/pr', attempts: 2 });
    const head = git(bare, 'rev-parse', 'refs/heads/feature/pr');
    expect(head).toBe(git(worker, 'rev-parse', 'HEAD'));
    expect(git(bare, 'rev-parse', `${head}^`)).toBe(moved); // the work sits on the moved head
    expect(git(bare, 'log', '-1', '--format=%s', head)).toBe('repair');
    expect(head).not.toBe(work);
    expect(runs(count)).toBe(2); // the push checks ran again for the replayed work
    expect(branches(bare)).toEqual(['refs/heads/feature/pr', 'refs/heads/main']);
  });

  it('a rebased branch keeps the commits that moved it', () => {
    const { bare, worker, rival } = fixture();
    // trunk moves; the worker rebases the PR onto it
    git(rival, 'switch', '-q', 'main');
    commit(rival, 'trunk.txt', 'trunk\n');
    git(rival, 'push', '-q', 'origin', 'main');
    git(rival, 'switch', '-q', 'feature/pr');
    git(worker, 'fetch', '-q', 'origin');
    git(worker, 'rebase', '-q', 'origin/main');
    const result = pushPrBranch({
      cwd: worker, branch: 'feature/pr', retries: 3,
      beforeAttempt: (n) => { if (n === 1) race(rival, n); },
    });
    expect(result).toMatchObject({ kind: 'pushed', attempts: 2 });
    const head = git(bare, 'rev-parse', 'refs/heads/feature/pr');
    expect(git(bare, 'merge-base', '--is-ancestor', git(bare, 'rev-parse', 'refs/heads/main'), head)).toBe('');
    const files = git(bare, 'ls-tree', '--name-only', head).split('\n');
    expect(files).toEqual(expect.arrayContaining(['feature.txt', 'trunk.txt', 'rival-1.txt']));
  });

  it('a push rejected on every retry fails with the moved head and creates no branch', () => {
    const { bare, worker, rival } = fixture();
    commit(worker, 'fix.txt', 'fix\n');
    let last = '';
    const result = pushPrBranch({
      cwd: worker, branch: 'feature/pr', retries: 2,
      beforeAttempt: (n) => { last = race(rival, n); },
    });
    expect(result).toMatchObject({ kind: 'failed', attempts: 3, movedHead: last });
    if (result.kind === 'failed') expect(isMovedHeadRejection(result.output)).toBe(true);
    expect(git(bare, 'rev-parse', 'refs/heads/feature/pr')).toBe(last); // the PR branch is left as it was
    expect(branches(bare)).toEqual(['refs/heads/feature/pr', 'refs/heads/main']);
  });

  it('a hook failure that is a real error is not retried', () => {
    const { bare, worker } = fixture();
    const count = hook(worker, { fail: true });
    const before = git(bare, 'rev-parse', 'refs/heads/feature/pr');
    commit(worker, 'fix.txt', 'fix\n');
    let attempts = 0;
    const result = pushPrBranch({ cwd: worker, branch: 'feature/pr', retries: 3, beforeAttempt: () => attempts++ });
    expect(result).toMatchObject({ kind: 'refused', attempts: 1 });
    if (result.kind === 'refused') expect(result.output).toContain('error TS2322');
    expect(attempts).toBe(1);
    expect(runs(count)).toBe(1);
    expect(git(bare, 'rev-parse', 'refs/heads/feature/pr')).toBe(before);
  });

  it('a branch rewritten on origin is not replayed', () => {
    const { bare, worker, rival } = fixture();
    commit(worker, 'fix.txt', 'fix\n');
    const result = pushPrBranch({
      cwd: worker, branch: 'feature/pr', retries: 3,
      beforeAttempt: () => {
        git(rival, 'commit', '-q', '--amend', '-m', 'rewritten');
        git(rival, 'push', '-q', '--force', 'origin', 'feature/pr');
      },
    });
    expect(result).toMatchObject({ kind: 'failed', attempts: 1 });
    if (result.kind === 'failed') expect(result.reason).toContain('rewritten');
    expect(git(bare, 'log', '-1', '--format=%s', 'refs/heads/feature/pr')).toBe('rewritten');
  });

  it('never creates the branch on origin', () => {
    const { bare, worker } = fixture();
    git(worker, 'switch', '-q', '-c', 'lobstah/other');
    commit(worker, 'fix.txt', 'fix\n');
    const result = pushPrBranch({ cwd: worker, branch: 'missing/pr', retries: 3 });
    expect(result).toMatchObject({ kind: 'not-ready' });
    expect(branches(bare)).toEqual(['refs/heads/feature/pr', 'refs/heads/main']);
  });
});

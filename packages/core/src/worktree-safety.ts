import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
}

export interface WorktreeSafety {
  branch: string;
  modifiedFiles?: number;
  unpushedCommits?: number;
  reason?: string;
}

/** Fail closed. The only ignored file is an untracked trap anchor. */
export function inspectTrapWorktree(dir: string): WorktreeSafety {
  const result: WorktreeSafety = { branch: 'unknown' };
  try {
    result.branch = git(dir, 'symbolic-ref', '--short', 'HEAD').trim();
    const records = git(dir, 'status', '--porcelain', '-z', '--untracked-files=all').split('\0');
    let modified = 0;
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      if (!record) continue;
      if (record !== '?? .lobstah-trap') modified++;
      if (/^[RC]|^.[RC]/.test(record)) i++; // rename/copy has a second path
    }
    result.modifiedFiles = modified;
    let upstream: string | undefined;
    try { upstream = git(dir, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}').trim(); } catch { /* no upstream */ }
    result.unpushedCommits = Number(git(dir, 'rev-list', '--count', 'HEAD', '--not', ...(upstream ? [upstream] : ['--remotes'])).trim());
    if (!Number.isFinite(result.unpushedCommits)) throw new Error('invalid commit count');
    if (modified > 0) result.reason = `${modified} modified or untracked file(s)`;
    else if (result.unpushedCommits > 0) result.reason = `${result.unpushedCommits} unpushed commit(s)`;
    else if (!upstream) result.reason = 'branch has no upstream';
  } catch {
    result.reason = 'cannot verify git status and upstream commits';
  }
  return result;
}

/** A trap's last revision, kept under a protected ref in its repository. */
export interface TrapRevision {
  /** The exact commit HEAD pointed at. */
  head: string;
  /** The checked-out branch, absent on a detached HEAD. */
  branch?: string;
  /** Canonical git common directory: the repository's identity. */
  gitDir: string;
  /** The protected ref that holds `head`: `refs/lobstah/traps/<trapId>`. */
  ref: string;
  at: string;
}

/**
 * A git directory's canonical form, comparable across calls: native realpath
 * expands Windows 8.3 names (RUNNER~1), lowercased on Windows like
 * registrations store their worktrees.
 */
function canonicalGitDir(dir: string): string {
  const real = fs.realpathSync.native(dir);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** The protected ref that keeps a trap's last revision. Not a branch: no cleanup deletes it. */
export function trapRef(trapId: string): string {
  return `refs/lobstah/traps/${trapId}`;
}

/**
 * Point the trap's protected ref at the checkout's HEAD. The ref lives in the
 * repository's common directory, so removing the worktree or deleting its
 * branch leaves it, and the commit it names, in place. Undefined when the
 * directory is not a git checkout with a commit.
 */
export function protectTrapRevision(dir: string, trapId: string, now = Date.now()): TrapRevision | undefined {
  try {
    const head = git(dir, 'rev-parse', '--verify', '-q', 'HEAD^{commit}').trim();
    const gitDir = canonicalGitDir(git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim());
    let branch: string | undefined;
    try { branch = git(dir, 'symbolic-ref', '--short', '-q', 'HEAD').trim() || undefined; } catch { /* detached */ }
    const ref = trapRef(trapId);
    git(dir, 'update-ref', '-m', `lobstah: trap wt:${trapId}`, ref, head);
    return { head, ...(branch ? { branch } : {}), gitDir, ref, at: new Date(now).toISOString() };
  } catch {
    return undefined;
  }
}

/** The commit a protected ref names in a repository, if the ref and its commit exist. */
export function protectedRevision(gitDir: string, trapId: string): string | undefined {
  try {
    return execFileSync('git', ['--git-dir', gitDir, 'rev-parse', '--verify', '-q', `${trapRef(trapId)}^{commit}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** A directory's canonical git common directory, if it is in a repository. */
export function gitCommonDir(dir: string): string | undefined {
  try {
    return canonicalGitDir(git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim());
  } catch {
    return undefined;
  }
}

/**
 * Only a verified clean, pushed linked checkout is removed; branches stay.
 * A trap checkout's HEAD is first kept under its protected ref.
 */
export function removeGhostWorktree(dir: string): WorktreeSafety & { removed: boolean; revision?: TrapRevision } {
  const safety = inspectTrapWorktree(dir);
  if (safety.reason) return { ...safety, removed: false };
  const anchor = path.join(dir, '.lobstah-trap');
  const trapId = anchoredTrapId(anchor);
  const revision = trapId !== undefined ? protectTrapRevision(dir, trapId) : undefined;
  if (trapId !== undefined && !revision) return { ...safety, removed: false, reason: 'cannot keep the trap revision under a protected ref' };
  let saved: Buffer | undefined;
  try {
    const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim();
    const own = git(dir, 'rev-parse', '--path-format=absolute', '--git-dir').trim();
    if (common === own) return { ...safety, removed: false, reason: 'not a linked worktree' };
    if (fs.existsSync(anchor)) { saved = fs.readFileSync(anchor); fs.unlinkSync(anchor); }
    git(path.dirname(common), '--git-dir', common, 'worktree', 'remove', dir);
    return { ...safety, removed: true, ...(revision ? { revision } : {}) };
  } catch {
    if (saved && fs.existsSync(dir)) fs.writeFileSync(anchor, saved);
    return { ...safety, removed: false, reason: 'git worktree remove refused', ...(revision ? { revision } : {}) };
  }
}

function anchoredTrapId(file: string): string | undefined {
  try {
    const id = (JSON.parse(fs.readFileSync(file, 'utf8')) as { trapId?: unknown }).trapId;
    return typeof id === 'string' && /^[a-z0-9-]+$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

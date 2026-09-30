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

/** Only a verified clean, pushed linked checkout is removed; branches stay. */
export function removeGhostWorktree(dir: string): WorktreeSafety & { removed: boolean } {
  const safety = inspectTrapWorktree(dir);
  if (safety.reason) return { ...safety, removed: false };
  const anchor = path.join(dir, '.lobstah-trap');
  let saved: Buffer | undefined;
  try {
    const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim();
    const own = git(dir, 'rev-parse', '--path-format=absolute', '--git-dir').trim();
    if (common === own) return { ...safety, removed: false, reason: 'not a linked worktree' };
    if (fs.existsSync(anchor)) { saved = fs.readFileSync(anchor); fs.unlinkSync(anchor); }
    git(path.dirname(common), '--git-dir', common, 'worktree', 'remove', dir);
    return { ...safety, removed: true };
  } catch {
    if (saved && fs.existsSync(dir)) fs.writeFileSync(anchor, saved);
    return { ...safety, removed: false, reason: 'git worktree remove refused' };
  }
}

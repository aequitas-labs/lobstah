import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  acquireWorktreeLock, activeIds, configuredFolderOverlaps, dispatchWorktree, followUpAncestors, laneDirs,
  listTraps, pendingIds, readStatusLog, releaseWorktreeLock, reviewDispatchIds, storedDescriptor, worktreePath,
} from '@lobstah/core';
import type { Lane } from '@lobstah/core';

const exec = promisify(execFile);
const real = (p: string) => {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
};
const same = (a: string, b: string) => process.platform === 'win32'
  ? real(a).toLowerCase() === real(b).toLowerCase() : real(a) === real(b);

/** Release only a finished review's own disposable checkout; its records and branch stay. */
export async function releaseReviewWorktree(id: string, lane: Lane, log: (m: string) => void): Promise<boolean> {
  try {
    return await releaseFinishedReview(id, lane, log);
  } catch (error) {
    log(`review cleanup: kept worktree ${id} (${error instanceof Error ? error.message : String(error)})`);
    return false;
  }
}

async function releaseFinishedReview(id: string, lane: Lane, log: (m: string) => void): Promise<boolean> {
  if (lane !== 'chore' || !fs.existsSync(path.join(laneDirs(lane).done, id))) return false;
  const desc = storedDescriptor(id, lane);
  if (!desc?.readOnly && !reviewDispatchIds().has(id)) return false;
  const last = readStatusLog(id, lane).at(-1)?.verb;
  if (last !== 'done' && last !== 'failed') return false;
  const wt = dispatchWorktree(id, lane);
  if (!fs.existsSync(wt.path)) return false;
  const keep = (reason: string) => { log(`review cleanup: kept worktree ${id} (${reason})`); return false; };
  if (wt.owner !== id || !same(wt.path, worktreePath(id))) return keep('shared or externally managed checkout');
  if (configuredFolderOverlaps(wt.path)) return keep('configured working folder');
  for (const trap of listTraps()) {
    if (typeof trap.worktree !== 'string') continue;
    const rel = path.relative(real(wt.path), real(trap.worktree));
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return keep('live trap checkout');
  }
  const lockId = `review-cleanup-${process.pid}-${id}`;
  const holder = acquireWorktreeLock(wt.path, lockId, lane, 'warm');
  if (holder) return keep(`checkout is locked by ${holder.id}`);
  try {
    for (const l of ['work', 'chore'] as Lane[]) {
      for (const other of [...activeIds(l), ...pendingIds(l)]) {
        for (const user of [other, ...followUpAncestors(other, l)]) {
          if (same(dispatchWorktree(user).path, wt.path)) return keep(`in use by ${other}`);
        }
      }
    }
    const git = async (...args: string[]) => (await exec('git', args, { cwd: wt.path, timeout: 10_000 })).stdout.trim();
    try {
      if (await git('status', '--porcelain', '--untracked-files=all')) return keep('uncommitted or untracked changes');
      const count = await git('rev-list', '--count', 'HEAD', '--not', '--remotes');
      if (count !== '0') return keep(`${count} unpushed commit(s)`);
      const common = await git('rev-parse', '--path-format=absolute', '--git-common-dir');
      const own = await git('rev-parse', '--path-format=absolute', '--git-dir');
      if (same(common, own)) return keep('not a linked worktree');
      const rel = path.relative(real(wt.path), real(process.cwd()));
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) process.chdir(path.dirname(common));
      await exec('git', ['--git-dir', common, 'worktree', 'remove', wt.path]);
      log(`review cleanup: removed worktree ${id}; records and branch kept`);
      return true;
    } catch (error) {
      return keep(`cannot safely remove checkout: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    releaseWorktreeLock(wt.path, lockId);
  }
}

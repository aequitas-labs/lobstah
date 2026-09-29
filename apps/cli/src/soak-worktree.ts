import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  GB,
  formatGB,
  newTrapId,
  statfsFreeBytes,
  worktreePath,
  worktreesDir,
  writeTrapAnchor,
  type FreeBytesReader,
  type RepoConfig,
} from '@lobstah/core';
import { allocate, discard } from '@lobstah/worktree';

export interface SoakWorktree {
  /** The new worktree's directory. */
  dir: string;
  /** The trap id anchored in it. */
  trapId: string;
  /** The branch created with it. */
  branch: string;
}

function branchExists(repo: RepoConfig, branch: string): boolean {
  return spawnSync('git', ['-C', repo.path, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`], { stdio: 'ignore' }).status === 0;
}

/**
 * Create a linked worktree for a soaking session the way a dispatch gets
 * one: `allocate` fetches trunk, adds `worktrees/soak-<trap>` on a new
 * branch `lobstah/soak-<trap>` from `origin/<trunk>`, and runs the repo's
 * setup. The anchor file marks it as created by soak for this session and
 * repo. Checks free space first (`[limits].minFreeGB`). On any failure the
 * half-made worktree and its branch are removed, and the error names the
 * cause.
 */
export async function createSoakWorktree(opts: {
  repoKey: string;
  repo: RepoConfig;
  sessionId: string;
  minFreeGB: number;
  freeBytes?: FreeBytesReader;
}): Promise<SoakWorktree> {
  const need = opts.minFreeGB * GB;
  if (need > 0) {
    let free: number | undefined;
    try {
      free = (opts.freeBytes ?? statfsFreeBytes)(worktreesDir());
    } catch {
      free = undefined; // an unreadable volume does not block, as with the daemon's guard
    }
    if (free !== undefined && free < need) {
      throw new Error(
        `could not create a worktree for repo ${opts.repoKey}: ${formatGB(free)} free on ${worktreesDir()}, ` +
          `needs ${formatGB(need)} ([limits].minFreeGB)`,
      );
    }
  }
  let trapId = newTrapId();
  while (branchExists(opts.repo, `lobstah/soak-${trapId}`) || fs.existsSync(worktreePath(`soak-${trapId}`))) trapId = newTrapId();
  const id = `soak-${trapId}`;
  const branch = `lobstah/${id}`;
  try {
    const dir = await allocate(opts.repo, id);
    writeTrapAnchor(dir, { trapId, createdBy: 'soak', sessionId: opts.sessionId, repo: opts.repoKey, branch });
    return { dir, trapId, branch };
  } catch (err) {
    await discard(opts.repo, worktreePath(id), branch);
    const detail = (err as { stderr?: string }).stderr?.trim() || (err instanceof Error ? err.message : String(err));
    throw new Error(`could not create a worktree for repo ${opts.repoKey}: ${detail}`, { cause: err });
  }
}

/** Remove a worktree made by `createSoakWorktree` when signing on to it failed. */
export async function discardSoakWorktree(repo: RepoConfig, made: SoakWorktree): Promise<void> {
  await discard(repo, made.dir, made.branch);
}

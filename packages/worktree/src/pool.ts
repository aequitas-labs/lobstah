import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  acquireWorktreeLock,
  clearSlotOut,
  formatGB,
  GB,
  listTraps,
  loadConfig,
  poolSlotLabel,
  poolSlotPath,
  poolSlotView,
  poolsRoot,
  postNotice,
  readSlotClaim,
  readSlotMeta,
  readSlotOut,
  readPoolWarmState,
  readWorktreeLock,
  releaseWorktreeLock,
  statfsFreeBytes,
  takePoolWarmLock,
  writePoolWarmState,
  writeSlotClaim,
  writeSlotMeta,
  writeSlotOut,
} from '@lobstah/core';
import type { FreeBytesReader, Lane, PoolConfig, RepoConfig } from '@lobstah/core';
import { fetchShared, gitShared, oneAtATime, onlyScratch, runSetup, tryGit } from './index.js';

const run = promisify(execFile);

/**
 * What a pool reset keeps of the untracked files in a worktree: the
 * dependency installs and build caches that make the worktree warm, and the
 * local env files a repo's setup provisions. Gitignore-style patterns, as
 * `git clean -e` reads them; one without a slash matches at any depth.
 * `[repos.<key>].poolKeep` adds to it.
 *
 * Decided from how repos are set up today: `setup` is a dependency install
 * (`pnpm install` for every configured repo), whose output lives in
 * `node_modules/` at every package; builds cache in `.turbo/`, `.next/cache/`
 * and `*.tsbuildinfo`; and local env files are `.env*` (homebase keeps
 * `.env.local`, `.env.*.local` and `apps/web/.env*`). The other entries are
 * the same kinds of directory for the lockfiles lobstah already knows
 * (LOCKFILES): Python, Rust, Ruby, CocoaPods, Gradle, SwiftPM.
 */
export const DEFAULT_POOL_KEEP: readonly string[] = [
  // dependencies
  'node_modules/',
  '.pnpm-store/',
  '.venv/',
  'vendor/bundle/',
  'Pods/',
  // build caches
  '.turbo/',
  '.next/cache/',
  '.nx/cache/',
  '.cache/',
  '*.tsbuildinfo',
  'target/',
  '.gradle/',
  '.build/',
  // local env files
  '.env*',
  '.dev.vars',
];

/**
 * Env files a reset always removes, even when a keep pattern matches: a
 * production env file is never left behind in a worktree a new dispatch
 * gets. A git pathspec: any `.env*` file whose name contains `prod`.
 */
export const PRODUCTION_ENV_PATHSPEC = ':(glob,icase)**/.env*prod*';

/** The keep list for a repo: the defaults, then the repo's own `poolKeep`. */
export function poolKeep(repo: Pick<RepoConfig, 'poolKeep'>): string[] {
  return [...new Set([...DEFAULT_POOL_KEEP, ...(repo.poolKeep ?? [])])];
}

/**
 * Why a pool worktree must not be reset, or undefined when it is safe: it
 * has uncommitted changes (tracked edits, or untracked files git does not
 * ignore, outside the repo's `scratch` paths), or commits on no remote
 * branch.
 */
export async function poolUnsafe(repo: Pick<RepoConfig, 'scratch'>, dir: string): Promise<string | undefined> {
  const status = await tryGit(dir, 'status', '--porcelain');
  if (!status.ok) return `cannot read git status: ${status.err.split('\n')[0]}`;
  if (!onlyScratch(status.out, repo.scratch)) {
    const lines = status.out.split('\n').filter((l) => l.trim() !== '');
    const paths = lines.map((l) => l.slice(3));
    return `uncommitted changes in ${lines.length} file(s): ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? `, and ${paths.length - 3} more` : ''}`;
  }
  const unpushed = await tryGit(dir, 'rev-list', '--count', 'HEAD', '--not', '--remotes');
  if (!unpushed.ok) return `cannot tell which commits are on a remote: ${unpushed.err.split('\n')[0]}`;
  const n = Number(unpushed.out);
  if (!Number.isFinite(n)) return 'cannot tell which commits are on a remote';
  if (n > 0) return `${n} commit(s) on no remote branch`;
  return undefined;
}

/** Take a slot out of rotation and tell the helm, naming the worktree. */
function takeOut(name: string, pool: PoolConfig, slot: number, reason: string, dispatch: string | undefined, notice = true): void {
  const label = poolSlotLabel(name, slot);
  writeSlotOut(name, slot, { reason, at: new Date().toISOString(), ...(dispatch ? { dispatch } : {}) });
  if (!notice) return;
  postNotice({
    kind: 'pool-out',
    text: `pool worktree ${label} (${poolSlotPath(name, slot)}) is out of rotation: ${reason}` +
      (dispatch ? ` (last used by ${dispatch.slice(0, 8)})` : '') +
      ' — commit and push or discard the work there; the pool takes it back once it is clean and pushed',
    refId: label,
    repo: pool.repo,
  });
}

/** Whether a trap is anchored in `dir` (or below it). */
function trapIn(dir: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const here = real(dir);
  return listTraps().some((t) => {
    if (typeof t.worktree !== 'string') return false;
    const rel = path.relative(here, real(t.worktree));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

export type PoolClaim =
  | { claimed: true; dir: string; slot: number; label: string }
  | { claimed: false; refused: string[] };

export interface ClaimPoolInput {
  name: string;
  pool: PoolConfig;
  repo: RepoConfig;
  id: string;
  lane: Lane;
  /** How long to wait for a slot the warm-up holds for a moment. Default 60s. */
  warmWaitMs?: number;
}

/**
 * Claim a free worktree of the pool for dispatch `id`: take its lock, then
 * check it is safe to reset. One with uncommitted or unpushed work is taken
 * out of rotation (a helm notice names it) and the next slot is tried. A
 * slot this dispatch already holds (a restarted runner) is its own again.
 * Two dispatches racing for the last free slot: the lock lets one win; the
 * other gets `claimed: false`. The reset itself is `resetPoolWorktree`.
 */
export async function claimPoolSlot(input: ClaimPoolInput): Promise<PoolClaim> {
  const { name, pool, repo, id, lane } = input;
  const refused: string[] = [];
  for (let slot = 1; slot <= pool.size; slot++) {
    const dir = poolSlotPath(name, slot);
    if (fs.existsSync(dir) && readWorktreeLock(dir)?.id === id && readWorktreeLock(dir)?.kind !== 'warm') {
      writeSlotClaim(name, slot, { id, lane, at: new Date().toISOString() });
      return { claimed: true, dir, slot, label: poolSlotLabel(name, slot) };
    }
  }
  const deadline = Date.now() + (input.warmWaitMs ?? 60_000);
  for (;;) {
    let warmHeld = false;
    for (let slot = 1; slot <= pool.size; slot++) {
      if (poolSlotView(name, slot).state !== 'free') continue;
      const dir = poolSlotPath(name, slot);
      // A session that signed on as a trap here works in it: never reset it.
      if (trapIn(dir)) continue;
      const held = acquireWorktreeLock(dir, id, lane);
      if (held) {
        if (held.kind === 'warm') warmHeld = true;
        continue;
      }
      const why = await poolUnsafe(repo, dir);
      if (why) {
        takeOut(name, pool, slot, why, readSlotClaim(name, slot)?.id);
        releaseWorktreeLock(dir, id);
        refused.push(`${poolSlotLabel(name, slot)}: ${why}`);
        continue;
      }
      writeSlotClaim(name, slot, { id, lane, at: new Date().toISOString() });
      return { claimed: true, dir, slot, label: poolSlotLabel(name, slot) };
    }
    if (!warmHeld || Date.now() >= deadline) return { claimed: false, refused };
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Reset a claimed pool worktree for dispatch `id`: fetch the branch to
 * start from (trunk, or a repair's PR head), check out `lobstah/<id>` there,
 * remove untracked files except the keep list (and always remove production
 * env files), then run the repo's `setup` commands. The caller holds the
 * worktree's lock and has checked it is safe (`claimPoolSlot`).
 */
export async function resetPoolWorktree(repo: RepoConfig, dir: string, id: string, fromRemoteBranch = repo.trunk): Promise<void> {
  await fetchShared(repo.path, 'origin', fromRemoteBranch);
  // The branch ref lives in the shared repo: take turns with allocations.
  await oneAtATime(repo.path, async () => {
    await gitShared(dir, 'checkout', '--quiet', '--force', '--no-track', '-B', `lobstah/${id}`, `origin/${fromRemoteBranch}`);
  });
  const keep = poolKeep(repo);
  await run('git', ['clean', '-ffdxq', ...keep.flatMap((p) => ['-e', p])], { cwd: dir, env: process.env });
  // Kept directories are skipped while looking for production env files.
  const dirs = keep.filter((p) => p.endsWith('/'));
  await run('git', ['clean', '-ffdxq', ...dirs.flatMap((p) => ['-e', p]), '--', PRODUCTION_ENV_PATHSPEC], { cwd: dir, env: process.env });
  await runSetup(repo, dir);
}

// ---------------------------------------------------------------------------
// Warm-up: make missing slots, check released ones, fetch.

export interface WarmOptions {
  log?: (m: string) => void;
  freeBytes?: FreeBytesReader;
  now?: () => number;
}

const WARM_ID = 'pool-warm';

async function createSlot(repo: RepoConfig, dir: string): Promise<void> {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await oneAtATime(repo.path, async () => {
    // A slot whose directory was deleted by hand leaves git's record behind.
    await tryGit(repo.path, 'worktree', 'prune');
    await gitShared(repo.path, 'worktree', 'add', '--detach', dir, `origin/${repo.trunk}`);
  });
  await runSetup(repo, dir);
}

/**
 * One warm-up pass over a pool. Fetches trunk for its repo; creates each
 * missing slot (a detached checkout of trunk, then setup) while the volume
 * has `[limits].minFreeGB` free; finishes a slot whose setup never
 * completed; and checks each slot whose dispatch has finished: one with
 * uncommitted or unpushed work leaves rotation (a helm notice), and one out
 * of rotation that is clean and pushed again comes back. A claimed slot is
 * never touched: the warm-up takes a slot's lock before it looks at it.
 * Returns false when another warm-up of the pool is running.
 */
export async function warmPool(name: string, opts: WarmOptions = {}): Promise<boolean> {
  const log = opts.log ?? (() => {});
  const now = () => new Date(opts.now?.() ?? Date.now()).toISOString();
  const cfg = loadConfig();
  const pool = cfg.pools[name];
  if (!pool) {
    log(`pool ${name}: not configured`);
    return true;
  }
  const repo = cfg.repos[pool.repo]!;
  const release = takePoolWarmLock(name);
  if (!release) return false;
  try {
    if (!fs.existsSync(repo.path)) {
      if (!repo.origin) throw new Error(`repo path ${repo.path} missing and no origin configured`);
      await run('git', ['clone', repo.origin, repo.path], { env: process.env });
    }
    await fetchShared(repo.path, 'origin', repo.trunk);
    writePoolWarmState(name, { ...readPoolWarmState(name), fetchedAt: now() });
    const need = (cfg.limits.minFreeGB ?? 0) * GB;
    const read = opts.freeBytes ?? statfsFreeBytes;
    for (let slot = 1; slot <= pool.size; slot++) {
      const dir = poolSlotPath(name, slot);
      const label = poolSlotLabel(name, slot);
      const meta = readSlotMeta(name, slot);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(poolsRoot(), { recursive: true });
        let free = Infinity;
        try {
          free = need > 0 ? read(poolsRoot()) : Infinity;
        } catch {
          // a failed read never blocks, as with the claim guard
        }
        if (free < need) {
          const error = `not created: ${formatGB(free)} free, needs ${formatGB(need)} ([limits].minFreeGB)`;
          writeSlotMeta(name, slot, { ...meta, error, errorAt: now() });
          log(`pool ${label}: ${error}`);
          continue;
        }
        try {
          await createSlot(repo, dir);
          writeSlotMeta(name, slot, { readyAt: now() });
          log(`pool ${label}: created at ${dir}`);
        } catch (err) {
          const error = `create failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`.slice(0, 300);
          writeSlotMeta(name, slot, { ...meta, error, errorAt: now() });
          log(`pool ${label}: ${error}`);
        }
        continue;
      }
      // Claimed, or a trap works there: never disturbed.
      if (trapIn(dir)) continue;
      const held = acquireWorktreeLock(dir, WARM_ID, 'work', 'warm');
      if (held) continue;
      try {
        if (!meta.readyAt) {
          // Created by an earlier warm-up that stopped before setup finished.
          try {
            await runSetup(repo, dir);
            writeSlotMeta(name, slot, { readyAt: now() });
            log(`pool ${label}: setup finished`);
          } catch (err) {
            const error = `setup failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`.slice(0, 300);
            writeSlotMeta(name, slot, { ...meta, error, errorAt: now() });
            log(`pool ${label}: ${error}`);
          }
          continue;
        }
        const claim = readSlotClaim(name, slot);
        const out = readSlotOut(name, slot);
        if (!out && (!claim || claim.id === meta.verifiedClaim)) continue;
        const why = await poolUnsafe(repo, dir);
        if (why) {
          if (!out) {
            takeOut(name, pool, slot, why, claim?.id);
            log(`pool ${label}: out of rotation — ${why}`);
          } else if (out.reason !== why) {
            takeOut(name, pool, slot, why, out.dispatch ?? claim?.id, false);
          }
          writeSlotMeta(name, slot, { ...meta, checkedAt: now() });
          continue;
        }
        if (out) {
          clearSlotOut(name, slot);
          postNotice({ kind: 'pool-returned', text: `pool worktree ${label} is back in rotation: clean and pushed`, refId: label, repo: pool.repo, quiet: true });
          log(`pool ${label}: back in rotation`);
        }
        writeSlotMeta(name, slot, { ...meta, ...(claim ? { verifiedClaim: claim.id } : {}), checkedAt: now() });
      } finally {
        releaseWorktreeLock(dir, WARM_ID);
      }
    }
    writePoolWarmState(name, { ...readPoolWarmState(name), finishedAt: now() });
    return true;
  } finally {
    release();
  }
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, type Config } from './config.js';
import { cacheDirectories, withTrapCacheLock } from './cache-paths.js';
import { GB, formatGB, statfsFreeBytes, type FreeBytesReader } from './disk.js';
import { listTraps, readTrap, type TrapRegistration } from './soak.js';
import { listRoster } from './roster.js';
import { laneOf, acquireWorktreeLock, releaseWorktreeLock, worktreeGitDir } from './worktrees.js';
import { reviewWaitWorktrees, type ReviewWaitWorktree } from './review-wait-worktrees.js';
import { readStatusLog } from './status.js';
import { postNotice } from './notices.js';
import { lobstahHome } from './paths.js';

/** Verified disposable directories in one linked checkout. */
export interface WorktreeCachePlan {
  repo: string;
  worktree: string;
  targets: string[];
  bytes: number;
}

/** Disposable directories in an idle trap. */
export interface TrapCachePlan extends WorktreeCachePlan { trapId: string; }
/** Disposable directories in a finished chain waiting only for review. */
export interface ReviewWaitCachePlan extends WorktreeCachePlan { owner: string; }

type CacheTrap = Pick<TrapRegistration, 'trapId' | 'repo' | 'worktree'>;
const git = (dir: string, args: string[]): string => execFileSync('git', ['-C', dir, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
});

/** Bad or absent cache config cannot change the pre-existing claim/report path. */
export function repoCachesConfigured(repo: string | undefined): boolean {
  try { return repo !== undefined && !!loadConfig().repos[repo]?.cacheDirs?.length; }
  catch { return false; }
}

/** A missing report on an active claim is working too; paused/blocked/question/terminal claims are idle. */
function cacheTrapIdle(trap: CacheTrap): boolean {
  const live = readTrap(trap.trapId);
  if (!live?.claimed) return true;
  const lane = laneOf(live.claimed);
  if (!lane) return false;
  const verb = readStatusLog(live.claimed, lane).at(-1)?.verb;
  return verb !== undefined && verb !== 'working';
}

/** Only an actual linked worktree belonging to the configured repo is eligible, never its primary checkout. */
function cacheWorktree(root: string, repoPath: string): boolean {
  const canonical = (dir: string): string => {
    const real = fs.realpathSync.native(dir);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  if (fs.lstatSync(root).isSymbolicLink()) return false;
  const top = git(root, ['rev-parse', '--show-toplevel']).trim();
  const common = path.resolve(root, git(root, ['rev-parse', '--git-common-dir']).trim());
  const privateGit = git(root, ['rev-parse', '--absolute-git-dir']).trim();
  const repoCommon = path.resolve(repoPath, git(repoPath, ['rev-parse', '--git-common-dir']).trim());
  return canonical(root) === canonical(top) && canonical(common) !== canonical(privateGit) && canonical(common) === canonical(repoCommon);
}

/** Refuse replaced/symlinked ancestors and tracked descendants, even when the index changed since planning. */
function safeCacheTarget(root: string, target: string, tracked: string[]): boolean {
  const relative = path.relative(root, target);
  if (fs.lstatSync(root).isSymbolicLink()) return false;
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (part.toLowerCase() === '.git' || fs.lstatSync(current).isSymbolicLink()) return false;
  }
  const name = relative.split(path.sep).join('/').toLowerCase();
  return !tracked.some((trackedPath) => {
    const file = trackedPath.toLowerCase(); // Preserve case aliases too, on case-insensitive worktree volumes.
    return file === name || file.startsWith(name + '/') || name.startsWith(file + '/');
  });
}

/** Measure allocated bytes (file size on Windows) without following symlinks; preserve nested repositories. */
function cacheBytes(target: string): number {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return process.platform === 'win32' || stat.blocks === undefined ? stat.size : stat.blocks * 512;
  const entries = fs.readdirSync(target);
  if (entries.some((name) => name.toLowerCase() === '.git')) throw new Error('nested repository is not a cache');
  return entries.reduce((bytes, name) => bytes + cacheBytes(path.join(target, name)), 0);
}

/** Reject unconfigured, busy, unverifiable or tracked cache trees before offering them for removal. */
function planWorktreeCache(checkout: Pick<CacheTrap, 'repo' | 'worktree'>, cfg: Config): WorktreeCachePlan | undefined {
  const repo = checkout.repo ? cfg.repos[checkout.repo] : undefined;
  if (!repo?.cacheDirs?.length) return undefined;
  try {
    const root = fs.realpathSync.native(checkout.worktree);
    if (!cacheWorktree(checkout.worktree, repo.path)) return undefined;
    const tracked = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
    const targets: string[] = [];
    let bytes = 0;
    for (const target of cacheDirectories(root, repo.cacheDirs)) {
      try {
        if (!safeCacheTarget(root, target, tracked)) continue;
        const size = cacheBytes(target);
        targets.push(target); bytes += size;
      } catch { /* Unreadable or nested-repository targets are preserved. */ }
    }
    return targets.length ? { repo: checkout.repo!, worktree: root, targets, bytes } : undefined;
  } catch { return undefined; } // Unknown Git/path state is never permission to delete.
}

/** Preview only opted-in, idle live/stowed/ghosted traps, largest cache total first. */
export function planTrapCaches(cfg: Config = loadConfig()): TrapCachePlan[] {
  const traps = new Map<string, CacheTrap>([...listRoster(), ...listTraps()].map((trap) => [trap.trapId, trap]));
  return [...traps.values()].flatMap((trap) => {
    if (!cacheTrapIdle(trap)) return [];
    const plan = planWorktreeCache(trap, cfg);
    return plan ? [{ trapId: trap.trapId, ...plan }] : [];
  }).sort((a, b) => b.bytes - a.bytes || a.trapId.localeCompare(b.trapId));
}

/** Preview disposable caches in finished checkouts whose PRs only await review. */
export function planReviewWaitCaches(cfg: Config = loadConfig()): ReviewWaitCachePlan[] {
  return reviewWaitWorktrees(cfg).flatMap((worktree) => {
    const plan = planWorktreeCache(worktree, cfg);
    return plan ? [{ owner: worktree.owner, ...plan }] : [];
  }).sort((left, right) => right.bytes - left.bytes || left.owner.localeCompare(right.owner));
}

/** A cleared dependency cache invalidates the reuse setup stamp, even when lockfiles did not change. */
function invalidateCacheSetup(worktree: string): void {
  const gitDir = worktreeGitDir(worktree);
  if (gitDir) fs.rmSync(path.join(gitDir, 'lobstah-setup.json'), { force: true });
}

/** The same worktree lock a follow-up takes protects revalidation and cache removal. */
export function clearReviewWaitCaches(worktree: ReviewWaitWorktree, cfg: Config = loadConfig()): number {
  const lockId = `review-cache-${process.pid}-${worktree.owner}`;
  if (acquireWorktreeLock(worktree.worktree, lockId, 'work', 'warm')) return 0;
  try {
    const current = reviewWaitWorktrees(cfg).find((item) => item.owner === worktree.owner);
    if (!current) return 0;
    const plan = planWorktreeCache(current, cfg);
    if (!plan) return 0;
    let bytes = 0;
    for (const target of plan.targets) {
      try {
        if (!reviewWaitWorktrees(cfg).some((item) => item.owner === current.owner)) break;
        const tracked = git(plan.worktree, ['ls-files', '-z']).split('\0').filter(Boolean);
        if (!safeCacheTarget(plan.worktree, target, tracked)) continue;
        const size = cacheBytes(target);
        invalidateCacheSetup(plan.worktree);
        fs.rmSync(target, { recursive: true, force: true });
        bytes += size;
      } catch { /* Unknown paths or changed Git state are preserved. */ }
    }
    return bytes;
  } finally { releaseWorktreeLock(worktree.worktree, lockId); }
}

/** Re-plan inside the claim/status lock: a trap that became working after the preview is preserved. */
export function clearTrapCaches(trap: CacheTrap, cfg: Config = loadConfig()): number {
  if (!trap.repo || !cfg.repos[trap.repo]?.cacheDirs?.length) return 0;
  return withTrapCacheLock(trap.trapId, () => {
    if (!cacheTrapIdle(trap)) return 0;
    const plan = planWorktreeCache(trap, cfg);
    if (!plan) return 0;
    let bytes = 0;
    for (const target of plan.targets) {
      try {
        const tracked = git(plan.worktree, ['ls-files', '-z']).split('\0').filter(Boolean);
        if (!cacheTrapIdle(trap) || !safeCacheTarget(plan.worktree, target, tracked)) continue;
        const size = cacheBytes(target);
        invalidateCacheSetup(plan.worktree);
        fs.rmSync(target, { recursive: true, force: true });
        bytes += size;
      } catch { /* Cleanup is best effort; a report or sign-off must still succeed. */ }
    }
    return bytes;
  });
}

/** Lifecycle cleanup is opt-in and best effort; a paused report never calls this. */
export function clearFinishedTrapCaches(trap: CacheTrap, reason: string): void {
  if (!repoCachesConfigured(trap.repo)) return;
  try {
    const free = (): number | undefined => {
      try { return statfsFreeBytes(trap.worktree); } catch { return undefined; }
    };
    const before = free();
    const bytes = clearTrapCaches(trap);
    const after = free();
    const recovered = before !== undefined && after !== undefined ? Math.max(0, after - before) : undefined;
    if (bytes > 0) postNotice({ kind: 'caches-cleared', repo: trap.repo, refId: trap.trapId, quiet: true,
      text: `trap ${trap.trapId} ${reason}: cleared ${bytes} cache bytes (${formatGB(bytes)})` +
        (recovered !== undefined ? `; ${recovered} free bytes recovered` : '') });
  } catch { /* A config/lock failure must not prevent signing off or reporting. */ }
}

/** Recover idle caches before worktree culling/refusal; no opted-in repos means no disk reads or behavior change. */
export function recoverTrapCaches(cfg: Config, volume: string, readFree: FreeBytesReader = statfsFreeBytes, log: (message: string) => void = () => {}): number {
  if (!Object.values(cfg.repos).some((repo) => repo.cacheDirs?.length)) return 0;
  const threshold = Math.max(cfg.limits.cacheMinFreeGB ?? 50, cfg.limits.minFreeGB ?? 0) * GB;
  const floor = (cfg.limits.minFreeGB ?? 0) * GB;
  if (!(threshold > 0)) return 0;
  try {
    const before = readFree(volume);
    if (before >= threshold) return 0;
    let bytes = 0;
    let traps = 0;
    let reviewWaits = 0;
    const device = fs.statSync(volume).dev;
    // Review waits are disposable before other idle traps and before whole checkouts.
    for (const plan of planReviewWaitCaches(cfg)) {
      if (readFree(volume) >= threshold) break;
      if (fs.statSync(plan.worktree).dev !== device) continue;
      const current = reviewWaitWorktrees(cfg).find((item) => item.owner === plan.owner);
      if (!current) continue;
      const removed = clearReviewWaitCaches(current, cfg);
      if (removed > 0) { bytes += removed; reviewWaits++; }
    }
    for (const plan of planTrapCaches(cfg)) {
      const free = readFree(volume);
      if (free >= threshold) break;
      try {
        // A different volume cannot recover space for this guard's worktrees.
        if (fs.statSync(plan.worktree).dev !== device) continue;
        const removed = withTrapCacheLock(plan.trapId, () => {
          // Persist the throttle across daemon restarts and other pressure-cleanup callers.
          const dir = path.join(lobstahHome(), 'cache-pressure');
          const stamp = path.join(dir, `trap-${encodeURIComponent(plan.trapId)}.json`);
          let last = NaN;
          try { last = Number(fs.readFileSync(stamp, 'utf8')); } catch { /* First pass. */ }
          const now = Date.now();
          if (free >= floor && now - last < 60 * 60 * 1000) return 0;
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(stamp, String(now));
          return clearTrapCaches(plan, cfg);
        });
        if (removed > 0) { bytes += removed; traps++; }
      } catch (error) { log(`cache cleanup kept trap ${plan.trapId}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (bytes > 0) {
      const after = readFree(volume);
      const recovered = Math.max(0, after - before);
      const text = `cache pressure cleanup: ${bytes} cache bytes cleared in ${traps} idle trap(s) and ${reviewWaits} review-wait worktree(s); ${recovered} free bytes recovered (${formatGB(recovered)})`;
      if (recovered >= GB || before < floor || after < floor) postNotice({ kind: 'caches-cleared', text });
      log(text);
    }
    return bytes;
  } catch (error) {
    log(`cache pressure cleanup skipped: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}

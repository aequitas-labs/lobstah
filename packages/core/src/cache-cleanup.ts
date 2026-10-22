import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, type Config } from './config.js';
import { cacheDirectories, withTrapCacheLock } from './cache-paths.js';
import { GB, formatGB, statfsFreeBytes, type FreeBytesReader } from './disk.js';
import { listTraps, readTrap, type TrapRegistration } from './soak.js';
import { listRoster } from './roster.js';
import { laneOf } from './worktrees.js';
import { readStatusLog } from './status.js';
import { postNotice } from './notices.js';

export interface TrapCachePlan {
  trapId: string;
  repo: string;
  worktree: string;
  targets: string[];
  bytes: number;
}

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
function planTrapCache(trap: CacheTrap, cfg: Config): TrapCachePlan | undefined {
  const repo = trap.repo ? cfg.repos[trap.repo] : undefined;
  if (!repo?.cacheDirs?.length || !cacheTrapIdle(trap)) return undefined;
  try {
    const root = fs.realpathSync.native(trap.worktree);
    if (!cacheWorktree(trap.worktree, repo.path)) return undefined;
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
    return targets.length ? { trapId: trap.trapId, repo: trap.repo!, worktree: root, targets, bytes } : undefined;
  } catch { return undefined; } // Unknown Git/path state is never permission to delete.
}

/** Preview only opted-in, idle live/stowed/ghosted traps, largest cache total first. */
export function planTrapCaches(cfg: Config = loadConfig()): TrapCachePlan[] {
  const traps = new Map<string, CacheTrap>([...listRoster(), ...listTraps()].map((trap) => [trap.trapId, trap]));
  return [...traps.values()].flatMap((trap) => {
    const plan = planTrapCache(trap, cfg);
    return plan ? [plan] : [];
  }).sort((a, b) => b.bytes - a.bytes || a.trapId.localeCompare(b.trapId));
}

/** Re-plan inside the claim/status lock: a trap that became working after the preview is preserved. */
export function clearTrapCaches(trap: CacheTrap, cfg: Config = loadConfig()): number {
  if (!trap.repo || !cfg.repos[trap.repo]?.cacheDirs?.length) return 0;
  return withTrapCacheLock(trap.trapId, () => {
    const plan = planTrapCache(trap, cfg);
    if (!plan) return 0;
    let bytes = 0;
    for (const target of plan.targets) {
      try {
        const tracked = git(plan.worktree, ['ls-files', '-z']).split('\0').filter(Boolean);
        if (!cacheTrapIdle(trap) || !safeCacheTarget(plan.worktree, target, tracked)) continue;
        const size = cacheBytes(target);
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
  if (cfg.limits.cacheMinFreeGB === 0) return 0;
  const threshold = Math.max(cfg.limits.cacheMinFreeGB ?? 50, cfg.limits.minFreeGB ?? 0) * GB;
  if (!(threshold > 0)) return 0;
  try {
    const before = readFree(volume);
    if (before >= threshold) return 0;
    let bytes = 0;
    let traps = 0;
    const device = fs.statSync(volume).dev;
    for (const plan of planTrapCaches(cfg)) {
      if (readFree(volume) >= threshold) break;
      try {
        // A different volume cannot recover space for this guard's worktrees.
        if (fs.statSync(plan.worktree).dev !== device) continue;
        const removed = clearTrapCaches(plan, cfg);
        if (removed > 0) { bytes += removed; traps++; }
      } catch (error) { log(`cache cleanup kept trap ${plan.trapId}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (bytes > 0) {
      const recovered = Math.max(0, readFree(volume) - before);
      const text = `cache pressure cleanup: ${bytes} cache bytes cleared in ${traps} idle trap(s); ${recovered} free bytes recovered (${formatGB(recovered)})`;
      postNotice({ kind: 'caches-cleared', text }); log(text);
    }
    return bytes;
  } catch (error) {
    log(`cache pressure cleanup skipped: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}

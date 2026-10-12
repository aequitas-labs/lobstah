import * as fs from 'node:fs';
import * as path from 'node:path';
import { uniqueTempPath, atomicRenameSync, laneDirs, lobstahHome } from './paths.js';
import { readEvidence } from './evidence.js';
import { storedDescriptor } from './queue.js';
import type { Lane } from './types.js';

/**
 * Which worktree a headless dispatch runs in. A dispatch allocates its own
 * worktree at `worktrees/<id>`, unless it is a follow-up that reused the
 * worktree of an earlier dispatch in its chain. Every caller that maps a
 * dispatch id to a checkout goes through `dispatchWorktree`, so a reused
 * follow-up resolves to the directory it really ran in.
 *
 * A trap's worktree is never here: a trap works in its own checkout, and
 * lobstah neither allocates nor reuses nor removes it.
 */

const LANES: Lane[] = ['work', 'chore'];

/** The directory a dispatch's own worktree is allocated at. */
export function worktreePath(id: string): string {
  return path.join(lobstahHome(), 'worktrees', id);
}

/** What the runner writes to `<active>/<id>/worktree.json`. */
export interface WorktreeRecord {
  path: string;
  /** The dispatch whose worktree this is, when this dispatch reused it. */
  of?: string;
  /** The pool worktree this is (`<pool>/<slot>`), when the dispatch claimed one. */
  pool?: string;
}

export interface DispatchWorktree {
  /** The checkout the dispatch ran in (or would run in). May not exist. */
  path: string;
  /** The dispatch the directory belongs to: the id under `worktrees/`. */
  owner: string;
  /** True when this dispatch reused another dispatch's worktree. */
  reused: boolean;
}

function readRecord(file: string): WorktreeRecord | undefined {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8')) as WorktreeRecord;
    return typeof r.path === 'string' ? r : undefined;
  } catch {
    return undefined;
  }
}

/** The owner id of a path under `worktrees/`, else undefined. */
function ownerOfPath(p: string): string | undefined {
  const rel = path.relative(path.join(lobstahHome(), 'worktrees'), p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(/[\\/]/)[0];
}

/**
 * The worktree a dispatch ran in: evidence (`worktree`, `worktreeOf`), then
 * the runner's `worktree.json`, then the default `worktrees/<id>`. With no
 * lane, both lanes are searched.
 */
export function dispatchWorktree(id: string, lane?: Lane): DispatchWorktree {
  for (const l of lane ? [lane] : LANES) {
    const ev = readEvidence(id, l);
    if (ev.worktree) {
      const owner = ev.worktreeOf ?? ownerOfPath(ev.worktree) ?? id;
      return { path: ev.worktree, owner, reused: owner !== id };
    }
    const dirs = laneDirs(l);
    for (const dir of [dirs.active, dirs.done]) {
      const rec = readRecord(path.join(dir, id, 'worktree.json'));
      if (rec) {
        const owner = rec.of ?? ownerOfPath(rec.path) ?? id;
        return { path: rec.path, owner, reused: owner !== id };
      }
    }
  }
  return { path: worktreePath(id), owner: id, reused: false };
}

/** The lane a dispatch id lives in, when either lane knows it. */
export function laneOf(id: string): Lane | undefined {
  for (const l of LANES) {
    const d = laneDirs(l);
    if (
      fs.existsSync(path.join(d.queue, `${id}.json`)) ||
      fs.existsSync(path.join(d.active, id)) ||
      fs.existsSync(path.join(d.done, id))
    ) {
      return l;
    }
  }
  return undefined;
}

/**
 * The follow-up chain behind a dispatch, newest first: its origin, the
 * origin's origin, and so on. The dispatch itself is not included.
 */
export function followUpAncestors(id: string, lane?: Lane): string[] {
  const out: string[] = [];
  const seen = new Set([id]);
  let cur = storedDescriptor(id, lane ?? laneOf(id) ?? 'work')?.followUp;
  while (cur && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = storedDescriptor(cur, laneOf(cur) ?? lane ?? 'work')?.followUp;
  }
  return out;
}

/**
 * The newest dispatch in the chain behind `followUp` (the origin first) whose
 * worktree still exists on disk, with that worktree.
 */
export function chainWorktree(followUp: string): (DispatchWorktree & { from: string }) | undefined {
  for (const id of [followUp, ...followUpAncestors(followUp)]) {
    const wt = dispatchWorktree(id, laneOf(id));
    if (fs.existsSync(wt.path)) return { ...wt, from: id };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The worktree lock: one runner per checkout.

/** Who holds a worktree: the dispatch whose runner works in it. */
export interface WorktreeLock {
  id: string;
  lane: Lane;
  pid: number;
  at: string;
  /**
   * `warm`: the pool warm-up holds the worktree for a moment (a check or a
   * fetch), not a dispatch. It is live while its process is, for at most
   * WARM_LOCK_MAX_MS.
   */
  kind?: 'warm';
}

/** The longest a pool warm-up holds a worktree's lock before it counts as stale. */
export const WARM_LOCK_MAX_MS = 15 * 60_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The git dir of a linked worktree (`<repo>/.git/worktrees/<name>`), read
 * from the worktree's `.git` file. A main checkout's `.git` directory is its
 * own git dir. Undefined when neither is there.
 */
export function worktreeGitDir(wt: string): string | undefined {
  const dotGit = path.join(wt, '.git');
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    return m ? path.resolve(wt, m[1]!) : undefined;
  } catch {
    return undefined;
  }
}

/** The lock file for a worktree. It lives in the git dir, so `git status` never sees it. */
export function worktreeLockFile(wt: string): string | undefined {
  const gitDir = worktreeGitDir(wt);
  return gitDir ? path.join(gitDir, 'lobstah.lock') : undefined;
}

export function readWorktreeLock(wt: string): WorktreeLock | undefined {
  const file = worktreeLockFile(wt);
  if (!file) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as WorktreeLock;
  } catch {
    return undefined;
  }
}

/**
 * A lock is held while its dispatch is active. Once the dispatch is finished
 * (or gone), the lock is stale, whatever process wrote it: the daemon
 * respawns a dead runner of an active dispatch, and that runner takes the
 * same lock again.
 */
export function lockIsLive(lock: WorktreeLock): boolean {
  if (lock.kind === 'warm') return processAlive(lock.pid) && Date.now() - (Date.parse(lock.at) || 0) < WARM_LOCK_MAX_MS;
  return fs.existsSync(path.join(laneDirs(lock.lane).active, lock.id));
}

/** The live holder of a worktree's lock, if any. */
export function worktreeHolder(wt: string): WorktreeLock | undefined {
  const lock = readWorktreeLock(wt);
  return lock && lockIsLive(lock) ? lock : undefined;
}

/**
 * Take the worktree's lock for dispatch `id`. Returns undefined on success
 * (or when `id` already holds it), else the live holder. A stale lock is
 * replaced. A worktree with no git dir cannot be locked and is refused.
 */
export function acquireWorktreeLock(wt: string, id: string, lane: Lane, kind?: 'warm'): WorktreeLock | undefined {
  const file = worktreeLockFile(wt);
  const mine: WorktreeLock = { id, lane, pid: process.pid, at: new Date().toISOString(), ...(kind ? { kind } : {}) };
  if (!file) return { id: '(no git dir)', lane, pid: 0, at: mine.at };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(mine, null, 2), { flag: 'wx' });
      return undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // released between our write and our read: try again
    }
    let held: WorktreeLock | undefined;
    try {
      held = JSON.parse(raw) as WorktreeLock;
    } catch {
      held = undefined;
    }
    if (held?.id === id) {
      fs.writeFileSync(file, JSON.stringify(mine, null, 2));
      return undefined;
    }
    if (held && lockIsLive(held)) return held;
    // Stale (holder finished or gone) or unreadable: remove it only if it
    // is still the lock we judged, then race for the file again.
    try {
      if (fs.readFileSync(file, 'utf8') === raw) fs.rmSync(file, { force: true });
    } catch {
      // gone already
    }
  }
  const held = readWorktreeLock(wt);
  return held ?? { id: '(contended)', lane, pid: 0, at: mine.at };
}

/** Release the lock if `id` holds it. */
export function releaseWorktreeLock(wt: string, id: string): void {
  const file = worktreeLockFile(wt);
  if (!file) return;
  if (readWorktreeLock(wt)?.id === id) fs.rmSync(file, { force: true });
}

/** Release whatever lock a finalized dispatch holds, found through its `worktree.json`. */
export function releaseDispatchLock(dispatchDir: string, id: string): void {
  const rec = readRecord(path.join(dispatchDir, 'worktree.json'));
  if (rec) releaseWorktreeLock(rec.path, id);
}

// ---------------------------------------------------------------------------
// releaseOnMerge bookkeeping: worktrees kept, and why.

export interface KeptWorktree {
  /** The worktree's owner id (the directory name under `worktrees/`). */
  id: string;
  reason: string;
  pr?: string;
  at: string;
}

export function keptWorktreesPath(): string {
  return path.join(lobstahHome(), 'release-kept.json');
}

/** Worktrees a merge would have released but the safety checks kept. */
export function readKeptWorktrees(): KeptWorktree[] {
  try {
    const list = JSON.parse(fs.readFileSync(keptWorktreesPath(), 'utf8')) as KeptWorktree[];
    return Array.isArray(list) ? list.filter((k) => fs.existsSync(worktreePath(k.id))) : [];
  } catch {
    return [];
  }
}

export function writeKeptWorktrees(list: KeptWorktree[]): void {
  const file = keptWorktreesPath();
  if (list.length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  atomicRenameSync(tmp, file);
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { uniqueTempPath, atomicRenameSync, lobstahHome, laneDirs } from './paths.js';
import { readWorktreeLock, lockIsLive } from './worktrees.js';
import { isTrapCatch } from './slots.js';
import type { WorktreeLock } from './worktrees.js';
import type { Config, PoolConfig } from './config.js';
import type { Descriptor, Lane } from './types.js';

/**
 * Worktree pools (`[pools.<name>]`): pre-warmed worktrees for one repo, with
 * no session attached. They live under `pools/<name>/<slot>`, outside
 * `worktrees/`, so no cull, merge release, or free-space pass ever removes
 * one. Each slot's bookkeeping sits next to it in `pools/<name>/.slots/`:
 *
 * - `<slot>.json`: written by the warm-up only. When the slot became ready,
 *   which claim it last checked after release, and the last warm-up error.
 * - `<slot>.claim.json`: written by whoever claims the slot, while holding
 *   the worktree's lock: the dispatch that last reset it (or a follow-up that
 *   reused it). A follow-up reuses a pool worktree only while the newest
 *   claim is still its own chain's.
 * - `<slot>.out.json`: the slot is out of rotation, and why. Written when a
 *   reset is refused (uncommitted or unpushed work); removed by the warm-up
 *   once the worktree is clean and pushed again.
 *
 * Who holds a slot right now is the worktree lock (worktrees.ts), the same
 * lock every headless dispatch takes: claiming a slot is taking its lock.
 */

export function poolsRoot(): string {
  return path.join(lobstahHome(), 'pools');
}

export function poolDir(pool: string): string {
  return path.join(poolsRoot(), pool);
}

/** The checkout of one pool slot. Slots are numbered from 1. */
export function poolSlotPath(pool: string, slot: number): string {
  return path.join(poolDir(pool), String(slot));
}

function slotsDir(pool: string): string {
  return path.join(poolDir(pool), '.slots');
}

/** The pool and slot a checkout path belongs to, when it is a pool slot. */
export function poolSlotOf(p: string): { pool: string; slot: number } | undefined {
  const real = (x: string) => {
    try {
      return fs.realpathSync.native(x);
    } catch {
      return path.resolve(x);
    }
  };
  // The plain paths first; then both resolved, for a home reached through a symlink.
  for (const [rootDir, dir] of [[poolsRoot(), path.resolve(p)], [real(poolsRoot()), real(p)]] as const) {
    const rel = path.relative(rootDir, dir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const parts = rel.split(/[\\/]/);
    if (parts.length !== 2 || !/^[1-9][0-9]*$/.test(parts[1]!)) continue;
    return { pool: parts[0]!, slot: Number(parts[1]) };
  }
  return undefined;
}

/** `<pool>/<slot>`, the label a slot goes by in notes and views. */
export function poolSlotLabel(pool: string, slot: number): string {
  return `${pool}/${slot}`;
}

export interface PoolSlotMeta {
  /** When the warm-up finished creating the slot (its setup ran). Unset while it is being made. */
  readyAt?: string;
  /** The claim id the warm-up last found clean and pushed after its dispatch finished. */
  verifiedClaim?: string;
  /** When the warm-up last checked an out-of-rotation slot. */
  checkedAt?: string;
  /** The warm-up's last failure creating this slot, and when. */
  error?: string;
  errorAt?: string;
}

export interface PoolSlotClaim {
  id: string;
  lane: Lane;
  at: string;
}

export interface PoolSlotOut {
  reason: string;
  at: string;
  /** The dispatch whose claim found it unsafe, when one did. */
  dispatch?: string;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  atomicRenameSync(tmp, file);
}

const metaFile = (pool: string, slot: number) => path.join(slotsDir(pool), `${slot}.json`);
const claimFile = (pool: string, slot: number) => path.join(slotsDir(pool), `${slot}.claim.json`);
const outFile = (pool: string, slot: number) => path.join(slotsDir(pool), `${slot}.out.json`);

export function readSlotMeta(pool: string, slot: number): PoolSlotMeta {
  return readJson<PoolSlotMeta>(metaFile(pool, slot)) ?? {};
}

export function writeSlotMeta(pool: string, slot: number, meta: PoolSlotMeta): void {
  writeJson(metaFile(pool, slot), meta);
}

export function readSlotClaim(pool: string, slot: number): PoolSlotClaim | undefined {
  return readJson<PoolSlotClaim>(claimFile(pool, slot));
}

/** Record who claimed the slot. Only the lock holder writes it. */
export function writeSlotClaim(pool: string, slot: number, claim: PoolSlotClaim): void {
  writeJson(claimFile(pool, slot), claim);
}

export function readSlotOut(pool: string, slot: number): PoolSlotOut | undefined {
  return readJson<PoolSlotOut>(outFile(pool, slot));
}

export function writeSlotOut(pool: string, slot: number, out: PoolSlotOut): void {
  writeJson(outFile(pool, slot), out);
}

export function clearSlotOut(pool: string, slot: number): void {
  fs.rmSync(outFile(pool, slot), { force: true });
}

/** Whether a slot is out of rotation now. `ref` is `<pool>/<slot>`. */
export function poolSlotIsOut(ref: string): boolean {
  const m = /^(.+)\/([1-9][0-9]*)$/.exec(ref);
  return m ? readSlotOut(m[1]!, Number(m[2])) !== undefined : false;
}

export type PoolSlotState = 'free' | 'claimed' | 'out' | 'warming' | 'missing';

export interface PoolSlotView {
  slot: number;
  path: string;
  state: PoolSlotState;
  /** The dispatch holding the slot (claimed), or the one that found it unsafe (out). */
  dispatch?: string;
  /** Why the slot is out of rotation, or why the warm-up could not make it. */
  reason?: string;
  /** The newest claim on the slot, whatever its state. */
  lastClaim?: string;
}

export interface PoolView {
  name: string;
  repo: string;
  size: number;
  overflow: PoolConfig['overflow'];
  free: number;
  slots: PoolSlotView[];
}

/** The live dispatch lock on a slot, ignoring the warm-up's own brief holds. */
function dispatchHolder(dir: string): WorktreeLock | undefined {
  const lock = readWorktreeLock(dir);
  return lock && lock.kind !== 'warm' && lockIsLive(lock) ? lock : undefined;
}

/** One slot's state, read from disk. */
export function poolSlotView(pool: string, slot: number): PoolSlotView {
  const dir = poolSlotPath(pool, slot);
  const lastClaim = readSlotClaim(pool, slot)?.id;
  const base = { slot, path: dir, ...(lastClaim ? { lastClaim } : {}) };
  if (!fs.existsSync(dir)) {
    const meta = readSlotMeta(pool, slot);
    return { ...base, state: 'missing', ...(meta.error ? { reason: meta.error } : {}) };
  }
  const holder = dispatchHolder(dir);
  if (holder) return { ...base, state: 'claimed', dispatch: holder.id };
  const out = readSlotOut(pool, slot);
  if (out) return { ...base, state: 'out', reason: out.reason, ...(out.dispatch ? { dispatch: out.dispatch } : {}) };
  const meta = readSlotMeta(pool, slot);
  if (!meta.readyAt) return { ...base, state: 'warming', ...(meta.error ? { reason: meta.error } : {}) };
  return { ...base, state: 'free' };
}

export function poolView(name: string, pool: PoolConfig): PoolView {
  const slots: PoolSlotView[] = [];
  for (let slot = 1; slot <= pool.size; slot++) slots.push(poolSlotView(name, slot));
  return { name, repo: pool.repo, size: pool.size, overflow: pool.overflow, free: slots.filter((s) => s.state === 'free').length, slots };
}

/** Every configured pool, as tend and status show it. */
export function poolViews(cfg: Pick<Config, 'pools'>): PoolView[] {
  return Object.entries(cfg.pools ?? {}).map(([name, pool]) => poolView(name, pool));
}

/**
 * Claimed pool dispatches that have not taken a slot yet: active, headless,
 * asking for `pool`, with no worktree recorded. The daemon counts them as
 * holding a slot, so one tick never claims more queue-mode work than there
 * are free worktrees.
 */
export function pendingPoolClaims(pool: string): number {
  let n = 0;
  for (const lane of ['work', 'chore'] as Lane[]) {
    const active = laneDirs(lane).active;
    let ids: string[];
    try {
      ids = fs.readdirSync(active).filter((f) => !f.startsWith('.'));
    } catch {
      continue;
    }
    for (const id of ids) {
      const dir = path.join(active, id);
      const d = readJson<Descriptor>(path.join(dir, 'descriptor.json'));
      if (d?.pool !== pool || fs.existsSync(path.join(dir, 'worktree.json'))) continue;
      if (isTrapCatch(id, lane)) continue;
      n++;
    }
  }
  return n;
}

/**
 * Whether the daemon leaves a queued descriptor in the queue for its pool:
 * a queue-mode pool with no free worktree (after the claims already in
 * flight). A headless-overflow pool never waits, and neither does work
 * addressed to a trap.
 */
export function poolWaits(d: Descriptor, cfg: Pick<Config, 'pools'>): boolean {
  if (!d.pool || d.for) return false;
  const pool = cfg.pools?.[d.pool];
  if (!pool || pool.overflow !== 'queue') return false;
  return poolView(d.pool, pool).free - pendingPoolClaims(d.pool) <= 0;
}

// ---------------------------------------------------------------------------
// The warm-up process: one per pool at a time.

export interface PoolWarmState {
  /** When the warm-up last fetched trunk for the pool's repo. */
  fetchedAt?: string;
  /** When a warm-up last finished. */
  finishedAt?: string;
}

const warmStateFile = (pool: string) => path.join(poolDir(pool), '.warm-state.json');
const warmLockFile = (pool: string) => path.join(poolDir(pool), '.warm.lock');

/** A warm-up holding its lock longer than this is stale whatever its pid. */
export const POOL_WARM_MAX_MS = 60 * 60_000;

export function readPoolWarmState(pool: string): PoolWarmState {
  return readJson<PoolWarmState>(warmStateFile(pool)) ?? {};
}

export function writePoolWarmState(pool: string, state: PoolWarmState): void {
  writeJson(warmStateFile(pool), state);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether a warm-up for this pool runs now. */
export function poolWarmRunning(pool: string, now = Date.now()): boolean {
  const lock = readJson<{ pid: number; at: string }>(warmLockFile(pool));
  return !!lock && pidAlive(lock.pid) && now - (Date.parse(lock.at) || 0) < POOL_WARM_MAX_MS;
}

/**
 * Take the pool's warm-up lock for this process. Returns a release
 * function, or undefined while another live warm-up holds it.
 */
export function takePoolWarmLock(pool: string): (() => void) | undefined {
  const file = warmLockFile(pool);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, mine, { flag: 'wx' });
      return () => {
        try {
          if (fs.readFileSync(file, 'utf8') === mine) fs.rmSync(file, { force: true });
        } catch {
          // gone already
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (poolWarmRunning(pool)) return undefined;
    fs.rmSync(file, { force: true });
  }
  return undefined;
}

/** How long a warm-up waits before retrying a slot it failed to create. */
export const POOL_RETRY_MS = 10 * 60_000;
/** How often idle pool worktrees are fetched. */
export const POOL_FETCH_MS = 10 * 60_000;
/** How often an out-of-rotation slot is checked for a return. */
export const POOL_RECHECK_MS = 5 * 60_000;

/**
 * Why the daemon should start a warm-up for this pool now, or undefined: a
 * slot is missing or half made (past its retry wait), a slot's dispatch
 * finished and its worktree is not yet checked, an out-of-rotation slot is
 * due a re-check, or the last fetch is old. Never while one runs.
 */
export function poolWarmDue(name: string, pool: PoolConfig, now = Date.now()): string | undefined {
  if (poolWarmRunning(name, now)) return undefined;
  const age = (iso: string | undefined) => (iso ? now - (Date.parse(iso) || 0) : Infinity);
  for (let slot = 1; slot <= pool.size; slot++) {
    const view = poolSlotView(name, slot);
    const meta = readSlotMeta(name, slot);
    if ((view.state === 'missing' || view.state === 'warming') && age(meta.errorAt) >= POOL_RETRY_MS) return `slot ${slot} ${view.state}`;
    if (view.state === 'out' && age(meta.checkedAt) >= POOL_RECHECK_MS) return `slot ${slot} out of rotation: re-check`;
    if (view.state === 'free' && view.lastClaim && view.lastClaim !== meta.verifiedClaim) return `slot ${slot} released: check`;
  }
  if (age(readPoolWarmState(name).fetchedAt) >= POOL_FETCH_MS) return 'fetch';
  return undefined;
}

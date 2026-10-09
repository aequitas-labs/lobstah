import * as fs from 'node:fs';
import * as path from 'node:path';
import { uniqueTempPath, lobstahHome } from './paths.js';

/**
 * Disk guard state. Worktrees are large (1 to 8 GB each), so the daemon
 * checks free space before it claims work that will create one, and it
 * culls finished worktrees on its own. This module holds the shared parts:
 * the free-space reader, the hold record that tend and the glass read, and
 * the timestamp that throttles the retention cull.
 */

export const GB = 1024 ** 3;

/** Where every dispatch worktree is created. */
export function worktreesDir(): string {
  return path.join(lobstahHome(), 'worktrees');
}

/** Reads free bytes on the volume that holds `dir`. Tests inject a fake. */
export type FreeBytesReader = (dir: string) => number;

/** Free bytes available to this user on the volume that holds `dir`. */
export const statfsFreeBytes: FreeBytesReader = (dir) => {
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
};

/** `3.2 GB`, one decimal place. */
export function formatGB(bytes: number): string {
  return `${(bytes / GB).toFixed(1).replace(/\.0$/, '')} GB`;
}

/**
 * A free-space hold: the daemon leaves claimable work in the queue because
 * the worktrees volume is below `[limits].minFreeGB`. The file exists only
 * while the hold stands.
 */
export interface DiskHold {
  /** When the hold started. */
  since: string;
  /** When free space was last read. */
  checkedAt: string;
  freeBytes: number;
  needBytes: number;
  dir: string;
}

export function holdPath(): string {
  return path.join(lobstahHome(), 'hold.json');
}

export function readHold(): DiskHold | undefined {
  try {
    return JSON.parse(fs.readFileSync(holdPath(), 'utf8')) as DiskHold;
  } catch {
    return undefined;
  }
}

export function writeHold(hold: DiskHold): void {
  const tmp = uniqueTempPath(holdPath());
  fs.writeFileSync(tmp, JSON.stringify(hold, null, 2));
  fs.renameSync(tmp, holdPath());
}

export function clearHold(): void {
  fs.rmSync(holdPath(), { force: true });
}

/** The reason tend and the glass show on a held dispatch. */
export function holdReason(hold: Pick<DiskHold, 'freeBytes' | 'needBytes'>): string {
  return `held: ${formatGB(hold.freeBytes)} free, needs ${formatGB(hold.needBytes)}`;
}

/** Timestamp of the last retention cull pass, for the hourly throttle. */
export function cullStampPath(): string {
  return path.join(lobstahHome(), 'cull-pass.json');
}

export function lastCullPassAt(): number | undefined {
  try {
    const at = (JSON.parse(fs.readFileSync(cullStampPath(), 'utf8')) as { at?: string }).at;
    const ms = at ? Date.parse(at) : NaN;
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

export function stampCullPass(now: number): void {
  fs.writeFileSync(cullStampPath(), JSON.stringify({ at: new Date(now).toISOString() }));
}

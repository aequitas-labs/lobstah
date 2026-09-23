import * as fs from 'node:fs';
import * as path from 'node:path';
import { lobstahHome } from '@lobstah/core';

/**
 * The reported-through cursors: one per grounds (default `fleet`), advanced
 * by `man report` and the helm park's digest. Their own module so both the
 * digest and tend's `landed` attention read them without importing each other.
 */

/** Never report further back than this, cursor or no cursor. */
export const LOOKBACK_MS = 24 * 3600_000;

function cursorFile(name: string): string {
  return path.join(lobstahHome(), 'reported', `${name}.json`);
}

export function readCursor(name: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(cursorFile(name), 'utf8')) as { through?: string };
    return typeof parsed.through === 'string' ? parsed.through : undefined;
  } catch {
    return undefined;
  }
}

/** Mark everything through `through` as reported. */
export function advanceCursor(name: string, through: string): void {
  const file = cursorFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ through })}\n`);
}

/** When the last digest was delivered (cursor mtime), for throttle cadence. */
export function lastReportedAt(name: string): number | undefined {
  try {
    return fs.statSync(cursorFile(name)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Everything at or before this is reported for a cursor: the cursor, bounded by the lookback. */
export function reportedThroughMs(name: string, now: number): number {
  const cursor = readCursor(name);
  return Math.max(cursor ? Date.parse(cursor) || 0 : 0, now - LOOKBACK_MS);
}

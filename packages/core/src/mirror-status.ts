import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicRenameSync, lobstahHome, uniqueTempPath } from './paths.js';

/**
 * What this machine's mirror last did, written by the daemon's mirror and
 * read by `wharf whoami --wharf` and the doctor. It holds no credential and
 * no fleet content.
 */
export interface MirrorStatus {
  /** The wharf `[glass] mirror` names. */
  wharf: string;
  /** This mirror's id, kept across restarts: the glass's focus probe answers with it, and the put snapshot carries it. */
  id?: string;
  /** This boat's name on that wharf, once the wharf has said. */
  boat?: string;
  /** The last snapshot put, and its ETag and gzip size. */
  lastPutAt?: string;
  etag?: string;
  bytes?: number;
  /** Until when a hosted glass is open, as the wharf last said. */
  watchedUntil?: string;
  /** The hosted glass's origin, as the wharf names it: the one origin this glass answers its focus probe for. */
  glass?: string;
  /** Relayed calls carried out since the daemon started, and the last one's time. */
  calls: number;
  lastCallAt?: string;
  /** Why the last pass failed, when it did. */
  error?: string;
  /** When this was written. */
  at: string;
}

/** How long after its last put a mirror still counts as fresh: one idle interval, with a minute's slack. */
export const MIRROR_FRESH_MS = 6 * 60_000;

export function mirrorStatusPath(): string {
  return path.join(lobstahHome(), 'wharf-mirror.json');
}

export function readMirrorStatus(): MirrorStatus | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(mirrorStatusPath(), 'utf8')) as MirrorStatus;
    return value && typeof value.wharf === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeMirrorStatus(status: MirrorStatus): void {
  const file = mirrorStatusPath(), tmp = uniqueTempPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`);
  atomicRenameSync(tmp, file);
}

/** `fresh` when the last put is recent, `stale` when it is not, `never` before the first. */
export function mirrorFreshness(status: MirrorStatus | undefined, now = Date.now()): 'fresh' | 'stale' | 'never' {
  if (!status?.lastPutAt) return 'never';
  return now - Date.parse(status.lastPutAt) <= MIRROR_FRESH_MS ? 'fresh' : 'stale';
}

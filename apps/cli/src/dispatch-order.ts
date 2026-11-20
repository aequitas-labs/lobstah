import { messageMetas, queuedAt, readSessionClaim, readStatusLog } from '@lobstah/core';
import type { Lane, StatusEntry } from '@lobstah/core';

/**
 * The glass lists dispatches newest first by their last real update: the
 * last thing that happened to the work, never a sign that a worker is alive.
 *
 * A real update is a status entry (a verb change, a note, a report, a reply),
 * a send to the worker, the claim that started it, or its queueing. Live
 * activity, heartbeats, liveness checks and polls write files inside the
 * dispatch's directory too, so the directory's mtime is no measure: it moved
 * on every tick and made the in-flight list reorder between polls.
 */

/** The moments that count as a real update for one dispatch, as ISO times. */
export interface DispatchUpdateTimes {
  /** When it was queued (its stamp, else the queue file's time). */
  queuedAt?: string;
  /** When a trap or headless worker claimed it. */
  claimedAt?: string;
  /** Its last status entry: a verb, note, report or reply. */
  lastStatusAt?: string;
  /** Its last message from the helm or a person. */
  lastSendAt?: string;
}

/** A dispatch row as the order needs it: its id and its last real update in epoch ms. */
export interface OrderedDispatch {
  id: string;
  /** Newest first: the last real update in epoch ms (GlassDispatchSummary.sort). */
  sort: number;
}

const ms = (iso: string | undefined): number => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : 0;
};

/**
 * The last real update in epoch ms. `fallbackMs` (the directory's mtime)
 * counts only when nothing real is known, such as a record with no status
 * log, so such a row still has a place.
 */
export function lastRealUpdateMs(times: DispatchUpdateTimes, fallbackMs = 0): number {
  const latest = Math.max(ms(times.queuedAt), ms(times.claimedAt), ms(times.lastStatusAt), ms(times.lastSendAt));
  return latest > 0 ? latest : fallbackMs;
}

/** The real-update times of a dispatch on disk, from its status log, claim, queue record and inbox. */
export function dispatchUpdateTimes(
  id: string,
  lane: Lane,
  bucket: 'queued' | 'active' | 'done',
  log: readonly StatusEntry[] = readStatusLog(id, lane),
): DispatchUpdateTimes {
  const sends = messageMetas(id, lane).map((m) => m.at).filter((at) => ms(at) > 0).sort();
  return {
    ...(bucket === 'queued' ? { queuedAt: queuedAt(id, lane) } : {}),
    ...(bucket === 'active' ? { claimedAt: readSessionClaim(id, lane)?.at } : {}),
    ...(log.length ? { lastStatusAt: log.at(-1)!.at } : {}),
    ...(sends.length ? { lastSendAt: sends.at(-1) } : {}),
  };
}

/** Newest real update first; equal times fall back to the dispatch id, so two rows never swap between polls. */
export function compareByLastUpdate(a: OrderedDispatch, b: OrderedDispatch): number {
  return b.sort - a.sort || a.id.localeCompare(b.id);
}

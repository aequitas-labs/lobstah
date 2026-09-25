import * as fs from 'node:fs';
import { VERBS, TERMINAL_VERBS } from './types.js';
import type { Lane, StatusEntry, Verb } from './types.js';
import { statusPath } from './paths.js';

export function isVerb(v: string): v is Verb {
  return (VERBS as readonly string[]).includes(v);
}

/** The write path IS the validation: anything outside the verb set is rejected. */
export function appendStatus(id: string, lane: Lane, verb: string, note?: string): StatusEntry {
  if (!isVerb(verb)) {
    throw new Error(`invalid status verb "${verb}" — must be one of: ${VERBS.join(', ')}`);
  }
  const entry: StatusEntry = { at: new Date().toISOString(), verb, ...(note ? { note } : {}) };
  fs.appendFileSync(statusPath(id, lane), `${JSON.stringify(entry)}\n`);
  return entry;
}

export function readStatusLog(id: string, lane: Lane): StatusEntry[] {
  const file = statusPath(id, lane);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as StatusEntry;
        return isVerb(parsed.verb) ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

export type ReconciledState = Verb | 'unknown';

export interface ReconcileInput {
  log: StatusEntry[];
  lastEventAt?: number;
  now?: number;
  busyThresholdMs?: number;
}

/**
 * Reconcile current state in precedence order: terminal log verb, then busy
 * signal (fresh event activity), then the status log. Missing, malformed, or
 * stale data is `unknown`, never `idle` — absence of signal never means done.
 */
export function reconcile({ log, lastEventAt, now = Date.now(), busyThresholdMs = 120_000 }: ReconcileInput): ReconciledState {
  const last = log[log.length - 1];
  if (last && TERMINAL_VERBS.includes(last.verb)) return last.verb;
  const busy = lastEventAt !== undefined && now - lastEventAt < busyThresholdMs;
  if (busy) return last && last.verb !== 'working' ? last.verb : 'working';
  if (last) return last.verb;
  return 'unknown';
}

/** What a caller shows: the reconciled state, or `queued` for waiting work. */
export type DisplayState = ReconciledState | 'queued';

/**
 * Apply the queue bucket on top of `reconcile`. A descriptor in `queue/`
 * with an empty status log is `queued`: nobody has claimed it yet, which is
 * a known state. Everything else keeps the reconciled state, so the
 * reconciler's contract (no signal is `unknown`) stays intact.
 */
export function displayState(input: ReconcileInput & { queued: boolean }): DisplayState {
  if (input.queued && input.log.length === 0) return 'queued';
  return reconcile(input);
}

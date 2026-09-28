import * as fs from 'node:fs';
import { VERBS, TERMINAL_VERBS, WAITING_ON, WAITING_ON_VERBS } from './types.js';
import type { Lane, StatusEntry, Verb, WaitingOn } from './types.js';
import { statusPath } from './paths.js';
import { ageLabel } from './activity.js';

export function isVerb(v: string): v is Verb {
  return (VERBS as readonly string[]).includes(v);
}

export function isWaitingOn(v: string): v is WaitingOn {
  return (WAITING_ON as readonly string[]).includes(v);
}

/** What a report may say about what it waits on. */
export interface WaitingFields {
  waitingOn?: string;
  link?: string;
  /** An ISO time, or a duration from now: 90s, 30m, 4h, 2d. */
  until?: string;
}

const DURATION = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3600_000, d: 86400_000 };

/** `--until`: an ISO time or a duration from `now`, as ISO. Throws on anything else. */
export function parseUntil(v: string, now = Date.now()): string {
  const d = DURATION.exec(v.trim());
  if (d) return new Date(now + Number(d[1]) * UNIT_MS[d[2]!.toLowerCase()]!).toISOString();
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`invalid --until "${v}" — an ISO time (2026-10-01T09:00Z) or a duration (30m, 4h, 2d)`);
  return new Date(t).toISOString();
}

/**
 * Validate `--waiting-on`, `--link`, and `--until` against the verb. The
 * link must be http or https: the glass renders it as a link.
 */
export function waitingFields(verb: Verb, w: WaitingFields, now = Date.now()): Pick<StatusEntry, 'waitingOn' | 'link' | 'until'> {
  const out: Pick<StatusEntry, 'waitingOn' | 'link' | 'until'> = {};
  if ((w.waitingOn !== undefined || w.link !== undefined) && !WAITING_ON_VERBS.includes(verb)) {
    throw new Error(`--waiting-on and --link are valid only with ${WAITING_ON_VERBS.join(', ')} — not ${verb}`);
  }
  if (w.until !== undefined && verb !== 'paused') throw new Error(`--until is valid only with paused — not ${verb}`);
  if (w.waitingOn !== undefined) {
    if (!isWaitingOn(w.waitingOn)) {
      throw new Error(`invalid --waiting-on "${w.waitingOn}" — must be one of: ${WAITING_ON.join(', ')}`);
    }
    out.waitingOn = w.waitingOn;
  }
  if (w.link !== undefined) {
    let url: URL | undefined;
    try {
      url = new URL(w.link);
    } catch {
      url = undefined;
    }
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      throw new Error(`invalid --link "${w.link}" — must be an http or https URL`);
    }
    out.link = url.href;
  }
  if (w.until !== undefined) out.until = parseUntil(w.until, now);
  return out;
}

/** The write path IS the validation: anything outside the verb set is rejected. */
export function appendStatus(id: string, lane: Lane, verb: string, note?: string, at?: string, waiting?: WaitingFields): StatusEntry {
  if (!isVerb(verb)) {
    throw new Error(`invalid status verb "${verb}" — must be one of: ${VERBS.join(', ')}`);
  }
  const extra = waiting ? waitingFields(verb, waiting) : {};
  const entry: StatusEntry = { at: at ?? new Date().toISOString(), verb, ...(note ? { note } : {}), ...extra };
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

export interface DisplayInput extends ReconcileInput {
  queued: boolean;
  /**
   * `claim.at` of an active dispatch a trap claimed (`claim.json`), if any.
   * Pass it only for the active bucket.
   */
  claimedAt?: string;
}

/**
 * Apply the known buckets on top of `reconcile`. A descriptor in `queue/`
 * with an empty status log is `queued`: nobody has claimed it yet. An active
 * dispatch with a trap claim and an empty status log is `working`: the trap
 * holds it. A claim writes its own `working` entry, so this case only covers
 * claims written before that entry existed. Everything else keeps the
 * reconciled state, so the reconciler's contract (no signal is `unknown`)
 * stays intact.
 */
export function displayState(input: DisplayInput): DisplayState {
  if (input.queued && input.log.length === 0) return 'queued';
  if (!input.queued && input.claimedAt !== undefined && input.log.length === 0) return 'working';
  return reconcile(input);
}

/** A worker paused on something external, with `--waiting-on`: not wedged, and its wall clock stops. */
export function pausedWaiting(entry: StatusEntry | undefined): boolean {
  return entry?.verb === 'paused' && entry.waitingOn !== undefined;
}

/** How a waiting entry reads: `waiting on review`, or undefined when it says nothing. */
export function waitingLabel(entry: StatusEntry | undefined): string | undefined {
  return entry?.waitingOn ? `waiting on ${entry.waitingOn}` : undefined;
}

/** What a status entry says it waits on, for readers (tend, the glass). */
export interface WaitingView {
  on: WaitingOn;
  link?: string;
  until?: string;
  /** When the wait began: the report's time. */
  since: string;
  /** Seconds waited so far. */
  waitedSecs: number;
}

export function waitingView(entry: StatusEntry | undefined, now = Date.now()): WaitingView | undefined {
  if (!entry?.waitingOn || !WAITING_ON_VERBS.includes(entry.verb)) return undefined;
  return {
    on: entry.waitingOn,
    ...(entry.link ? { link: entry.link } : {}),
    ...(entry.until ? { until: entry.until } : {}),
    since: entry.at,
    waitedSecs: Math.max(0, Math.round((now - (Date.parse(entry.at) || 0)) / 1000)),
  };
}

/** One line: `waiting on review for 12m https://…`. */
export function waitingText(v: WaitingView): string {
  return `waiting on ${v.on} for ${ageLabel(v.waitedSecs * 1000)}${v.link ? ` ${v.link}` : ''}`;
}

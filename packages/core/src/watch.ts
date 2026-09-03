import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { lobstahHome } from './paths.js';

/**
 * A watch is a standing outbound poll on something external — a ume review
 * session, a CI run, anything with a CLI that can answer "anything new since
 * cursor N?". Lobstah owns these files; everyone else registers through
 * `lobstah watch add` (the validated write path, like `report` for status).
 *
 * The check command is exec'd with `{cursor}` substituted and must print JSON:
 *   { "cursor": "43", "events": [{ "seq": 43, "summary": "..." }], "done": false }
 * Unchanged cursor + no events = quiet. `done: true` retires the watch after
 * its events are delivered. Non-zero exit or unparseable output records
 * lastError and leaves the cursor untouched — the next due check retries.
 * Checks must be read-only and idempotent: both pick and an inline `man wait`
 * may run them, coordinated only by the lastCheckedAt stamp.
 */
export interface Watch {
  key: string;
  /** Who the events belong to: an interactive session or a dispatch to fork. */
  owner: 'man' | `dispatch:${string}`;
  check: string;
  cursor: string;
  /** Override the poll cadence for this watch (seconds). */
  everySecs?: number;
  /** Continuation brief template for dispatch-owned watches; {events} substituted. */
  brief?: string;
  createdAt: string;
  lastCheckedAt?: string;
  lastError?: string;
  /** Events delivered to the owner (count into the events file). */
  seen: number;
  seenAt: number;
  /** Latest continuation dispatch — one in flight per watch. */
  lastFollowUpId?: string;
  /** Delivered `done` — retire after the owner consumes the tail. */
  done?: boolean;
}

export interface WatchEvent {
  seq: number | string;
  summary?: string;
  at: string;
  [k: string]: unknown;
}

export function watchesDir(): string {
  return path.join(lobstahHome(), 'watches');
}

function slug(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]+/g, '-');
}
function watchPath(key: string): string {
  return path.join(watchesDir(), `${slug(key)}.json`);
}
function eventsPath(key: string): string {
  return path.join(watchesDir(), `${slug(key)}.events`);
}

function writeWatch(w: Watch): void {
  fs.mkdirSync(watchesDir(), { recursive: true });
  const file = watchPath(w.key);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(w, null, 2));
  fs.renameSync(tmp, file);
}

export function readWatch(key: string): Watch | undefined {
  try {
    return JSON.parse(fs.readFileSync(watchPath(key), 'utf8')) as Watch;
  } catch {
    return undefined;
  }
}

export function listWatches(): Watch[] {
  if (!fs.existsSync(watchesDir())) return [];
  return fs
    .readdirSync(watchesDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(watchesDir(), f), 'utf8')) as Watch;
      } catch {
        return undefined;
      }
    })
    .filter((w): w is Watch => w !== undefined);
}

/** Idempotent: re-adding a key updates check/owner/cadence but keeps the cursor. */
export function addWatch(
  key: string,
  check: string,
  opts: { owner?: Watch['owner']; cursor?: string; everySecs?: number; brief?: string } = {},
): Watch {
  if (!key || !check) throw new Error('watch add requires a key and a --check command');
  const existing = readWatch(key);
  const w: Watch = {
    key,
    owner: opts.owner ?? existing?.owner ?? 'man',
    check,
    cursor: existing?.cursor ?? opts.cursor ?? '0',
    everySecs: opts.everySecs ?? existing?.everySecs,
    brief: opts.brief ?? existing?.brief,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastCheckedAt: existing?.lastCheckedAt,
    seen: existing?.seen ?? 0,
    seenAt: existing?.seenAt ?? 0,
    lastFollowUpId: existing?.lastFollowUpId,
  };
  writeWatch(w);
  return w;
}

export function removeWatch(key: string): boolean {
  const existed = fs.existsSync(watchPath(key));
  fs.rmSync(watchPath(key), { force: true });
  fs.rmSync(eventsPath(key), { force: true });
  return existed;
}

export function readWatchEvents(key: string): WatchEvent[] {
  try {
    return fs
      .readFileSync(eventsPath(key), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as WatchEvent);
  } catch {
    return [];
  }
}

/** A check is due when its cadence has elapsed since the last stamp (by anyone). */
export function watchDue(w: Watch, defaultEverySecs: number, now = Date.now()): boolean {
  const every = (w.everySecs ?? defaultEverySecs) * 1000;
  const last = w.lastCheckedAt ? Date.parse(w.lastCheckedAt) : 0;
  return now - last >= every;
}

const CHECK_TIMEOUT_MS = 90_000;

/**
 * Run one check and persist the outcome. The lastCheckedAt stamp is written
 * BEFORE the exec as a soft claim, so pick and an inline `man wait` never
 * double-poll the same watch inside one cadence window.
 */
export function runWatchCheck(w: Watch, now = new Date()): { watch: Watch; fresh: WatchEvent[] } {
  w.lastCheckedAt = now.toISOString();
  writeWatch(w);
  const cmd = w.check.replaceAll('{cursor}', w.cursor);
  const res = spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  if (res.status !== 0 || res.error) {
    w.lastError = (res.error?.message || res.stderr?.trim() || `exit ${res.status}`).slice(0, 500);
    writeWatch(w);
    return { watch: w, fresh: [] };
  }
  let parsed: { cursor?: unknown; events?: unknown; done?: unknown };
  try {
    parsed = JSON.parse(res.stdout) as typeof parsed;
  } catch {
    w.lastError = `unparseable check output: ${res.stdout.slice(0, 200).trim()}`;
    writeWatch(w);
    return { watch: w, fresh: [] };
  }
  w.lastError = undefined;
  const fresh: WatchEvent[] = Array.isArray(parsed.events)
    ? (parsed.events as Array<Record<string, unknown>>).map((e) => ({
        seq: (e.seq ?? w.cursor) as number | string,
        summary: e.summary !== undefined ? String(e.summary) : undefined,
        ...e,
        at: now.toISOString(),
      }))
    : [];
  if (fresh.length > 0) {
    fs.appendFileSync(eventsPath(w.key), fresh.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  if (parsed.cursor !== undefined) w.cursor = String(parsed.cursor);
  if (parsed.done === true) w.done = true;
  writeWatch(w);
  return { watch: w, fresh };
}

export interface WatchAttention {
  watch: Watch;
  events: WatchEvent[];
}

/**
 * Undelivered events per watch, for the owner to consume. Level-triggered like
 * dispatch attention: events stay standing until consumed, so a killed watcher
 * never loses a wake. Consuming advances `seen`; a consumed `done` watch is
 * retired here (its purpose is spent).
 */
export function pendingWatchEvents(
  consume: boolean,
  owner: 'man' | 'dispatch' = 'man',
  now = Date.now(),
): WatchAttention[] {
  const out: WatchAttention[] = [];
  for (const w of listWatches()) {
    const isMan = w.owner === 'man';
    if ((owner === 'man') !== isMan) continue;
    const events = readWatchEvents(w.key);
    const fresh = events.slice(w.seen);
    if (fresh.length === 0) {
      if (w.done && consume) removeWatch(w.key);
      continue;
    }
    out.push({ watch: w, events: fresh });
    if (consume) {
      w.seen = events.length;
      w.seenAt = now;
      if (w.done) removeWatch(w.key);
      else writeWatch(w);
    }
  }
  return out;
}

/** Persist bookkeeping pick needs after spawning a continuation dispatch. */
export function markFollowUp(key: string, followUpId: string, deliveredThrough: number): void {
  const w = readWatch(key);
  if (!w) return;
  w.lastFollowUpId = followUpId;
  w.seen = deliveredThrough;
  w.seenAt = Date.now();
  if (w.done) removeWatch(w.key);
  else writeWatch(w);
}

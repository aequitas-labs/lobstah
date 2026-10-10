import fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { uniqueTempPath, atomicRenameSync, lobstahHome, readDirIfPresent } from './paths.js';
import { classifyGhError, firstMeaningfulLine, isBackoffKind } from './gh-errors.js';
import type { GhErrorKind } from './gh-errors.js';
import { postNotice } from './notices.js';
import { isPrPresetWatch, prBatchInFlight } from './pr-poll.js';
import { recordGitHubRateLimit } from './github-budget.js';

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
 * A check that half-worked prints its JSON with an `"error": "..."` string:
 * the cursor and events apply, and the error counts as a failure too.
 *
 * Failures form a streak: the reason, exit code, and the time of the first
 * failure are kept on the watch; the third consecutive failure posts one
 * `watch-failing` notice, and the first success after it posts one
 * `watch-recovered`. Permission, auth and not-found failures back off.
 * Rate limits are a shared GitHub incident, never per-watch failure streaks.
 * Checks must be read-only and idempotent: both pick and an inline `man wait`
 * may run them, coordinated only by the lastCheckedAt stamp.
 */
export interface Watch {
  key: string;
  /** Who the events belong to: an interactive session or a dispatch to fork. */
  owner: 'man' | `dispatch:${string}`;
  check: string;
  /**
   * Optional held-stream command: a long-running process (spawned with
   * {cursor} substituted) that emits the same event objects as NDJSON lines,
   * plus bare {"cursor": "N"} checkpoints. A latency optimization over the
   * check — the cursor poll remains the guarantee, and seq-deduped appends
   * make the overlap harmless.
   */
  stream?: string;
  cursor: string;
  /** Override the poll cadence for this watch (seconds). */
  everySecs?: number;
  /** Continuation brief template for dispatch-owned watches; {key}, {summaries} (one line per event), and {events} (JSON) substituted. */
  brief?: string;
  createdAt: string;
  lastCheckedAt?: string;
  /** The first meaningful line of the last failure; cleared on success. */
  lastError?: string;
  /** Exit code of the last failed check (absent for a half-worked check that exited 0). */
  lastExit?: number;
  /** Consecutive failed checks in the current streak. */
  failures?: number;
  /** When the current failure streak began. */
  failingSince?: string;
  /** Classified cause of the last failure (gh-errors.ts), and what to do about it. */
  errorKind?: GhErrorKind;
  remedy?: string;
  /** The streak's `watch-failing` notice was posted; a recovery notice is owed. */
  failingNoticed?: boolean;
  /** Events delivered to the owner (count into the events file). */
  seen: number;
  seenAt: number;
  /** Latest continuation dispatch — one in flight per watch. */
  lastFollowUpId?: string;
  /** Delivered `done` — retire after the owner consumes the tail. */
  done?: boolean;
  /**
   * Set when a watch cycle reached its fork cap ([watch].maxForksPerCycle)
   * before this watch's events forked. A held watch keeps checking and
   * buffering, but forks nothing until `lobstah watch release` clears it.
   */
  heldAt?: string;
  /** Why the watch is held: the fork cap, a cancelled repair, or the default watch-hold reason. */
  heldReason?: string;
  /** `watch hold --for <id>`: the hold ends when that dispatch ends. */
  heldFor?: string;
  /** Who set the hold, as a PR record's waiting repair shows it (`helm` for a cancelled repair). */
  heldBy?: string;
  /**
   * A PR watch's CI-fix rounds, as `<head sha>:<check name>`: one round per
   * check and commit. The newest 100 are kept.
   */
  checkRounds?: string[];
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

/** Publish/retire under a short lock, never while running the external check. */
function withWatchLock<T>(key: string, action: (deadline: number) => T): T {
  fs.mkdirSync(watchesDir(), { recursive: true });
  const lock = `${watchPath(key)}.lock`;
  const deadline = Date.now() + 10_000;
  // Windows can report these while another writer's removed directory still
  // has open handles. Retry briefly, but retain the error if it persists.
  const transient = (err: unknown) => ['EPERM', 'EBUSY', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '');
  const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      const exists = (err as NodeJS.ErrnoException).code === 'EEXIST';
      if (!exists && !transient(err)) throw err;
      if (exists) {
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) fs.rmdirSync(lock);
        } catch {
          /* another writer cleared the lock */
        }
      }
      if (Date.now() >= deadline) throw exists ? new Error(`Watch locked: ${key}`) : err;
      pause();
    }
  }
  try {
    return action(deadline);
  } finally {
    for (;;) {
      try {
        fs.rmdirSync(lock);
        break;
      } catch (err) {
        if (!transient(err) || Date.now() >= deadline) throw err;
        pause();
      }
    }
  }
}

function writeWatchUnlocked(w: Watch, deadline: number): void {
  const file = watchPath(w.key);
  const tmp = uniqueTempPath(file);
  try {
    fs.writeFileSync(tmp, JSON.stringify(w, null, 2));
    atomicRenameSync(tmp, file, deadline);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function currentWatch(w: Watch): boolean {
  return readWatch(w.key)?.createdAt === w.createdAt;
}

/** A stale update is quiet: only watch add may create a missing record. */
function writeWatch(w: Watch, create = false): boolean {
  return withWatchLock(w.key, (deadline) => {
    if (!create && !currentWatch(w)) return false;
    writeWatchUnlocked(w, deadline);
    return true;
  });
}

export function readWatch(key: string): Watch | undefined {
  try {
    return JSON.parse(fs.readFileSync(watchPath(key), 'utf8')) as Watch;
  } catch {
    return undefined;
  }
}

export function listWatches(): Watch[] {
  return readDirIfPresent(watchesDir())
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
  opts: { owner?: Watch['owner']; cursor?: string; everySecs?: number; brief?: string; stream?: string } = {},
): Watch {
  if (!key || !check) throw new Error('watch add requires a key and a --check command');
  const existing = readWatch(key);
  const w: Watch = {
    key,
    owner: opts.owner ?? existing?.owner ?? 'man',
    check,
    stream: opts.stream ?? existing?.stream,
    cursor: existing?.cursor ?? opts.cursor ?? '0',
    everySecs: opts.everySecs ?? existing?.everySecs,
    brief: opts.brief ?? existing?.brief,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastCheckedAt: existing?.lastCheckedAt,
    // A re-add keeps the failure streak: its backoff and its one notice.
    lastError: existing?.lastError,
    lastExit: existing?.lastExit,
    failures: existing?.failures,
    failingSince: existing?.failingSince,
    errorKind: existing?.errorKind,
    remedy: existing?.remedy,
    failingNoticed: existing?.failingNoticed,
    seen: existing?.seen ?? 0,
    seenAt: existing?.seenAt ?? 0,
    lastFollowUpId: existing?.lastFollowUpId,
    heldAt: existing?.heldAt,
    heldReason: existing?.heldReason,
    heldFor: existing?.heldFor,
    heldBy: existing?.heldBy,
    checkRounds: existing?.checkRounds,
  };
  writeWatch(w, true);
  return w;
}

/**
 * Mark a watch held: its buffered events and its PR repairs wait for
 * `lobstah watch release`. A hold that exists keeps its time; a reason or
 * a dispatch given here replaces the old one. Returns the watch, or
 * undefined when no watch has this key.
 */
export function holdWatch(key: string, now = new Date(), opts: { reason?: string; forId?: string; by?: string } = {}): Watch | undefined {
  const w = readWatch(key);
  if (!w) return undefined;
  if (w.heldAt && opts.reason === undefined && opts.forId === undefined && opts.by === undefined) return w;
  w.heldAt ??= now.toISOString();
  if (opts.reason !== undefined) w.heldReason = opts.reason;
  if (opts.forId !== undefined) w.heldFor = opts.forId;
  if (opts.by !== undefined) w.heldBy = opts.by;
  writeWatch(w);
  return w;
}

/** Clear the hold on one watch, or on every held watch when key is undefined. Returns the released keys. */
export function releaseHeldWatches(key?: string): string[] {
  const out: string[] = [];
  for (const w of key === undefined ? listWatches() : [readWatch(key)].filter((x): x is Watch => x !== undefined)) {
    if (!w.heldAt) continue;
    w.heldAt = undefined;
    w.heldReason = undefined;
    w.heldFor = undefined;
    w.heldBy = undefined;
    writeWatch(w);
    out.push(w.key);
  }
  return out;
}

export function removeWatch(key: string): boolean {
  return withWatchLock(key, () => {
    const existed = fs.existsSync(watchPath(key));
    fs.rmSync(watchPath(key), { force: true });
    fs.rmSync(eventsPath(key), { force: true });
    return existed;
  });
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

/**
 * Append events exactly once by seq — the stream and the cadence poll may
 * both see the same event, and at-least-once delivery upstream must not
 * become duplicate delivery downstream. Returns what was actually new.
 */
export function appendWatchEvents(key: string, events: WatchEvent[]): WatchEvent[] {
  const seen = new Set(readWatchEvents(key).map((e) => String(e.seq)));
  const fresh = events.filter((e) => !seen.has(String(e.seq)));
  if (fresh.length > 0) {
    fs.appendFileSync(eventsPath(key), fresh.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  return fresh;
}

/** Advance a watch's cursor (stream checkpoints; the check writes its own). */
export function setWatchCursor(key: string, cursor: string): void {
  const w = readWatch(key);
  if (!w || w.cursor === cursor) return;
  w.cursor = cursor;
  writeWatch(w);
}

/** Longest poll interval a backing-off watch reaches. */
export const WATCH_BACKOFF_CAP_SECS = 3600;
/** Consecutive failures that raise the one `watch-failing` notice. */
export const WATCH_FAILING_NOTICE_AT = 3;

/**
 * The watch's current poll interval. A watch failing for a cause that will
 * not fix itself (permission, auth, not found) doubles its
 * interval with each consecutive failure, capped at one hour (or at its own
 * interval, when that is longer already). Other failures retry at cadence.
 */
export function watchIntervalSecs(w: Pick<Watch, 'everySecs' | 'failures' | 'errorKind'>, defaultEverySecs: number): number {
  const base = w.everySecs ?? defaultEverySecs;
  const n = w.failures ?? 0;
  if (n <= 0 || !isBackoffKind(w.errorKind)) return base;
  return Math.min(base * 2 ** Math.min(n, 30), Math.max(base, WATCH_BACKOFF_CAP_SECS));
}

/** A check is due when its interval has elapsed since the last stamp (by anyone). */
export function watchDue(w: Watch, defaultEverySecs: number, now = Date.now()): boolean {
  const every = watchIntervalSecs(w, defaultEverySecs) * 1000;
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
  // Another feeder is fetching this repository; it owns this window.
  if (isPrPresetWatch(w) && prBatchInFlight(w.key)) return { watch: w, fresh: [] };
  w.lastCheckedAt = now.toISOString();
  if (!writeWatch(w)) return { watch: w, fresh: [] };
  const cmd = w.check.replaceAll('{cursor}', w.cursor);
  const res = spawnSync(cmd, {
    shell: true,
    encoding: 'utf8',
    timeout: CHECK_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ...(isPrPresetWatch(w) ? { LOBSTAH_PR_BATCH: '1' } : {}) },
  });
  return withWatchLock(w.key, (deadline) => {
    // A terminal PR or an explicit removal can retire this watch during the exec.
    if (!currentWatch(w)) return { watch: w, fresh: [] };
    if (res.status !== 0 || res.error) {
      // lobstah's own commands print `error: ...` on stdout (axi.md P6); gh prints to stderr.
      const toonError = /^error:.*$/m.exec(res.stdout ?? '')?.[0];
      const reason = res.error?.message || firstMeaningfulLine(toonError, res.stderr, res.stdout) || 'no output';
      recordWatchFailure(w, reason, res.status ?? undefined, now);
      writeWatchUnlocked(w, deadline);
      return { watch: w, fresh: [] };
    }
    let parsed: { cursor?: unknown; events?: unknown; done?: unknown; error?: unknown };
    try {
      parsed = JSON.parse(res.stdout) as typeof parsed;
    } catch {
      recordWatchFailure(w, `unparseable check output: ${res.stdout.slice(0, 200).trim()}`, undefined, now);
      writeWatchUnlocked(w, deadline);
      return { watch: w, fresh: [] };
    }
    if (typeof parsed.error === 'string' && parsed.error) recordWatchFailure(w, parsed.error, undefined, now);
    else recordWatchSuccess(w);
    const events: WatchEvent[] = Array.isArray(parsed.events)
      ? (parsed.events as Array<Record<string, unknown>>).map((e) => ({
          seq: (e.seq ?? w.cursor) as number | string,
          summary: e.summary !== undefined ? String(e.summary) : undefined,
          ...e,
          at: now.toISOString(),
        }))
      : [];
    const fresh = appendWatchEvents(w.key, events);
    if (parsed.cursor !== undefined) w.cursor = String(parsed.cursor);
    if (parsed.done === true) w.done = true;
    writeWatchUnlocked(w, deadline);
    return { watch: w, fresh };
  });
}

/**
 * One failed check: keep the reason and exit code, extend the streak, and
 * post the streak's one `watch-failing` notice at the third failure. The
 * dedupe key names the streak's start, so pick and `man wait` racing on the
 * same watch still post it once.
 */
export function recordWatchFailure(w: Watch, reason: string, exit: number | undefined, now = new Date()): void {
  const cls = classifyGhError(reason);
  if (cls.kind === 'rate-limit') {
    recordGitHubRateLimit(now.getTime());
    // Shared outage, not a failed watch. Drop legacy rate-limit streaks silently.
    if (w.errorKind === 'rate-limit') {
      w.failures = undefined;
      w.failingSince = undefined;
      w.failingNoticed = undefined;
    }
    return;
  }
  w.lastError = reason.slice(0, 500);
  w.lastExit = exit;
  w.errorKind = cls.kind;
  w.remedy = cls.remedy;
  w.failures = (w.failures ?? 0) + 1;
  w.failingSince ??= now.toISOString();
  if (w.failures >= WATCH_FAILING_NOTICE_AT && !w.failingNoticed) {
    w.failingNoticed = true;
    postNotice({
      kind: 'watch-failing',
      text: `${w.key} failing ${w.failures}× since ${w.failingSince}: ${watchErrorText(w)}`,
      refId: w.owner.startsWith('dispatch:') ? w.owner.slice('dispatch:'.length) : w.key,
      dedupeKey: `watch-failing-${w.key}-${w.failingSince}`,
    });
  }
}

/** One good check: end the streak, and post `watch-recovered` if the streak was announced. */
export function recordWatchSuccess(w: Watch): void {
  if (w.failingNoticed && w.errorKind !== 'rate-limit') {
    postNotice({
      kind: 'watch-recovered',
      text: `${w.key} recovered after ${w.failures ?? 0} failed check(s) since ${w.failingSince ?? '?'}`,
      refId: w.owner.startsWith('dispatch:') ? w.owner.slice('dispatch:'.length) : w.key,
      dedupeKey: `watch-recovered-${w.key}-${w.failingSince ?? ''}`,
    });
  }
  w.lastError = undefined;
  w.lastExit = undefined;
  w.errorKind = undefined;
  w.remedy = undefined;
  w.failures = undefined;
  w.failingSince = undefined;
  w.failingNoticed = undefined;
}

/** Upgrade old per-watch rate-limit streaks silently before the next repository poll. */
export function clearWatchRateLimitFailures(): void {
  for (const w of listWatches()) {
    if (w.errorKind !== 'rate-limit') continue;
    recordWatchSuccess(w);
    writeWatch(w);
  }
}

/** The reason, exit code, and remedy of a failing watch, on one line. */
export function watchErrorText(w: Pick<Watch, 'lastError' | 'lastExit' | 'remedy'>): string {
  if (!w.lastError) return '';
  return `${w.lastError}${w.lastExit !== undefined ? ` (exit ${w.lastExit})` : ''}${w.remedy ? ` — ${w.remedy}` : ''}`;
}

/** The daemon log line for a failed check: `<key> check failed: <reason> (exit N) — <remedy>`. */
export function watchFailureLogLine(w: Watch): string {
  return `${w.key} check failed: ${watchErrorText(w)}`;
}

/** tend's and the glass's error cell: the reason, then when the streak began. */
export function watchErrorCell(w: Pick<Watch, 'lastError' | 'lastExit' | 'remedy' | 'failures' | 'failingSince'>): string {
  if (!w.lastError) return '';
  return `${watchErrorText(w)} · failing since ${w.failingSince ?? '?'}${w.failures && w.failures > 1 ? ` (${w.failures}×)` : ''}`;
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
  /** Events recorded before this (a helm's sign-on) are consumed without waking. */
  sinceMs = 0,
): WatchAttention[] {
  const out: WatchAttention[] = [];
  for (const w of listWatches()) {
    const isMan = w.owner === 'man';
    if ((owner === 'man') !== isMan) continue;
    const events = readWatchEvents(w.key);
    const unseen = events.slice(w.seen);
    if (unseen.length === 0) {
      if (w.done && consume) removeWatch(w.key);
      continue;
    }
    const fresh = sinceMs > 0 ? unseen.filter((e) => (Date.parse(e.at) || 0) >= sinceMs) : unseen;
    if (fresh.length > 0) out.push({ watch: w, events: fresh });
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

/** Consume PR watch events handled by the repair planner without a generic continuation. */
export function markWatchSeen(key: string): void {
  const w = readWatch(key);
  if (!w) return;
  w.seen = readWatchEvents(key).length;
  w.seenAt = Date.now();
  writeWatch(w);
}

/** Keep this many CI-fix rounds on a watch. */
const CHECK_ROUNDS_KEPT = 100;

/** The round key of one check at one head: `<head sha>:<check name>`. */
export function checkRoundKey(headSha: string, name: string): string {
  return `${headSha}:${name}`;
}

/** Record CI-fix rounds a continuation took on a PR watch (see checkRounds). */
export function recordCheckRounds(key: string, rounds: readonly string[]): void {
  if (rounds.length === 0) return;
  const w = readWatch(key);
  if (!w) return;
  w.checkRounds = [...new Set([...(w.checkRounds ?? []), ...rounds])].slice(-CHECK_ROUNDS_KEPT);
  writeWatch(w);
}

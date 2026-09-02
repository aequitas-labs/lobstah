import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { activeIds, laneDirs, lastEventAt, readStatusLog, reconcile } from '@lobstah/core';
import type { Lane, StatusEntry } from '@lobstah/core';

export interface NotifyEvent {
  id: string;
  lane: Lane;
  entry: StatusEntry;
}

export const DEFAULT_NOTIFY_VERBS = ['needs-decision', 'blocked', 'done', 'failed'];

function cursorPath(id: string, lane: Lane): string {
  return path.join(laneDirs(lane).state, `${id}.notified`);
}

/**
 * Status entries past the notification cursor, filtered to wake-worthy verbs.
 * The cursor advances over everything seen (at-most-once delivery — a crash
 * between cursor write and exec drops, never duplicates). On first sight of a
 * dispatch (no cursor yet), entries older than `sinceMs` are baselined without
 * emitting, so enabling notifications never replays history.
 */
export function pendingNotifications(
  id: string,
  lane: Lane,
  verbs = DEFAULT_NOTIFY_VERBS,
  sinceMs = 0,
): NotifyEvent[] {
  const log = readStatusLog(id, lane);
  let cursor: number | undefined;
  try {
    cursor = Number(fs.readFileSync(cursorPath(id, lane), 'utf8')) || 0;
  } catch {
    cursor = undefined;
  }
  if (log.length <= (cursor ?? 0)) return [];
  let fresh = log.slice(cursor ?? 0);
  if (cursor === undefined && sinceMs > 0) {
    fresh = fresh.filter((e) => Date.parse(e.at) >= sinceMs);
  }
  fs.writeFileSync(cursorPath(id, lane), String(log.length));
  return fresh.filter((e) => verbs.includes(e.verb)).map((entry) => ({ id, lane, entry }));
}

/** Status files touched recently enough to be worth scanning. */
export function notifiableIds(lane: Lane, maxAgeMs = 48 * 3600_000): string[] {
  const dir = laneDirs(lane).state;
  const cutoff = Date.now() - maxAgeMs;
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.status'))
    .filter((f) => fs.statSync(path.join(dir, f)).mtimeMs > cutoff)
    .map((f) => f.slice(0, -'.status'.length));
}

/** Fire-and-forget: a failing notifier never blocks supervision. */
export function execNotify(command: string, ev: NotifyEvent, log: (m: string) => void = () => {}): void {
  const child = spawn(command, {
    shell: true,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      LOBSTAH_ID: ev.id,
      LOBSTAH_LANE: ev.lane,
      LOBSTAH_VERB: ev.entry.verb,
      LOBSTAH_NOTE: ev.entry.note ?? '',
      LOBSTAH_AT: ev.entry.at,
    },
  });
  child.on('error', (err) => log(`notify: ${err.message}`));
  child.unref();
}

/** Log lengths for every known dispatch — the edge-trigger baseline for wait. */
export function captureWaitBaseline(): Record<string, number> {
  const lengths: Record<string, number> = {};
  for (const lane of ['work', 'chore'] as Lane[]) {
    for (const id of notifiableIds(lane, Number.POSITIVE_INFINITY)) {
      lengths[`${lane}:${id}`] = readStatusLog(id, lane).length;
    }
  }
  return lengths;
}

function attnCursorPath(id: string, lane: Lane): string {
  return path.join(laneDirs(lane).state, `${id}.attn`);
}

interface AttnCursor {
  seen: number;
  at: number;
}

function readAttnCursor(file: string): AttnCursor {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as AttnCursor;
    return { seen: parsed.seen ?? 0, at: parsed.at ?? 0 };
  } catch {
    return { seen: 0, at: 0 };
  }
}

/**
 * Level-triggered: dispatches whose CURRENT reconciled state needs a human.
 * This closes the re-arm gap — an event that fired while no watcher was armed
 * is still standing state, not a vanished edge.
 *
 * Delivery is at-least-once with backoff. An attention state is one only a
 * human's answer can clear, so a naively level-triggered watcher would re-wake
 * for the same unanswered question at every turn end. Instead each entry is
 * reported once immediately, then re-fired as a reminder every `remindMs`
 * while it still stands — never lost, never a tight loop, and the natural
 * side effect of answering (a new status entry follows the inbox message)
 * ends the reminders. remindMs of 0 disables reminders (pure at-most-once).
 * Pass consume=false to peek without touching cursors.
 */
export function attentionNow(consume = true, remindMs = 15 * 60_000, now = Date.now()): NotifyEvent[] {
  const out: NotifyEvent[] = [];
  for (const lane of ['work', 'chore'] as Lane[]) {
    for (const id of activeIds(lane)) {
      const log = readStatusLog(id, lane);
      const state = reconcile({ log, lastEventAt: lastEventAt(id, lane) });
      if (state !== 'needs-decision' && state !== 'blocked') continue;
      const index = log.length - 1 - [...log].reverse().findIndex((e) => e.verb === state);
      const entry = log[index];
      if (!entry) continue;
      const file = attnCursorPath(id, lane);
      const cursor = readAttnCursor(file);
      const fresh = index >= cursor.seen;
      const remind = !fresh && remindMs > 0 && now - cursor.at > remindMs;
      if (!fresh && !remind) continue;
      out.push({ id, lane, entry });
      if (consume) fs.writeFileSync(file, JSON.stringify({ seen: Math.max(cursor.seen, index + 1), at: now }));
    }
  }
  return out;
}

/** Edge-triggered: entries appended since the baseline, filtered to wake verbs. */
export function freshWakeEvents(baseline: Record<string, number>, verbs = DEFAULT_NOTIFY_VERBS): NotifyEvent[] {
  const out: NotifyEvent[] = [];
  for (const lane of ['work', 'chore'] as Lane[]) {
    for (const id of notifiableIds(lane, Number.POSITIVE_INFINITY)) {
      const key = `${lane}:${id}`;
      const log = readStatusLog(id, lane);
      const seen = baseline[key] ?? 0;
      if (log.length > seen) {
        baseline[key] = log.length;
        for (const entry of log.slice(seen)) {
          if (verbs.includes(entry.verb)) out.push({ id, lane, entry });
        }
      }
    }
  }
  return out;
}

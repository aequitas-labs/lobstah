import { createHash } from 'node:crypto';
import type {
  GlassBeats,
  GlassDispatch,
  GlassDispatchSummary,
  GlassFullSnapshot,
  GlassOlderKind,
  GlassOlderPage,
  GlassPr,
  GlassSnapshot,
  Notice,
} from '@lobstah/core';
import { LANDED_WINDOW_MS } from './glass-diff.js';

/**
 * What /data sends on each 2s poll, from a full snapshot: dispatch
 * summaries, not their briefs, logs, and evidence (those are in the detail,
 * `/data/dispatch/<id>`), and only recent history. The rest pages in from
 * `/data/older`. Pure: the server, its snapshot thread, and the page tests
 * all use it.
 */

/** History newer than this is in every poll. */
export const POLL_WINDOW_MS = LANDED_WINDOW_MS;
/** At least this many of each kind's newest finished records are in every poll, however old. */
export const POLL_MIN: Record<GlassOlderKind, number> = { dispatches: 20, notices: 50, prs: 20 };
/** A `/data/older` page's default and largest size. */
export const OLDER_PAGE = 50;
export const OLDER_PAGE_MAX = 200;
/** A summary's note is cut to this many characters; the detail has all of it. */
export const NOTE_MAX = 280;
/** A summary's title is the brief's first line, cut to this many characters. */
export const TITLE_MAX = 120;

/** The brief's first line, trimmed and cut to TITLE_MAX characters. */
export function briefTitle(brief: string): string {
  return (brief.split(/\r?\n/, 1)[0] ?? '').trim().slice(0, TITLE_MAX);
}

/** A note cut to NOTE_MAX characters and an ellipsis. */
const cutNote = (note: string): string => (note.length > NOTE_MAX ? `${note.slice(0, NOTE_MAX)}…` : note);

/** A dispatch as /data sends it. */
export function dispatchSummary(x: GlassDispatch | GlassDispatchSummary): GlassDispatchSummary {
  const { brief, attachments, messageAttachments, log, inbox, evidence, note, noteCut, ...rest } = x as GlassDispatch;
  const cut = note !== undefined && note.length > NOTE_MAX;
  const ev = evidence && {
    ...(evidence.deliveredTo !== undefined ? { deliveredTo: evidence.deliveredTo } : {}),
    ...(evidence.prUrl !== undefined ? { prUrl: evidence.prUrl } : {}),
    ...(evidence.prUrls !== undefined ? { prUrls: evidence.prUrls } : {}),
    ...(evidence.pr?.url !== undefined ? { pr: { url: evidence.pr.url } } : {}),
  };
  return {
    ...rest,
    title: rest.title ?? briefTitle(brief ?? ''),
    ...(note !== undefined ? { note: cutNote(note) } : {}),
    ...(cut || noteCut ? { noteCut: true } : {}),
    ...(ev && Object.keys(ev).length > 0 ? { evidence: ev } : {}),
  };
}

const time = (iso: string | undefined): number => (iso ? Date.parse(iso) || 0 : 0);
const prAt = (p: GlassPr): number => time(p.mergedAt ?? p.closedAt ?? p.updatedAt ?? p.observedAt);

/**
 * Split a newest-first list into what the poll keeps and the older rest. A
 * record is kept when `always` holds, when it is newer than the window, or
 * when it is among the `min` newest of the others.
 */
function split<T>(items: T[], always: (x: T) => boolean, at: (x: T) => number, min: number, now: number): { kept: T[]; older: T[] } {
  const kept: T[] = [];
  const older: T[] = [];
  let finished = 0;
  for (const x of items) {
    if (always(x)) kept.push(x);
    else if (finished++ < min || at(x) >= now - POLL_WINDOW_MS) kept.push(x);
    else older.push(x);
  }
  return { kept, older };
}

function histories(full: GlassFullSnapshot | GlassSnapshot, now: number) {
  return {
    dispatches: split(full.dispatches, (x) => x.bucket !== 'done', (x) => x.sort, POLL_MIN.dispatches, now),
    notices: split(full.notices, () => false, (n) => time(n.at), POLL_MIN.notices, now),
    prs: split(full.prs, (p) => p.state === 'OPEN', prAt, POLL_MIN.prs, now),
  };
}

/** The /data snapshot: summaries and recent history, with counts of what is left out. */
export function pollSnapshot(full: GlassFullSnapshot | GlassSnapshot, now: number): GlassSnapshot {
  const h = histories(full, now);
  const kept = new Set(h.prs.kept.map((p) => p.stackId));
  return {
    ...full,
    dispatches: h.dispatches.kept.map(dispatchSummary),
    notices: h.notices.kept,
    prs: h.prs.kept,
    stacks: full.stacks.filter((s) => s.open || kept.has(s.id)),
    // The deck shows the last day's landed catches, each by its note's start;
    // nothing shows older ones.
    landed: full.landed
      .filter((l) => time(l.at) >= now - LANDED_WINDOW_MS)
      .map((l) => (l.note !== undefined ? { ...l, note: cutNote(l.note) } : l)),
    older: { dispatches: h.dispatches.older.length, notices: h.notices.older.length, prs: h.prs.older.length },
  };
}

/** One page of what pollSnapshot leaves out, newest first. */
export function olderPage(full: GlassFullSnapshot | GlassSnapshot, kind: GlassOlderKind, offset: number, limit: number, now: number): GlassOlderPage {
  const older = histories(full, now)[kind].older;
  const start = Math.max(0, Math.floor(offset) || 0);
  const size = Math.min(OLDER_PAGE_MAX, Math.max(1, Math.floor(limit) || OLDER_PAGE));
  const page = older.slice(start, start + size);
  if (kind === 'dispatches') return { kind, offset: start, total: older.length, items: (page as GlassDispatchSummary[]).map(dispatchSummary) };
  if (kind === 'notices') return { kind, offset: start, total: older.length, items: page as Notice[] };
  const ids = new Set((page as GlassPr[]).map((p) => p.stackId));
  return { kind, offset: start, total: older.length, items: page as GlassPr[], stacks: full.stacks.filter((s) => ids.has(s.id)) };
}

/** The fields that tick on every poll. */
export function beatsOf(d: GlassSnapshot): GlassBeats {
  const traps: GlassBeats['traps'] = {};
  for (const t of d.traps) {
    if (t.heartbeatAt !== undefined || t.parkedAt !== undefined) {
      traps[t.trapId] = { ...(t.heartbeatAt !== undefined ? { heartbeatAt: t.heartbeatAt } : {}), ...(t.parkedAt !== undefined ? { parkedAt: t.parkedAt } : {}) };
    }
  }
  return {
    now: d.now,
    ...(d.daemon?.heartbeat !== undefined ? { daemon: d.daemon.heartbeat } : {}),
    helms: Object.fromEntries(d.helms.map((h) => [h.grounds, h.heartbeatAt])),
    traps,
  };
}

/** Keys that tick while nothing a person reads changes: the beats, and ages the page computes itself from their timestamps. */
const TICKING = new Set(['now', 'heartbeat', 'heartbeatAt', 'parkedAt', 'ageSecs', 'waitedSecs']);

/** A /data answer: the body, its content hash (the ETag's), and its beats. */
export interface PollBody {
  body: string;
  hash: string;
  beats: GlassBeats;
}

export function pollBody(full: GlassFullSnapshot | GlassSnapshot, now: number): PollBody {
  const snap = pollSnapshot(full, now);
  const stable = JSON.stringify(snap, (key, value: unknown) => (TICKING.has(key) ? undefined : value));
  return { body: JSON.stringify(snap), hash: createHash('sha256').update(stable).digest('base64url').slice(0, 22), beats: beatsOf(snap) };
}

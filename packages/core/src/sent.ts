import * as fs from 'node:fs';
import * as path from 'node:path';
import { lobstahHome } from './paths.js';
import { readStatusLog } from './status.js';
import type { Lane, StatusEntry } from './types.js';

/**
 * A send expects a reply. `lobstah send` to a dispatch records one
 * expectation per dispatch in the helm's state (`helm/.sent/<id>.json`); a
 * newer send replaces it, and `send --no-reply` records none.
 *
 * The first status entry on the dispatch after `sentAt` that the worker
 * reported (`lobstah report`), or any entry with a verb that already wakes
 * the helm, satisfies it. A waking verb needs nothing more: the helm hears
 * it anyway. A `working` or `paused` note is delivered once as a reply.
 * Entries lobstah writes itself (a claim, a delivered message) are not
 * notes and do not satisfy it.
 */
export interface SentExpectation {
  dispatchId: string;
  lane: Lane;
  sentAt: string;
  from: string;
  /** The sent instruction's first line, for context. */
  line: string;
  /** When `man haul` last listed it as a standing item. */
  listedAt?: string;
}

/** Verbs that wake the helm on their own; a send answered by one needs no reply event. */
export const WAKING_VERBS: readonly string[] = ['needs-decision', 'blocked', 'done', 'failed'];

export type ReplyState =
  | { kind: 'awaiting' }
  | { kind: 'reply'; entry: StatusEntry }
  | { kind: 'woke'; entry: StatusEntry };

function sentDir(): string {
  return path.join(lobstahHome(), 'helm', '.sent');
}

function sentPath(id: string): string {
  return path.join(sentDir(), `${id}.json`);
}

function write(e: SentExpectation): void {
  fs.mkdirSync(sentDir(), { recursive: true });
  const file = sentPath(e.dispatchId);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(e, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** The first non-empty line of a message. */
export function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  );
}

/** Record (or replace) the expectation for one dispatch. */
export function expectReply(opts: { dispatchId: string; lane: Lane; from: string; text: string; sentAt?: string }): SentExpectation {
  const e: SentExpectation = {
    dispatchId: opts.dispatchId,
    lane: opts.lane,
    sentAt: opts.sentAt ?? new Date().toISOString(),
    from: opts.from,
    line: firstLine(opts.text),
  };
  write(e);
  return e;
}

export function readExpectation(id: string): SentExpectation | undefined {
  try {
    return JSON.parse(fs.readFileSync(sentPath(id), 'utf8')) as SentExpectation;
  } catch {
    return undefined;
  }
}

export function listExpectations(): SentExpectation[] {
  let files: string[];
  try {
    files = fs.readdirSync(sentDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files.flatMap((f) => {
    const e = readExpectation(f.slice(0, -'.json'.length));
    return e ? [e] : [];
  });
}

export function clearExpectation(id: string): void {
  fs.rmSync(sentPath(id), { force: true });
}

/** Stamp a standing listing, for reminder pacing. */
export function markListed(id: string, at = new Date().toISOString()): void {
  const e = readExpectation(id);
  if (e) write({ ...e, listedAt: at });
}

/** Where an expectation stands against its dispatch's status log. */
export function replyState(e: SentExpectation): ReplyState {
  const sent = Date.parse(e.sentAt) || 0;
  for (const entry of readStatusLog(e.dispatchId, e.lane)) {
    if ((Date.parse(entry.at) || 0) <= sent) continue;
    if (WAKING_VERBS.includes(entry.verb)) return { kind: 'woke', entry };
    if (entry.reported) return { kind: 'reply', entry };
  }
  return { kind: 'awaiting' };
}

/** The pending expectation for a dispatch, when its reply has not come. */
export function awaitingReply(id: string): SentExpectation | undefined {
  const e = readExpectation(id);
  return e && replyState(e).kind === 'awaiting' ? e : undefined;
}

export interface ReplyEvent {
  id: string;
  lane: Lane;
  entry: StatusEntry;
  /** The sent instruction's first line. */
  sent: string;
}

/**
 * Replies ready for the helm. With `consume`, every satisfied expectation
 * is cleared: a reply is delivered once, and one answered by a waking verb
 * is dropped (that verb is its own wake). A dispatch that `match` rejects
 * is left for its own grounds' helm.
 */
export function takeReplies(consume = true, match?: (id: string, lane: Lane) => boolean): ReplyEvent[] {
  const out: ReplyEvent[] = [];
  for (const e of listExpectations()) {
    if (match && !match(e.dispatchId, e.lane)) continue;
    const state = replyState(e);
    if (state.kind === 'awaiting') continue;
    if (state.kind === 'reply') out.push({ id: e.dispatchId, lane: e.lane, entry: state.entry, sent: e.line });
    if (consume) clearExpectation(e.dispatchId);
  }
  return out;
}

/**
 * Unanswered sends due to be listed as standing items: once at first
 * sight, then every `remindMs` while still unanswered (0: once only).
 * With `consume`, each listed one is stamped.
 */
export function dueUnanswered(
  consume: boolean,
  remindMs: number,
  now = Date.now(),
  match?: (id: string, lane: Lane) => boolean,
): SentExpectation[] {
  const out: SentExpectation[] = [];
  for (const e of listExpectations()) {
    if (match && !match(e.dispatchId, e.lane)) continue;
    if (replyState(e).kind !== 'awaiting') continue;
    const listed = e.listedAt ? Date.parse(e.listedAt) || 0 : undefined;
    if (listed !== undefined && (remindMs <= 0 || now - listed <= remindMs)) continue;
    out.push(e);
    if (consume) markListed(e.dispatchId, new Date(now).toISOString());
  }
  return out;
}

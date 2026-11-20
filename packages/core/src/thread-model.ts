/** Portable file metadata: a local path or a wharf file id, never file bytes. */
export interface ThreadAttachment { name: string; path: string; bytes: number; type: string }
type Attachment = ThreadAttachment;

export type ThreadKind = 'untriaged' | 'bait' | 'thread';
export type ThreadOutcomeKind = 'dispatched' | 'planned' | 'answered' | 'dropped';
export interface ThreadOutcome { kind: ThreadOutcomeKind; ref?: string; note: string; at: string }
/** Entries keep the order they happened in; `at` is absent only on entries written before helm messages. */
export type ThreadEntry =
  | { by: 'person'; via: ThreadVia; text: string; attachments: Attachment[]; at?: string }
  | { by: 'helm'; text: string; attachments: Attachment[]; at: string; seq: number }
  | { card: string }
  | { link: ThreadLinkKind; ref: string; text: string; at?: string }
  | { event: 'triaged'; kind: 'bait' | 'thread'; at: string }
  | { event: 'tracked'; text: string; at: string };
export type ThreadLinkKind = 'dispatched' | 'report' | 'planned' | 'pr';
export const THREAD_LINK_KINDS: readonly ThreadLinkKind[] = ['dispatched', 'report', 'planned', 'pr'];
/** Open: still a conversation. Tracking: the helm resolved it, but linked work is still running. */
export type ThreadState = 'open' | 'tracking' | 'resolved';
/** Work a thread waits on while it is tracking, with its live state, read on demand. */
export interface ThreadTrackedItem {
  kind: 'dispatch' | 'card' | 'pr' | 'todo';
  ref: string;
  title: string;
  /** done: finished; stalled: needs someone; open: still running. */
  state: 'open' | 'done' | 'stalled';
  /** The item's own status word, such as working, blocked, merged or overdue. */
  status: string;
  href?: string;
}
export interface ThreadRound { at: string; entries: ThreadEntry[] }
/** Where a person's message came in: the glass, a chat the helm recorded, or Slack through a wharf. */
export type ThreadVia = 'glass' | 'chat' | 'slack';
/**
 * A conversation a person started in Slack, relayed by a wharf this boat
 * mirrors to. `request` is the wharf's id for it; `sources` are the Slack
 * messages already added. `told` is what the wharf last heard: the helm has
 * it, or it waits for one. `sentSeq` is the last helm response sent back.
 */
export interface ThreadRelay { wharf: string; request: string; by: string; sources: string[]; told?: 'queued' | 'delivered'; sentSeq?: number }
export interface HelmThread {
  responseSeq?: number;
  responseAt?: string;
  responseText?: string;
  notice?: { seq: number; at: string; text: string; href: string };
  readers?: Record<string, { seenThrough: number; dismissedThrough: number }>;

  id: string;
  grounds: string;
  kind: ThreadKind;
  title: string;
  text: string;
  attachments: Attachment[];
  about?: string;
  state: ThreadState;
  notes: { decided: string[]; open: string[] };
  notesAt?: string;
  rounds: ThreadRound[];
  createdAt: string;
  updatedAt: string;
  lastPersonAt: string;
  lastHelmAt?: string;
  notifiedAt?: string;
  outcome?: ThreadOutcome;
  relay?: ThreadRelay;
}
/** Polls carry summaries, never the conversation or attachment bytes. */
export interface ThreadSummary {
  responseSeq?: number;
  seenThrough?: number;
  unreadResponse?: boolean;
  responseAt?: string;
  responseText?: string;

  id: string;
  grounds: string;
  kind: ThreadKind;
  title: string;
  state: ThreadState;
  updatedAt: string;
  roundCount: number;
  /** The dispatch a message from its page is about. */
  about?: string;
  openLine?: string;
  cards: string[];
  waitingForHelm: boolean;
  outcome?: ThreadOutcome;
}
export interface ThreadView extends HelmThread {
  seenThrough?: number;
  unreadResponse?: boolean;

  cards: Array<{ key: string; title: string; options: string[]; answer?: { option?: string; text?: string; attachments: Attachment[]; answeredAt: string }; standing: boolean }>;
  /** Linked work and its live state; read-only, present when the store can read it. */
  tracked?: ThreadTrackedItem[];
}

export const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const THREAD_GROUNDS = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
export const THREAD_MESSAGES_MAX = 100;
export const THREAD_TEXT_MAX = 20_000;
export const THREAD_IDLE_MS = 7 * 86400_000;
/** Entries one round may hold, so a helm talking to itself can't grow a thread without bound. */
export const THREAD_ROUND_ENTRIES_MAX = 100;

export class ThreadError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** A thread about a dispatch is named for the dispatch, never its id. */
export function dispatchThreadTitle(brief: string | undefined): string | undefined {
  const line = (brief?.split(/\r?\n/).find((l) => l.trim()) ?? '').trim().replace(/^#{1,6}\s+/, '').trim();
  return line ? line.slice(0, 200) : undefined;
}

export function threadWords(value: unknown, label = 'message', max = THREAD_TEXT_MAX): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ThreadError(`Enter ${label} with at most ${max} characters`);
  return value.replace(/\r\n/g, '\n').trim();
}

/** Pure transition used by the filesystem and wharf stores. */
export function classifyThread(item: HelmThread, kind: unknown, at: string): HelmThread {
  if (item.state !== 'open') throw new ThreadError('Reopen this conversation before changing it', 409);
  if (kind !== 'bait' && kind !== 'thread') throw new ThreadError('Choose bait or thread');
  return { ...appendThreadEntry(item, { event: 'triaged', kind, at }), kind, updatedAt: at, lastHelmAt: at };
}

/** Adds an entry to the current round: a round starts only when the person speaks. */
export function appendThreadEntry(item: HelmThread, entry: ThreadEntry): HelmThread {
  const last = item.rounds.length - 1;
  if ((item.rounds[last]?.entries.length ?? 0) >= THREAD_ROUND_ENTRIES_MAX) throw new ThreadError('This conversation needs a report or plan before more messages', 409);
  return { ...item, rounds: item.rounds.map((round, i) => i === last ? { ...round, entries: [...round.entries, entry] } : round) };
}

/** A helm message is a response: it raises unread for the person and stops the reminder. */
export function sayInThread(item: HelmThread, text: string, attachments: Attachment[], at: string): HelmThread {
  if (item.state === 'resolved') throw new ThreadError('Reopen this conversation before adding to it', 409);
  const seq = (item.responseSeq ?? 0) + 1;
  const said = appendThreadEntry(item, { by: 'helm', text, attachments, at, seq });
  return recordThreadResponse({ ...said, updatedAt: at, lastHelmAt: at }, at, text || attachments.map((file) => file.name).join(', '));
}

/** What the person said in a round, for the helm's wake: never the helm's own words. */
export function personWords(round: ThreadRound | undefined): string {
  return round?.entries.flatMap((entry) => 'by' in entry && entry.by === 'person' ? [entry.text] : []).join(' ') ?? '';
}

export function threadOutcome(value: unknown, note: unknown, at: string): ThreadOutcome {
  const input = threadWords(value, 'an outcome', 1000);
  const split = input.indexOf(':');
  const kind = (split < 0 ? input : input.slice(0, split)) as ThreadOutcomeKind;
  const ref = split < 0 ? undefined : input.slice(split + 1);
  if (!['dispatched', 'planned', 'answered', 'dropped'].includes(kind)) throw new ThreadError('Choose dispatched, planned, answered or dropped');
  if (kind === 'planned' && (!ref || !/^https:\/\//.test(ref))) throw new ThreadError('Include the HTTPS plan link');
  if (kind === 'dispatched' && (!ref || !/^[A-Za-z0-9_-]{1,128}$/.test(ref))) throw new ThreadError('Include the dispatch id');
  if ((kind === 'answered' || kind === 'dropped') && ref) throw new ThreadError('Answered and dropped outcomes take only a note');
  return { kind, ...(ref ? { ref } : {}), note: threadWords(note, 'an outcome note', 1000), at };
}

export interface ThreadSubscriberNotice {
  thread: string;
  person: string;
  seq: number;
  at: string;
  text: string;
  href: string;
}
export const THREAD_PERSON = 'owner';
/** The responses the notes and card verbs record, as Slack replies tell them apart. */
export const THREAD_NOTES_UPDATED = 'Notes updated';
export const THREAD_CARD_READY = 'A card is ready for you';
/** Only an open thread asks for the person: one the helm has resolved never counts as unread. */
export function responseState(item: HelmThread, person = THREAD_PERSON) {
  const responseSeq = item.responseSeq ?? 0, seenThrough = item.readers?.[person]?.seenThrough ?? 0;
  return { responseSeq, seenThrough, unreadResponse: item.state === 'open' && responseSeq > seenThrough, responseAt: item.responseAt, responseText: item.responseText };
}
/**
 * A response and its coalesced subscriber notice commit with the thread. Only
 * what the person reads as a reply records one: the helm's message (sayInThread)
 * and a card. Triage, notes, links and resolving update the thread quietly.
 */
export function recordThreadResponse(item: HelmThread, at: string, text: string): HelmThread {
  const responseSeq = (item.responseSeq ?? 0) + 1;
  return { ...item, responseSeq, responseAt: at, responseText: text, notice: { seq: responseSeq, at, text, href: `#thread/${item.id}` } };
}
export function acknowledgeThreadResponse(item: HelmThread, person: string, through: unknown, dismiss = false): HelmThread {
  if (!Number.isSafeInteger(through) || (through as number) < 0 || (through as number) > (item.responseSeq ?? 0)) throw new ThreadError('Choose a response that has been shown');
  const previous = item.readers?.[person] ?? { seenThrough: 0, dismissedThrough: 0 };
  const next = { ...previous, [dismiss ? 'dismissedThrough' : 'seenThrough']: Math.max(through as number, previous[dismiss ? 'dismissedThrough' : 'seenThrough']) };
  return { ...item, readers: { ...item.readers, [person]: next } };
}
export function pendingThreadNotice(item: HelmThread, person = THREAD_PERSON): ThreadSubscriberNotice | undefined {
  const notice = item.notice, reader = item.readers?.[person];
  return notice && notice.seq > (reader?.seenThrough ?? 0) && notice.seq > (reader?.dismissedThrough ?? 0) ? { ...notice, thread: item.id, person } : undefined;
}

/** Where a resolved thread goes: tracking while any linked work is unfinished. */
export function settledState(tracked: readonly ThreadTrackedItem[]): 'tracking' | 'resolved' {
  return tracked.some((item) => item.state !== 'done') ? 'tracking' : 'resolved';
}
const trackedLabel = (item: ThreadTrackedItem) => `${item.kind === 'pr' ? 'PR' : item.kind === 'card' ? 'Card' : item.kind === 'todo' ? 'Todo' : 'Dispatch'} ${item.title}`;
/**
 * A tracking thread's next state: back to the person when linked work stalls, resolved when all of it is done.
 * Returns undefined while it should keep tracking.
 */
export function trackingTransition(item: HelmThread, tracked: readonly ThreadTrackedItem[], at: string): HelmThread | undefined {
  if (item.state !== 'tracking') return undefined;
  const stalled = tracked.find((t) => t.state === 'stalled');
  if (stalled) {
    const text = `${trackedLabel(stalled)} is ${stalled.status}`;
    return recordThreadResponse({ ...appendThreadEntry(item, { event: 'tracked', text, at }), state: 'open', updatedAt: at, lastHelmAt: at, notifiedAt: undefined }, at, text);
  }
  if (tracked.every((t) => t.state === 'done')) {
    const text = tracked.length === 1 ? `${trackedLabel(tracked[0]!)} finished` : 'All linked work finished';
    return { ...appendThreadEntry(item, { event: 'tracked', text, at }), state: 'resolved', updatedAt: at };
  }
  return undefined;
}

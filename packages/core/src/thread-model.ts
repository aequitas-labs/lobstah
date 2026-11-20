import type { Attachment } from './types.js';

export type ThreadKind = 'untriaged' | 'bait' | 'thread';
export type ThreadOutcomeKind = 'dispatched' | 'planned' | 'answered' | 'dropped';
export interface ThreadOutcome { kind: ThreadOutcomeKind; ref?: string; note: string; at: string }
export type ThreadEntry =
  | { by: 'person'; via: 'glass' | 'chat'; text: string; attachments: Attachment[] }
  | { card: string }
  | { link: 'dispatched' | 'report' | 'planned'; ref: string; text: string };
export interface ThreadRound { at: string; entries: ThreadEntry[] }
export interface HelmThread {
  id: string;
  grounds: string;
  kind: ThreadKind;
  title: string;
  text: string;
  attachments: Attachment[];
  about?: string;
  state: 'open' | 'resolved';
  notes: { decided: string[]; open: string[] };
  rounds: ThreadRound[];
  createdAt: string;
  updatedAt: string;
  lastPersonAt: string;
  lastHelmAt?: string;
  notifiedAt?: string;
  outcome?: ThreadOutcome;
}
/** Polls carry summaries, never the conversation or attachment bytes. */
export interface ThreadSummary {
  id: string;
  grounds: string;
  kind: ThreadKind;
  title: string;
  state: 'open' | 'resolved';
  updatedAt: string;
  roundCount: number;
  openLine?: string;
  cards: string[];
  waitingForHelm: boolean;
  outcome?: ThreadOutcome;
}
export interface ThreadView extends HelmThread {
  cards: Array<{ key: string; title: string; options: string[]; answer?: { option?: string; text?: string; attachments: Attachment[]; answeredAt: string }; standing: boolean }>;
}

export const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const THREAD_GROUNDS = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
export const THREAD_MESSAGES_MAX = 100;
export const THREAD_TEXT_MAX = 20_000;
export const THREAD_IDLE_MS = 7 * 86400_000;

export class ThreadError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function threadWords(value: unknown, label = 'message', max = THREAD_TEXT_MAX): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ThreadError(`Enter ${label} with at most ${max} characters`);
  return value.replace(/\r\n/g, '\n').trim();
}

/** Pure transition used by the filesystem and wharf stores. */
export function classifyThread(item: HelmThread, kind: unknown, at: string): HelmThread {
  if (item.state !== 'open') throw new ThreadError('Reopen this conversation before changing it', 409);
  if (kind !== 'bait' && kind !== 'thread') throw new ThreadError('Choose bait or thread');
  return { ...item, kind, updatedAt: at, lastHelmAt: at };
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

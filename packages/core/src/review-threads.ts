import type { ReviewThread } from './reviews.js';

/** How far a re-review judges the head to answer one of the reviewer's earlier threads. */
export const REVIEW_THREAD_STATUSES = ['addressed', 'partly', 'not'] as const;
export type ReviewThreadStatus = (typeof REVIEW_THREAD_STATUSES)[number];

/** The draft's call on one earlier thread, from verdict.json. */
export interface ReviewThreadCall {
  id: string;
  status: ReviewThreadStatus;
  /** One line: why the head does or does not answer the thread. */
  reason: string;
  /** A short reply for a thread that stays open. */
  reply?: string;
}

/** One of the reviewer's own threads that a draft found fully fixed at its head. */
export interface FixedReviewThread {
  id: string;
  path: string;
  line: number | null;
  url: string;
  reason: string;
}

/** A thread lobstah resolved, or tried to, when a draft found it fixed. */
export interface ReviewThreadResolution extends FixedReviewThread {
  at: string;
  /** Why GitHub did not resolve it; the thread stays open. */
  failed?: string;
}

const oneLine = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/.test(value);

/** Validate the thread calls in verdict.json; drafts without this field make none. */
export function parseReviewThreadCalls(raw: unknown): ReviewThreadCall[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return 'threads must be an array';
  const calls: ReviewThreadCall[] = [];
  const ids = new Set<string>();
  for (const value of raw) {
    if (!value || typeof value !== 'object') return 'each thread needs an id, status, and reason';
    const call = value as Record<string, unknown>;
    if (typeof call.id !== 'string' || !call.id.trim() || ids.has(call.id)) return 'thread ids must be unique';
    if (!REVIEW_THREAD_STATUSES.includes(call.status as ReviewThreadStatus)) return 'thread status must be addressed, partly, or not';
    if (!oneLine(call.reason)) return 'each thread needs a one-line reason';
    if (call.reply !== undefined && (typeof call.reply !== 'string' || call.reply.length > 2000)) return 'a thread reply must be text of at most 2000 characters';
    ids.add(call.id);
    const reply = typeof call.reply === 'string' && call.reply.trim() ? call.reply.trim() : undefined;
    calls.push({ id: call.id, status: call.status as ReviewThreadStatus, reason: call.reason.trim(), ...(reply && call.status !== 'addressed' ? { reply } : {}) });
  }
  return calls;
}

/** Open threads the reviewing identity started. Threads opened by anyone else are never theirs to resolve. */
export function ownReviewThreads(threads: readonly ReviewThread[] | undefined, identity: string | undefined): ReviewThread[] {
  const me = identity?.trim().toLowerCase();
  if (!me) return [];
  return (threads ?? []).filter(thread => thread.comments[0]?.author.toLowerCase() === me);
}

/**
 * The draft's fully addressed calls on the identity's own open threads, as
 * observed when the job started. A call on any other thread is dropped.
 */
export function fixedReviewThreads(round: { openThreads?: ReviewThread[] }, calls: readonly ReviewThreadCall[] | undefined, identity: string | undefined): FixedReviewThread[] {
  const own = new Map(ownReviewThreads(round.openThreads, identity).map(thread => [thread.id, thread]));
  return (calls ?? []).flatMap(call => {
    const thread = call.status === 'addressed' ? own.get(call.id) : undefined;
    return thread ? [{ id: thread.id, path: thread.path, line: thread.line, url: thread.comments[0]!.url, reason: call.reason }] : [];
  });
}

/** Replies on the identity's own threads that stay open, as a review body section. */
export function reviewThreadReplies(round: { openThreads?: ReviewThread[] }, calls: readonly ReviewThreadCall[] | undefined, identity: string | undefined): string {
  const own = new Map(ownReviewThreads(round.openThreads, identity).map(thread => [thread.id, thread]));
  const lines = (calls ?? []).flatMap(call => {
    const thread = call.reply ? own.get(call.id) : undefined;
    return thread ? [`- [${thread.path}${thread.line ? `:${thread.line}` : ''}](${thread.comments[0]!.url}): ${call.reply!.replace(/\s*\n\s*/g, ' ')}`] : [];
  });
  return lines.length ? `**Earlier threads**\n\n${lines.join('\n')}` : '';
}

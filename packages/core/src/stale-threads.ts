import { ageLabel } from './activity.js';
import { readDecisionAnswer } from './decisions.js';
import { postNotice } from './notices.js';
import type { Notice } from './notices.js';
import type { HelmThread } from './thread-model.js';
import { threadTrackedItems } from './thread-tracking.js';
import { listThreads, readThread } from './threads.js';

/** An open conversation with no unfinished work becomes stale after one quiet day. */
export const THREAD_STALE_MS = 24 * 60 * 60 * 1000;

/** The most recent person or helm activity, including answers on the conversation's cards. */
export function threadQuietSince(item: HelmThread): string {
  const answers = item.rounds.flatMap((round) => round.entries.flatMap((entry) => 'card' in entry ? [readDecisionAnswer(entry.card)?.answeredAt] : []));
  return [item.createdAt, item.lastPersonAt, item.lastHelmAt, ...answers].reduce<string>((latest, at) => at && at > latest ? at : latest, item.createdAt);
}

/** Whether this quiet spell is still eligible for a close-out notice. */
function threadIsStale(item: HelmThread, now: number): boolean {
  return item.state === 'open' && now - Date.parse(threadQuietSince(item)) >= THREAD_STALE_MS && threadTrackedItems(item, { now }).every((tracked) => tracked.state === 'done');
}

/** The exact command a helm can use to close a quiet conversation. */
export function staleThreadResolveCommand(id: string): string {
  return `lobstah man resolve ${id} --outcome dropped --note "No new message for 24 hours"`;
}

/** Post once per thread and quiet spell; a new person or helm activity permits another notice. */
export function noticeStaleThreads(grounds?: string, now: number = Date.now()): Notice[] {
  const notices: Notice[] = [];
  for (const item of listThreads(grounds)) {
    if (!threadIsStale(item, now)) continue;
    const quietSince = threadQuietSince(item);
    const notice = postNotice({ kind: 'thread-stale', refId: item.id, grounds: item.grounds, stateHash: quietSince,
      text: `${item.title} · quiet ${ageLabel(now - Date.parse(quietSince))}`,
      dedupeKey: `thread-stale-${item.id}-${quietSince}` });
    if (notice) notices.push(notice);
  }
  return notices;
}

/** A queued stale notice stops applying when the conversation resumes, closes or gains work. */
export function staleThreadNoticeStands(notice: Notice, now: number = Date.now()): boolean {
  const item = notice.refId ? readThread(notice.refId) : undefined;
  return !!item && notice.stateHash === threadQuietSince(item) && threadIsStale(item, now);
}

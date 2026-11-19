import type { GlassReview, ReviewThreadToResolve } from '@lobstah/core';
import { useEffect, useState } from 'preact/hooks';
import { can } from '../backend.js';
import { reviewRequest } from '../actions.js';
import { html } from '../html.js';

/** One thread the draft resolves on publish. Unticking keeps it open; a save in flight holds the post action. */
function ThreadChoice({
  review,
  thread,
  onPending,
}: {
  review: GlassReview;
  thread: ReviewThreadToResolve;
  onPending: (id: string, pending: boolean) => void;
}) {
  const [resolve, setResolve] = useState(thread.resolve);
  const [error, setError] = useState<string>();
  const editable = can('review-request') && review.state === 'drafted' && review.headSha === review.prHeadSha;
  useEffect(() => setResolve(thread.resolve), [thread.resolve]);
  const choose = async (next: boolean) => {
    setResolve(next);
    setError(undefined);
    onPending(thread.id, true);
    let why: string | undefined;
    try {
      why = await reviewRequest('review-thread-resolve', {
        key: review.key,
        roundId: review.roundId,
        headSha: review.headSha,
        draftedAt: review.draftedAt,
        threadId: thread.id,
        resolve: next,
      });
    } catch {
      why = 'Your choice could not be saved. Try again.';
    }
    if (why) {
      setResolve(!next);
      setError(why);
    }
    onPending(thread.id, false);
  };
  return html`<p data-review-thread=${thread.id}><label><input type="checkbox" checked=${resolve} disabled=${!editable} onChange=${(event: Event) => void choose((event.currentTarget as HTMLInputElement).checked)} />
    <a href=${thread.url} target="_blank" rel="noopener"><code>${thread.path}${thread.line ? `:${thread.line}` : ''}</code></a><br /><span class="dim">${thread.reason}</span></label>
    ${error && html`<br /><span class="bad" role="alert">${error}</span>`}</p>`;
}

/** Your earlier threads that the draft found fixed. Ticked ones are resolved when you publish. */
export function ReviewThreads({ review, onSaving }: { review: GlassReview; onSaving: (saving: boolean) => void }) {
  const [pending, setPending] = useState<Record<string, boolean>>({});
  useEffect(() => onSaving(Object.values(pending).some(Boolean)), [pending]);
  if (!review.threadsToResolve?.length || review.state !== 'drafted') return null;
  return html`<section class="pr-findings" aria-label="Threads to resolve"><h4>Threads to resolve <span class="dim">resolved when you publish</span></h4>
    ${review.threadsToResolve.map((thread) => html`<${ThreadChoice} key=${thread.id} review=${review} thread=${thread} onPending=${(id: string, saving: boolean) => setPending((current) => ({ ...current, [id]: saving }))} />`)}
  </section>`;
}

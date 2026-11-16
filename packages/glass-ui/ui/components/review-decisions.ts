import type { GlassReview, ReviewDecision, ReviewDecisionAnswer } from '@lobstah/core';
import { useEffect, useRef, useState } from 'preact/hooks';
import { can } from '../backend.js';
import { reviewRequest } from '../actions.js';
import { html } from '../html.js';
import { Button } from './button.js';

/** One saved call. Debounced text writes stay ordered, including edits made during a save. */
function DecisionAnswer({
  review,
  decision,
  onPending,
}: {
  review: GlassReview;
  decision: ReviewDecision;
  onPending: (id: string, pending: boolean) => void;
}) {
  const saved = review.decisionAnswers?.[decision.id];
  const [answer, setAnswer] = useState<ReviewDecisionAnswer | null>(saved ?? null);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const version = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const pendingWrite = useRef<() => void>();
  const mounted = useRef(true);
  const writes = useRef(Promise.resolve());
  const editable = can('review-request') && review.state === 'drafted' && review.headSha === review.prHeadSha;
  useEffect(() => {
    if (!pending.current) setAnswer(saved ?? null);
  }, [JSON.stringify(saved)]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      mounted.current = false;
      pendingWrite.current?.();
      onPending(decision.id, false);
    },
    [],
  );
  const save = (next: ReviewDecisionAnswer | null, delay = 0) => {
    setAnswer(next);
    setError(undefined);
    setSaving(true);
    pending.current = true;
    onPending(decision.id, true);
    const generation = ++version.current;
    clearTimeout(timer.current);
    const write = () => {
      pendingWrite.current = undefined;
      writes.current = writes.current.then(async () => {
        if (generation !== version.current) return;
        let why: string | undefined;
        try {
          why = await reviewRequest('review-decision-answer', {
            key: review.key,
            roundId: review.roundId,
            headSha: review.headSha,
            draftedAt: review.draftedAt,
            decisionId: decision.id,
            answer: next && 'text' in next && !next.text?.trim() ? null : next,
          });
        } catch {
          why = 'Your answer could not be saved. Try again.';
        }
        if (generation !== version.current || !mounted.current) return;
        setSaving(false);
        setError(why);
        if (!why) {
          pending.current = false;
          onPending(decision.id, false);
        }
      });
    };
    pendingWrite.current = write;
    if (delay) timer.current = setTimeout(write, delay);
    else write();
  };
  return html`<fieldset class="pr-findings" data-review-decision=${decision.id} disabled=${!editable} aria-busy=${saving}>
    <legend>${decision.question}</legend>
    ${decision.options.map((option) => html`<p key=${option.id}><label><input type="radio" name=${'review-decision-' + decision.id} checked=${answer?.optionId === option.id} onChange=${() => save({ optionId: option.id })} /> <b>${option.label}</b>${decision.recommendation === option.id && html` <span class="badge">Recommended</span>`}<br /><span class="dim">${option.consequence}</span></label></p>`)}
    <textarea class="danswer" placeholder="Write your own answer" aria-label="Write your own answer" rows="2" maxlength="8000" value=${answer?.text ?? ''} onInput=${(event: Event) => save({ text: (event.currentTarget as HTMLTextAreaElement).value }, 350)} onBlur=${() => {
      clearTimeout(timer.current);
      pendingWrite.current?.();
    }} />
    ${error && html`<div role="alert"><span class="bad">${error}</span> <${Button} onClick=${() => save(answer)}>Retry save<//></div>`}
  </fieldset>`;
}

/** Chris's calls sit above findings; any unsaved edit keeps the post action disabled. */
export function ReviewDecisions({ review, onSaving }: { review: GlassReview; onSaving: (saving: boolean) => void }) {
  const [pending, setPending] = useState<Record<string, boolean>>({});
  useEffect(() => onSaving(Object.values(pending).some(Boolean)), [pending]);
  if (!review.decisions?.length) return null;
  return html`<section aria-label="Decisions from Chris"><h4>${review.state === 'posted' ? 'Decisions from Chris' : 'Your calls'}</h4>
    ${review.decisions.map((decision) => html`<${DecisionAnswer} key=${decision.id} review=${review} decision=${decision} onPending=${(id: string, saving: boolean) => setPending((current) => ({ ...current, [id]: saving }))} />`)}
  </section>`;
}

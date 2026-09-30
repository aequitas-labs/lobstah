import { listDecisions, readDecisionAnswer, readDecisionDetail, standingDecisions } from '@lobstah/core';
import type { DecisionAnsweredEvent, DecisionMeta, GlassDecision, TendAttention } from '@lobstah/core';

/**
 * The CLI half of decisions (core's decisions.ts stores them): the
 * `decision` attention items, the rule that a framed decision hides the raw
 * question it frames, the glass rows, and the `decision-answered` event
 * text `man wait` prints.
 */

/** One `decision` attention item per standing decision: it stands until answered or withdrawn. */
export function decisionAttention(now: number, decisions: DecisionMeta[] = standingDecisions()): TendAttention[] {
  return decisions.map((d) => ({
    kind: 'decision',
    key: d.key,
    stateHash: d.stateHash,
    id: d.dispatch ?? d.key,
    lane: d.lane ?? 'work',
    verb: 'decision',
    ageSecs: Math.max(0, Math.round((now - Date.parse(d.askedAt)) / 1000)),
    at: d.askedAt,
    standingSince: d.askedAt,
    note: d.title,
    ...(d.repo ? { repo: d.repo } : {}),
  }));
}

/**
 * A raw `question` is hidden while a decision frames it: a decision on the
 * same dispatch, asked at or after the question, that has not been
 * withdrawn. An answered one keeps hiding it until the worker reports
 * again or the helm sends the answer on.
 */
export function hideFramedQuestions(attention: TendAttention[], decisions: DecisionMeta[] = listDecisions()): TendAttention[] {
  return attention.filter(
    (a) =>
      a.kind !== 'question' ||
      !decisions.some((d) => d.dispatch === a.id && (d.lane ?? 'work') === a.lane && d.askedAt >= (a.at ?? '')),
  );
}

/** Standing decisions as the glass renders them, newest first. */
export function glassDecisions(decisions: DecisionMeta[] = standingDecisions()): GlassDecision[] {
  return decisions.map((d) => ({
    key: d.key,
    title: d.title,
    detail: readDecisionDetail(d.key) ?? '',
    options: d.options,
    attachments: d.attachments,
    ...(d.dispatch ? { dispatch: d.dispatch } : {}),
    ...(d.lane ? { lane: d.lane } : {}),
    ...(d.repo ? { repo: d.repo } : {}),
    askedBy: d.askedBy,
    askedAt: d.askedAt,
    stateHash: d.stateHash,
  }));
}

/** The fields of one `decision-answered` event, in print order. */
export function decisionEventFields(e: DecisionAnsweredEvent): Record<string, string> {
  return {
    event: 'decision-answered',
    key: e.decision.key,
    ...(e.decision.dispatch ? { dispatch: e.decision.dispatch } : {}),
    title: e.decision.title,
    option: e.answer.option ?? '',
    text: e.answer.text ?? '',
    attachments: e.answer.attachments.map((a) => a.path).join(', '),
    at: e.answer.answeredAt,
  };
}

/** A `man haul` line for an answered decision. */
export function decisionLine(e: DecisionAnsweredEvent): string {
  const what = [e.answer.option && `option "${e.answer.option}"`, e.answer.text && `text: ${e.answer.text}`, e.answer.attachments.length > 0 && `files: ${e.answer.attachments.map((a) => a.path).join(', ')}`]
    .filter(Boolean)
    .join(' · ');
  return `- decision-answered ${e.decision.key}${e.decision.dispatch ? ` (${e.decision.dispatch})` : ''} — ${e.decision.title} · ${what}`;
}

/** Whether a standing answer was already recorded, for callers that report it. */
export const isAnswered = (key: string): boolean => readDecisionAnswer(key) !== undefined;

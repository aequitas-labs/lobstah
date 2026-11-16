/** One product or ownership choice the reviewer can make. */
export interface ReviewDecisionOption {
  id: string;
  label: string;
  consequence: string;
}

/** A call for Chris, separate from code findings. IDs stay stable across drafts. */
export interface ReviewDecision {
  id: string;
  question: string;
  options: ReviewDecisionOption[];
  /** The recommended option's id. Free text is always available too. */
  recommendation: string;
}

/** Chris either chooses an option or writes an answer in Chris's own words. */
export type ReviewDecisionAnswer = { optionId: string; text?: never } | { text: string; optionId?: never };
export type ReviewDecisionAnswers = Record<string, ReviewDecisionAnswer>;

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
const oneLine = (value: unknown): value is string => nonempty(value) && !/[\r\n]/.test(value);

/** Validate the decisions in verdict.json; old drafts without this field have none. */
export function parseReviewDecisions(raw: unknown): ReviewDecision[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return 'decisions must be an array';
  const decisions: ReviewDecision[] = [];
  const ids = new Set<string>();
  for (const value of raw) {
    if (!value || typeof value !== 'object') return 'each decision needs an id, question, options, and recommendation';
    const decision = value as Record<string, unknown>;
    if (!identifier(decision.id) || ids.has(decision.id)) return 'decision ids must be unique identifiers';
    if (!oneLine(decision.question)) return 'each decision needs a one-line question';
    if (!Array.isArray(decision.options) || decision.options.length < 2) return 'each decision needs at least two options';
    const options: ReviewDecisionOption[] = [];
    const optionIds = new Set<string>();
    for (const value of decision.options) {
      if (!value || typeof value !== 'object') return 'each option needs an id, label, and consequence';
      const option = value as Record<string, unknown>;
      if (!identifier(option.id) || optionIds.has(option.id) || !oneLine(option.label) || !oneLine(option.consequence))
        return 'options need unique ids, one-line labels, and one-line consequences';
      optionIds.add(option.id);
      options.push({ id: option.id, label: option.label.trim(), consequence: option.consequence.trim() });
    }
    if (typeof decision.recommendation !== 'string' || !optionIds.has(decision.recommendation)) return 'the recommendation must name an option id';
    ids.add(decision.id);
    decisions.push({ id: decision.id, question: decision.question.trim(), options, recommendation: decision.recommendation });
  }
  return decisions;
}

/** Validate an answer against the current options; recommendations never count as answers. */
export function isReviewDecisionAnswer(decision: ReviewDecision, answer: unknown): answer is ReviewDecisionAnswer {
  if (!answer || typeof answer !== 'object') return false;
  const value = answer as Record<string, unknown>;
  return (value.text === undefined && typeof value.optionId === 'string' && decision.options.some(option => option.id === value.optionId)) ||
    (value.optionId === undefined && nonempty(value.text) && value.text.length <= 8000);
}

/** Keep answers only for surviving question ids and valid options on a redraft. */
export function carryReviewDecisionAnswers(decisions: ReviewDecision[], answers: ReviewDecisionAnswers = {}): ReviewDecisionAnswers {
  return Object.fromEntries(decisions.filter(decision => isReviewDecisionAnswer(decision, answers[decision.id])).map(decision => [decision.id, answers[decision.id]!]));
}

/** The unanswered calls that prevent this draft from being posted. */
export function unansweredReviewDecisions(round: { decisions?: ReviewDecision[]; decisionAnswers?: ReviewDecisionAnswers }): ReviewDecision[] {
  return (round.decisions ?? []).filter(decision => !isReviewDecisionAnswer(decision, round.decisionAnswers?.[decision.id]));
}

/** Format the saved calls for the author, alongside the review's findings. */
export function reviewDecisionBody(decisions: ReviewDecision[], answers: ReviewDecisionAnswers = {}): string {
  if (!decisions.length) return '';
  return '## Decisions from Chris\n\n' + decisions.map(decision => {
    const answer = answers[decision.id];
    const option = answer && 'optionId' in answer ? decision.options.find(option => option.id === answer.optionId) : undefined;
    const text = option ? `${option.label} — ${option.consequence}` : answer?.text ?? '';
    return `### ${decision.question}\n\n${text.trim()}`;
  }).join('\n\n');
}

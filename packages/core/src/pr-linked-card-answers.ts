import { DecisionError, answerDecision, standingDecisions, type AnswerSource, type DecisionAnswer, type DecisionMeta } from './decisions.js';
import { cardLinksPr, mergeWhenGreenAnswerText, type MergeWhenGreenOrigin, type MergeWhenGreenSet } from './pr-linked-cards.js';

/** The answer source each origin answers as: a glass answer stays a glass answer. */
const ORIGIN_SOURCE: Record<MergeWhenGreenOrigin, AnswerSource> = { glass: 'glass', wharf: 'wharf', cli: 'cli', github: 'github' };

/** The open cards linked to this PR: standing (unanswered, not withdrawn), newest first. */
export function openPrLinkedCards(prKey: string, cards: readonly DecisionMeta[] = standingDecisions()): DecisionMeta[] {
  return cards.filter((card) => cardLinksPr(card, prKey));
}

/**
 * Merge when green was set on this PR without its card: answer every open
 * card linked to it, so none is left standing. Each answer names where, by
 * whom and when, and writes the `decision-answer` request that wakes the
 * helm, as a person's answer does. A card answered first elsewhere is
 * skipped. Returns the answers written.
 */
export function answerPrLinkedCards(prKey: string, set: MergeWhenGreenSet, cards?: readonly DecisionMeta[]): DecisionAnswer[] {
  const answers: DecisionAnswer[] = [];
  for (const card of openPrLinkedCards(prKey, cards)) {
    try {
      // The answer carries no files, so no attachment limit applies.
      answers.push(answerDecision({ key: card.key, text: mergeWhenGreenAnswerText(set), by: ORIGIN_SOURCE[set.from], maxBytes: 0 }));
    } catch (err) {
      // Answered or withdrawn between the read and the write: nothing is left to close.
      if (err instanceof DecisionError && (err.status === 409 || err.status === 404)) continue;
      throw err;
    }
  }
  return answers;
}

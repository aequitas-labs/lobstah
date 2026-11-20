/**
 * A decision card asked with `man ask --pr pr:<owner>/<repo>#N` is linked to
 * that PR. While such a card is open, the PR card defers its own Merge when
 * green to it; when merge when green is set on the PR some other way, lobstah
 * answers the card for the person. This module holds the parts both the boat
 * and the glass page need, and imports nothing from node, so the page can
 * bundle it.
 */
import type { DecisionReference } from './backend-model.js';

/**
 * Where merge when green was set on a PR without answering its card: the
 * local glass's PR card, the hosted glass's PR card, the helm's
 * `lobstah pr merge-when-green`, or GitHub's own auto-merge, which the PR
 * watch observes.
 */
export type MergeWhenGreenOrigin = 'glass' | 'wharf' | 'cli' | 'github';

/** Merge when green, set on a PR: where, by whom, and when. */
export interface MergeWhenGreenSet {
  from: MergeWhenGreenOrigin;
  /**
   * Who set it, where that is known: the helm's authorization (`chat` or
   * `decision:<key>`) for the CLI, the GitHub login for auto-merge. A glass
   * PR card is the person reading it.
   */
  who?: string;
  /** When it was set, ISO 8601. */
  at: string;
}

/** The fields of a stored or glass decision card that decide whether it is linked to a PR. */
export interface PrLinkableCard {
  references?: readonly DecisionReference[];
  /** Permission and run cards ask something else; they never stand for a merge decision. */
  permission?: unknown;
  permissionsProposal?: unknown;
  run?: unknown;
}

/** The PR keys a card was asked about with `--pr`, in the order given. Each is the PR named, never its stack. */
export function linkedPrKeys(card: PrLinkableCard): string[] {
  if (card.permission || card.permissionsProposal || card.run) return [];
  return (card.references ?? []).filter((reference) => reference.kind === 'pr').map((reference) => reference.key);
}

/** Whether a card was asked with `--pr` naming this PR (`pr:<owner>/<repo>#N`). */
export function cardLinksPr(card: PrLinkableCard, prKey: string): boolean {
  return linkedPrKeys(card).includes(prKey);
}

/** Where each origin is, in the answer's words. */
const ORIGIN_PLACE: Record<MergeWhenGreenOrigin, string> = {
  glass: 'the PR card in the glass',
  wharf: 'the PR card in the hosted glass',
  cli: '`lobstah pr merge-when-green`',
  github: 'GitHub auto-merge',
};

/** Who set it, in the answer's words. */
function setter(set: MergeWhenGreenSet): string {
  if (set.from === 'glass' || set.from === 'wharf') return 'you';
  if (set.from === 'cli') return set.who ? `the helm (authorized by ${set.who})` : 'the helm';
  return set.who ? `@${set.who}` : 'someone on GitHub';
}

/**
 * The text lobstah answers a linked card with, naming where, by whom and when:
 * "Merge when green, set from GitHub auto-merge by @dana at 2026-11-20T18:30:00Z."
 */
export function mergeWhenGreenAnswerText(set: MergeWhenGreenSet): string {
  return `Merge when green, set from ${ORIGIN_PLACE[set.from]} by ${setter(set)} at ${set.at}.`;
}

import type { PrRecord } from './prs.js';

/** How a PR merges on GitHub. A repo sets its own with `[repos.<key>].mergeMethod`. */
export type PrMergeMethod = 'merge' | 'squash' | 'rebase';
export const PR_MERGE_METHODS: readonly PrMergeMethod[] = ['merge', 'squash', 'rebase'];

/**
 * "Merge when green", as the glass asked for it on one PR. It stands until
 * the PR merges, closes, or the person cancels it.
 */
export interface PrMergeRequest {
  /** When it was asked for. */
  at: string;
  /** Who asked: `glass`, or a hosted glass's relay. */
  by: string;
  /** The method it merges with, fixed when asked (the repo's, at that time). */
  method: PrMergeMethod;
  /** The repair dispatch lobstah filed for a PR no dispatch owned, and the head it was filed for. */
  repair?: { dispatchId: string; headSha: string };
  /** A head the helm was told is stuck: told once per head. */
  stuckHeadSha?: string;
}

/**
 * "Merge stack when green", as the glass asked for it on a stack of several
 * PRs. It lives on the stack's bottom PR record (the stack's id is that PR's
 * key) and stands until every PR in the stack has merged, one closes
 * unmerged, GitHub refuses the merge, or the person cancels it before GitHub
 * has taken the merge. The boat links a plain branch stack on GitHub first,
 * then asks GitHub to merge the top PR with everything under it
 * (`merge-async`), once every open PR in it is green.
 */
export interface StackMergeRequest {
  /** When it was asked for. */
  at: string;
  /** Who asked: `glass`, or a hosted glass's relay. */
  by: string;
  /** The method it merges with, fixed when asked (the repo's, at that time). */
  method: PrMergeMethod;
  /** The stack's PR numbers when it was asked, bottom first. */
  numbers: number[];
  /** GitHub's stack number, once it is linked (the boat links a plain stack itself). */
  linked?: number;
  /** The merge GitHub accepted for the top PR: its id, the top's head, and when. It can't be called back. */
  merging?: { id: string; number: number; headSha: string; at: string };
  /** Repairs filed for a member no dispatch owns, by PR number: the head each was filed for. */
  repairs?: Record<string, string>;
  /** The last reason the helm was told the stack is stuck: told once per reason. */
  stuck?: string;
}

/** What a standing stack merge needs on this observation of its PRs. */
export type StackMergeStep =
  | { kind: 'merge' }
  | { kind: 'repair'; pr: PrRecord; why: 'checks' | 'conflict' }
  | { kind: 'stuck'; why: string }
  | { kind: 'wait'; why: string }
  | { kind: 'done' }
  | { kind: 'closed'; number: number };

/**
 * The step a merge-requested stack needs, from its members' records, bottom
 * first. Every open PR must be green on its own: a draft, running checks or
 * GitHub's own hold waits; a red check or a conflict asks for a repair first.
 */
export function stackMergeStep(members: readonly PrRecord[]): StackMergeStep {
  const closed = members.find((p) => p.state === 'CLOSED');
  if (closed) return { kind: 'closed', number: closed.number };
  const open = members.filter((p) => p.state === 'OPEN');
  if (!open.length) return { kind: 'done' };
  for (const pr of open) {
    const step = prMergeStep(pr, false);
    if (step.kind === 'stuck') return { kind: 'stuck', why: `#${pr.number}: ${step.why}` };
    if (step.kind === 'repair') return { kind: 'repair', pr, why: step.why };
    if (step.kind === 'wait') return { kind: 'wait', why: `#${pr.number} is ${step.why}` };
  }
  return { kind: 'merge' };
}

/** What a standing merge request needs on this observation of its PR. */
export type PrMergeStep =
  | { kind: 'merge' }
  | { kind: 'repair'; why: 'checks' | 'conflict' }
  | { kind: 'stuck'; why: string }
  | { kind: 'wait'; why: string }
  | { kind: 'done' };

/**
 * The step a merge-requested PR needs, from its record alone. `belowOpen` is
 * true while an open PR sits under this one in its stack (its base is that
 * PR's branch): a stack merges from the bottom.
 */
export function prMergeStep(pr: PrRecord, belowOpen: boolean): PrMergeStep {
  if (pr.state !== 'OPEN') return { kind: 'done' };
  if (pr.repair && (pr.repair.status === 'gave-up' || pr.repair.status === 'blocked') && pr.repair.headSha === pr.headSha) {
    return { kind: 'stuck', why: pr.repair.reason ?? `repair ${pr.repair.status}` };
  }
  if (pr.mergeStateStatus === 'DIRTY') return { kind: 'repair', why: 'conflict' };
  if ((pr.checks?.failed ?? 0) > 0) return { kind: 'repair', why: 'checks' };
  if (pr.draft) return { kind: 'wait', why: 'a draft' };
  if ((pr.checks?.pending ?? 0) > 0) return { kind: 'wait', why: 'checks running' };
  if (belowOpen) return { kind: 'wait', why: 'a PR below it in its stack merges first' };
  if (pr.mergeStateStatus !== 'CLEAN') return { kind: 'wait', why: `GitHub says ${pr.mergeStateStatus.toLowerCase().replace(/_/g, ' ')}` };
  return { kind: 'merge' };
}

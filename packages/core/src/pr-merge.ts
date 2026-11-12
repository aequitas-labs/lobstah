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

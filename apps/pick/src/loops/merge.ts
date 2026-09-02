import { randomUUID } from 'node:crypto';
import { enqueue, laneDirs, readStatusLog } from '@lobstah/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MergePolicy, MergeSource, PrCandidate } from '../types.js';
import type { PickupState } from '../state.js';
import { recordMergeView } from '../merge-view.js';
import type { MergeViewPr } from '../merge-view.js';

/**
 * Who qualifies is monotone by construction: `approvers` is the floor on
 * every PR; assignees join it when assigneeApproves is on and no restricted
 * label is present. A restricted label collapses the set to the floor —
 * labels revoke the assignee relaxation, they never grant or replace.
 */
export function qualifyingSet(policy: MergePolicy, pr: PrCandidate): string[] {
  const restricted = pr.labels.some((l) => policy.restrictedLabels.includes(l));
  if (restricted || !policy.assigneeApproves) return [...policy.approvers];
  return [...new Set([...policy.approvers, ...pr.assignees])];
}

/**
 * The qualifying approval: an APPROVED review on the current head, from a
 * member of the qualifying set, with no other reviewer's latest review at
 * CHANGES_REQUESTED. Dedup-by-approval happens at the caller.
 */
export function qualifiedApproval(policy: MergePolicy, pr: PrCandidate): PrCandidate['reviews'][number] | undefined {
  const outstanding = pr.reviews.some((r) => r.state === 'CHANGES_REQUESTED');
  if (outstanding) return undefined;
  const set = qualifyingSet(policy, pr);
  return pr.reviews.find((r) => r.state === 'APPROVED' && r.sha === pr.headSha && set.includes(r.author));
}

export function approvalDedupKey(pr: PrCandidate, review: { id: number }): string {
  return `${pr.number}#${review.id}@${pr.headSha}`;
}

function rebaseBrief(pr: PrCandidate): string {
  return [
    `Rebase the branch ${pr.headRef} of ${pr.url} onto its base branch, resolving any conflicts`,
    `in a way that preserves the intent of both sides. Then push the rebased branch with`,
    `\`git push --force-with-lease\`. Do not merge the PR. Do not change anything beyond conflict`,
    `resolution. When pushed, report status done.`,
  ].join(' ');
}

function choreVerdict(uuid: string): 'active' | 'done' | 'failed' {
  const d = laneDirs('chore');
  if (fs.existsSync(path.join(d.active, uuid)) || fs.existsSync(path.join(d.queue, `${uuid}.json`))) return 'active';
  const last = readStatusLog(uuid, 'chore').at(-1)?.verb;
  return last === 'done' ? 'done' : 'failed';
}

/**
 * Deterministic until the moment resolution requires judgment — then it
 * becomes a chore-lane dispatch, bounded at one attempt.
 */
export async function mergeLoop(
  ms: MergeSource,
  policy: MergePolicy,
  state: PickupState,
  log: (m: string) => void = () => {},
): Promise<void> {
  if (!policy.enabled) return;
  // Persist what this tick observed so status views report PR state from
  // disk instead of making their own forge calls. A PR merged or closed this
  // tick is left out of `open`; the next recordMergeView notices it left the
  // set and looks up its disposition.
  const observed: MergeViewPr[] = [];
  const observe = (pr: PrCandidate, gate: string): void => {
    const m = /^lobstah\/([0-9a-f-]{36})$/.exec(pr.headRef);
    observed.push({
      number: pr.number,
      url: pr.url,
      headRef: pr.headRef,
      headSha: pr.headSha,
      mergeableState: pr.mergeableState,
      gate,
      uuid: m?.[1],
    });
  };

  for (const candidate of await ms.mergeCandidates()) {
    const prKey = `${ms.name}#${candidate.number}`;

    // A rebase chore in flight owns this PR until it completes.
    const rebase = state.rebase(prKey);
    if (rebase) {
      if (rebase.failed) {
        observe(candidate, 'rebase-failed');
        continue;
      }
      const verdict = choreVerdict(rebase.uuid);
      if (verdict === 'active') {
        observe(candidate, `conflict-chore:${rebase.uuid}`);
        continue;
      }
      if (verdict === 'failed') {
        await ms.comment(candidate.number, `Automated rebase failed (dispatch ${rebase.uuid}) — needs a human.`);
        await ms.addLabel(candidate.number, 'needs-human');
        state.failRebase(prKey);
        log(`${prKey}: rebase chore failed, flagged for a human`);
        observe(candidate, 'rebase-failed');
        continue;
      }
      state.clearRebase(prKey); // done → the push invalidated approvals; gate re-enters below
    }

    const provisional = qualifiedApproval(policy, candidate);
    if (!provisional || state.approvalConsumed(approvalDedupKey(candidate, provisional))) {
      observe(candidate, 'waiting-approval');
      continue;
    }

    // Re-validate at the moment of merge, never on the poll tick's view.
    const pr = await ms.refresh(candidate.number);
    if (!pr) continue; // left the open set mid-tick; disposition records it next tick
    const approval = qualifiedApproval(policy, pr);
    if (!approval) {
      log(`${prKey}: gate no longer holds on fresh fetch — skipping`);
      observe(pr, 'waiting-approval');
      continue;
    }
    const dedupKey = approvalDedupKey(pr, approval);
    if (state.approvalConsumed(dedupKey)) {
      observe(pr, 'waiting-approval');
      continue;
    }

    // Trust the forge's rollup: blocked means a required check failed;
    // unstable means only non-required checks failed and the forge itself
    // would allow the merge.
    switch (pr.mergeableState) {
      case 'blocked':
      case 'draft':
        log(`${prKey}: ${pr.mergeableState} — not merging`);
        observe(pr, pr.mergeableState);
        break;
      case 'behind':
        await ms.updateBranch(pr.number);
        log(`${prKey}: behind base, updated branch — gate re-enters next tick`);
        observe(pr, 'behind-updated');
        break;
      case 'dirty': {
        const uuid = randomUUID();
        enqueue({ id: uuid, repo: ms.repoKey(), brief: rebaseBrief(pr) }, 'chore');
        state.setRebase(prKey, uuid);
        log(`${prKey}: real conflict — wrote rebase chore ${uuid}`);
        observe(pr, `conflict-chore:${uuid}`);
        break;
      }
      default: {
        await ms.merge(pr.number, policy.method);
        state.consumeApproval(dedupKey);
        log(`${prKey}: merged (${policy.method}) on approval by ${approval.author}`);
      }
    }
  }

  await recordMergeView(ms.forgeRepo(), observed, (n) => ms.disposition(n));
}

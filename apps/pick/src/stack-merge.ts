import { stackAttemptReady, stackAttemptFailed, hasStackRetryPolicy } from './stack-retry.js';
import { postNotice } from '@lobstah/core';
import type { MergePolicy, MergeSource, PrCandidate } from './types.js';
import type { PickupState } from './state.js';

/** Review identity and dedup key after the existing merge policy qualifies it. */
export interface StackApproval {
  key: string;
  author: string;
}
/** One tick's stack boundaries and durable successor transitions. */
export interface StackMergeContext {
  handled: Set<number>;
  members: Set<number>;
  children: Map<number, PrCandidate>;
}

/** Native membership and branch ancestry have separate merge paths; neither rewrites a local branch. */
export async function prepareStackMerges(
  source: MergeSource,
  candidates: readonly PrCandidate[],
  policy: MergePolicy,
  state: PickupState,
  approve: (pr: PrCandidate) => StackApproval | undefined,
  observe: (pr: PrCandidate, gate: string) => void,
  log: (message: string) => void,
): Promise<StackMergeContext> {
  const context: StackMergeContext = { handled: new Set(), members: new Set(), children: new Map() };
  const keyOf = (pr: PrCandidate): string => `${source.name}#${pr.number}`;
  const hold = (pr: PrCandidate, gate: string, message: string, stopped = false): void => {
    context.handled.add(pr.number);
    observe(pr, gate);
    if (stopped && state.newStackHold(keyOf(pr), `${pr.headSha}:${message}`)) {
      log(message);
      postNotice({ kind: 'stack-stopped', repo: source.repoKey(), url: pr.url, text: message });
    }
  };

  for (const [key, pending] of state.stackMergeEntries(source.name)) {
    pending.members.forEach((number) => context.handled.add(number));
    const retryKey = `${key}:result`;
    if (!stackAttemptReady(state, retryKey, log)) continue;
    try {
      if (state.stackRetry(retryKey)) {
        const dispositions = await Promise.all(pending.members.map((member) => source.disposition(member)));
        if (dispositions.every((status) => status === 'merged')) {
          state.clearStackMerge(key);
          state.clearStackRetry(retryKey);
          log(`Stack through #${pending.number} merged before the retry.`);
          continue;
        }
      }
      const result =
        !pending.enqueued && pending.uuid && source.linkedResult ? await source.linkedResult(pending.number, pending.uuid) : undefined;
      if (result?.status === 'failed') {
        const message = `Stack merge stopped at #${pending.number}: ${result.details.message ?? 'GitHub refused the merge.'}`;
        if (state.newStackHold(key, message)) {
          log(message);
          postNotice({ kind: 'stack-stopped', repo: source.repoKey(), text: message });
        }
        state.clearStackMerge(key);
      } else {
        if (result?.status === 'enqueued' && !pending.enqueued) state.setStackMerge(key, { ...pending, enqueued: true });
        const queued = pending.enqueued || result?.status === 'enqueued';
        if (queued) {
          const open = candidates.filter((pr) => pending.members.includes(pr.number));
          const checks = await Promise.all(open.map((pr) => source.checks?.(pr.number, pr.headSha) ?? 'pending'));
          if (open.some((pr) => pr.mergeableState === 'dirty') || checks.includes('red')) {
            const message = `Queued stack through #${pending.number} stopped on a conflict or failing check.`;
            if (state.newStackHold(key, message)) {
              log(message);
              postNotice({ kind: 'stack-stopped', repo: source.repoKey(), text: message });
            }
          }
        }
        const dispositions = await Promise.all(pending.members.map((number) => source.disposition(number)));
        if (dispositions.every((status) => status === 'merged')) {
          pending.approvals?.forEach((approval) => state.consumeApproval(approval));
          state.clearStackMerge(key);
          log(`Stack through #${pending.number} merged into the default branch.`);
        } else if (dispositions.includes('closed')) {
          const message = `Stack merge stopped: a PR through #${pending.number} closed without merging.`;
          if (state.newStackHold(key, message)) {
            log(message);
            postNotice({ kind: 'stack-stopped', repo: source.repoKey(), text: message });
          }
          state.clearStackMerge(key);
        }
      }
      state.clearStackRetry(retryKey);
      candidates.filter((pr) => pending.members.includes(pr.number)).forEach((pr) => observe(pr, 'stack-merge-pending'));
    } catch (error) {
      stackAttemptFailed(source, state, retryKey, error, log);
      candidates.filter((pr) => pending.members.includes(pr.number)).forEach((pr) => observe(pr, 'stack-merge-pending'));
    }
  }

  const nativeGroups = new Map<number, PrCandidate[]>();
  for (const pr of candidates)
    if (pr.linkedStack) {
      const members = nativeGroups.get(pr.linkedStack.number) ?? [];
      members.push(pr);
      nativeGroups.set(pr.linkedStack.number, members);
    }
  for (const [number, group] of nativeGroups) {
    if (group.some((pr) => context.handled.has(pr.number))) {
      group.forEach((pr) => context.handled.add(pr.number));
      continue;
    }
    group.forEach((pr) => context.handled.add(pr.number));
    const top = [...group].sort((left, right) => right.linkedStack!.position - left.linkedStack!.position)[0]!;
    const blocked = (gate: string, message: string, stopped = false): void =>
      group.forEach((pr, index) => hold(pr, gate, message, stopped && index === 0));
    const retryKey = `${source.name}:stack:${number}:${group.map((pr) => `${pr.number}@${pr.headSha}`).sort().join(',')}`;
    if (!stackAttemptReady(state, retryKey, log)) { blocked('stack-retry', 'Waiting to retry the stack merge.'); continue; }
    try {
      if (state.stackRetry(retryKey)) {
        const dispositions = await Promise.all(group.map((pr) => source.disposition(pr.number)));
        if (dispositions.every((status) => status === 'merged')) {
          state.clearStackRetry(retryKey);
          for (const pr of group) {
            const approval = approve(pr);
            if (approval) state.consumeApproval(approval.key);
          }
          log(`Stack #${number} merged before the retry.`);
          continue;
        }
        if (dispositions.some((status) => status !== 'open')) {
          blocked('stack-changed', `Stack #${number} changed. Review the remaining PRs before merging.`, true);
          continue;
        }
      }
      if (!source.linkedMembers || !source.mergeLinked) {
        blocked('stack-unsupported', 'The forge cannot merge a linked stack.', true);
        continue;
      }
      const numbers = await source.linkedMembers(number);
      if (!numbers.length || numbers.length !== group.length || numbers.some((member) => !group.some((pr) => pr.number === member))) {
        blocked('stack-incomplete', `Stack #${number} has an unobserved member. Refresh the stack before merging.`, true);
        continue;
      }
      const fresh = await Promise.all(numbers.map((member) => source.refresh(member)));
      if (
        fresh.some(
          (pr) =>
            !pr ||
            pr.eligible === false ||
            pr.linkedStack?.number !== number ||
            !pr.defaultBranch ||
            pr.linkedStack.base !== pr.defaultBranch,
        )
      ) {
        blocked('stack-boundary', `Stack #${number} cannot merge into the default branch with the current scope.`, true);
        continue;
      }
      const members = fresh as PrCandidate[];
      const freshTop = [...members].sort((left, right) => right.linkedStack!.position - left.linkedStack!.position)[0]!;
      if (freshTop.number !== top.number || numbers.at(-1) !== top.number) {
        blocked('stack-changed', `Stack #${number} changed order. Refresh it before merging.`, true);
        continue;
      }
      const reviews = members.map(approve);
      if (reviews.some((review) => !review)) {
        blocked('waiting-approval', 'Waiting for current-head approvals.');
        continue;
      }
      const checks = await Promise.all(members.map((pr) => source.checks?.(pr.number, pr.headSha) ?? 'pending'));
      if (members.some((pr) => pr.mergeableState === 'dirty') || checks.includes('red')) {
        blocked('stack-stopped', `Stack #${number} stopped on a conflict or failing check.`, true);
        continue;
      }
      if (checks.some((status) => status !== 'green') || members.some((pr) => pr.mergeableState !== 'clean')) {
        blocked('stack-checks', 'Waiting for stack checks.');
        continue;
      }
      const currentTop = members.find((pr) => pr.number === top.number)!;
      const requestKey = `${source.name}:stack:${number}`;
      state.setStackMerge(requestKey, { number: top.number, members: numbers, approvals: reviews.map((review) => review!.key), submitting: true });
      const result = await source.mergeLinked(top.number, policy.method, currentTop.headSha);
      if (!['pending', 'merged', 'enqueued', 'failed'].includes(result.status)) throw new Error('GitHub returned an unknown merge result.');
      if (result.status === 'failed') {
        state.clearStackMerge(requestKey);
        blocked('stack-stopped', result.details.message ?? 'GitHub refused the stack merge.', true);
        continue;
      }
      if (result.status === 'pending' && !result.details.uuid) throw new Error('GitHub accepted a merge without a request id.');
      state.setStackMerge(requestKey, {
        number: top.number,
        members: numbers,
        ...(result.details.uuid ? { uuid: result.details.uuid } : {}),
        ...(result.status === 'enqueued' ? { enqueued: true } : {}),
      });
      state.clearStackRetry(retryKey);
      reviews.forEach((review) => state.consumeApproval(review!.key));
      blocked('stack-merge-pending', 'GitHub is processing the linked stack.');
      log(`Requested linked stack #${number} through #${top.number}; waiting for GitHub's result.`);
    } catch (error) {
      if (hasStackRetryPolicy(error)) state.clearStackMerge(`${source.name}:stack:${number}`);
      stackAttemptFailed(source, state, retryKey, error, log);
      blocked('stack-retry', 'Waiting to retry the stack merge.');
    }
  }

  for (const parent of candidates.filter((pr) => !pr.linkedStack)) {
    const children = candidates.filter((pr) => pr.baseRef === parent.headRef && pr.number !== parent.number);
    if (!children.length) continue;
    [parent, ...children].forEach((pr) => context.members.add(pr.number));
    if (
      candidates.filter((pr) => pr.headRef === parent.headRef).length !== 1 ||
      children.length !== 1 ||
      parent.eligible === false ||
      children[0]!.eligible === false
    ) {
      [parent, ...children].forEach((pr) =>
        hold(pr, 'stack-boundary', `Stack at #${parent.number} has a branch or an out-of-scope PR. Resolve it before merging.`, true),
      );
    } else context.children.set(parent.number, children[0]!);
  }
  for (const pr of candidates) {
    if (pr.eligible === false) {
      context.handled.add(pr.number);
      continue;
    }
    if (context.handled.has(pr.number)) continue;
    const advance = state.stackAdvance(keyOf(pr));
    if (advance) {
      const retryKey = `${keyOf(pr)}:advance:${pr.headSha}`;
      if (!stackAttemptReady(state, retryKey, log)) { hold(pr, 'stack-retry', 'Waiting to advance the stack.'); continue; }
      try {
        context.members.add(pr.number);
        const parent = await source.disposition(advance.parent);
        if (parent !== 'merged') {
          hold(
            pr,
            parent === 'open' ? 'stack-parent' : 'stack-stopped',
            `#${pr.number} waits for #${advance.parent} to merge.`,
            parent === 'closed',
          );
          continue;
        }
        const fresh = await source.refresh(pr.number);
        if (!fresh) {
          state.clearStackAdvance(keyOf(pr));
          context.handled.add(pr.number);
          continue;
        }
        if (!fresh.defaultBranch || !source.retarget || !source.includesBase || !source.checks) {
          hold(pr, 'stack-unsupported', `Cannot advance #${pr.number} without its default branch and check state.`, true);
          continue;
        }
        if (fresh.baseRef !== fresh.defaultBranch) {
          if (fresh.baseRef !== advance.from) {
            hold(pr, 'stack-stopped', `#${pr.number} changed its base. Review the stack before continuing.`, true);
            continue;
          }
          await source.retarget(pr.number, fresh.defaultBranch);
          hold(pr, 'stack-retargeted', 'Waiting for the retargeted base.');
          continue;
        }
        if (fresh.mergeableState === 'dirty') {
          hold(pr, 'stack-stopped', `#${pr.number} conflicts with ${fresh.defaultBranch}. Resolve the conflict and push normally.`, true);
          continue;
        }
        if (!(await source.includesBase(pr.number))) {
          if (advance.updateHead !== fresh.headSha) {
            await source.updateBranch(pr.number);
            state.setStackAdvance(keyOf(pr), { ...advance, updateHead: fresh.headSha });
          }
          hold(pr, 'stack-updating', 'Waiting for the default branch merge and its checks.');
          continue;
        }
        const status = await source.checks(fresh.number, fresh.headSha);
        if (status !== 'green') {
          hold(
            pr,
            status === 'red' ? 'stack-stopped' : 'stack-checks',
            `#${pr.number} ${status === 'red' ? 'has failing checks. Fix them before merging.' : 'is waiting for checks.'}`,
            status === 'red',
          );
          continue;
        }
        state.clearStackRetry(retryKey);
      } catch (error) {
        stackAttemptFailed(source, state, retryKey, error, log);
        hold(pr, 'stack-retry', 'Waiting to advance the stack.');
        continue;
      }
    }
    if (pr.defaultBranch && pr.baseRef !== pr.defaultBranch) {
      const parent = candidates.find((candidate) => candidate.headRef === pr.baseRef);
      if (!advance || (parent && !context.handled.has(parent.number))) hold(pr, 'stack-parent', `#${pr.number} waits for its base PR.`);
    }
  }
  return context;
}

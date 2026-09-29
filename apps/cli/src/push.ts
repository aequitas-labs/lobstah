import {
  appendStatus,
  chainPr,
  loadConfig,
  mergeEvidence,
  parsePrRef,
  postNotice,
  pushPrBranch,
  readPr,
  recordPush,
  repairKind,
  storedDescriptor,
  withPrLock,
  writePr,
} from '@lobstah/core';
import type { Lane, PushResult } from '@lobstah/core';

export interface PushOutcome {
  result: PushResult;
  /** The PR the push was for. */
  prUrl: string;
  /** The status note when the push failed for good and the dispatch was marked failed. */
  failed?: string;
}

/**
 * `lobstah push <id>`: push a dispatch's work to its existing PR's head
 * branch, retrying a push rejected because the branch moved up to
 * `[watch].pushRetries` times. When the retries are spent, the dispatch is
 * marked failed, the PR record is marked so no repair starts on the same
 * head, and the helm gets a `push-failed` notice. The PR is left as it was.
 */
export function runPush(
  id: string,
  lane: Lane,
  opts: { cwd?: string; retries?: number; beforeAttempt?: (attempt: number) => void } = {},
): PushOutcome {
  const descriptor = storedDescriptor(id, lane);
  if (!descriptor) throw new Error(`unknown dispatch ${id}`);
  const chain = descriptor.followUp ? chainPr(descriptor.followUp, lane) : undefined;
  const url = descriptor.pr?.url ?? chain?.url;
  const ref = url ? parsePrRef(url) : undefined;
  if (!url || !ref) {
    throw new Error(`dispatch ${id.slice(0, 8)} works on no existing PR; the runner pushes its branch and opens its draft PR`);
  }
  const record = readPr(ref.key);
  const branch = descriptor.pr?.headRefName ?? (chain?.url === url ? chain.headRefName : undefined) ?? record?.headRefName;
  if (!branch) throw new Error(`the head branch of ${url} is unknown; \`lobstah prs sync\` records it`);
  const retries = opts.retries ?? loadConfig().watch.pushRetries;
  const result = pushPrBranch({
    cwd: opts.cwd ?? process.cwd(),
    branch,
    retries,
    baseHead: descriptor.pr?.headSha ?? record?.headSha,
    beforeAttempt: opts.beforeAttempt,
  });
  if (result.kind === 'pushed') {
    recordPush(id, lane, [branch]);
    mergeEvidence(id, lane, { branch, prUrl: url });
    return { result, prUrl: url };
  }
  if (result.kind !== 'failed') return { result, prUrl: url };

  const moved = result.movedHead ? `; moved head ${result.movedHead.slice(0, 12)}` : '';
  const rejection = result.output.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ').slice(0, 400);
  const note = `push to ${branch} failed after ${result.attempts} attempt(s): ${result.reason}${moved}; rejection: ${rejection}; PR ${url} left as it was`;
  appendStatus(id, lane, 'failed', note);
  withPrLock(ref.key, () => {
    const pr = readPr(ref.key);
    if (!pr) return;
    const head = result.movedHead ?? pr.headSha;
    writePr({
      ...pr,
      repair: {
        headSha: head,
        ...(head !== pr.headSha ? { fromHeadSha: pr.headSha } : {}),
        kind: pr.repair?.kind ?? repairKind(pr) ?? 'conflict',
        attempts: pr.repair?.attempts ?? 1,
        ...(pr.repair?.maxAttempts !== undefined ? { maxAttempts: pr.repair.maxAttempts } : {}),
        status: 'blocked',
        reason: `push failed (dispatch ${id.slice(0, 8)}): ${result.reason}${moved}`,
        dispatchId: id,
      },
    });
  });
  postNotice({
    kind: 'push-failed',
    text: `${url}: dispatch ${id.slice(0, 8)} could not push to ${branch}: ${result.reason}${moved}. The PR is left as it was.`,
    refId: id,
    repo: descriptor.repo,
    dedupeKey: `push-failed-${id}`,
  });
  return { result, prUrl: url, failed: note };
}

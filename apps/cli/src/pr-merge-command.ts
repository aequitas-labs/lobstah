import { spawnSync } from 'node:child_process';
import { ghPrViewDirect, loadConfig, parsePrRef, prEvidence, readPr, upsertPr, type PrMergeMethod, type PrRef } from '@lobstah/core';
import { cancelPrMerge, prMergeMethod, requestPrMerge } from './pr-merge.js';
import { UsageError } from './usage.js';

/** Repository settings GitHub permits for a merge authorization. */
export interface RepositoryMergeMethods {
  mergeCommitAllowed: boolean;
  squashMergeAllowed: boolean;
  rebaseMergeAllowed: boolean;
}

/** Read allowed methods rather than guessing what GitHub will accept. */
function repositoryMethods(repo: string): RepositoryMergeMethods {
  const result = spawnSync('gh', ['repo', 'view', repo, '--json', 'mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed'], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`Could not read merge methods for ${repo}: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout) as RepositoryMergeMethods;
}

/** Validate and store the helm's explicit authorization, without performing a merge. */
export function mergeWhenGreenCommand(
  positionals: string[],
  flags: { opt: (name: string) => string | undefined; has: (name: string) => boolean },
  deps: { methods?: (repo: string) => RepositoryMergeMethods; observe?: (ref: PrRef) => void } = {},
): string {
  const { opt, has } = flags;
  const ref = parsePrRef(positionals[1] ?? '');
  if (positionals[0] !== 'merge-when-green' || !ref) throw new UsageError('Use lobstah pr merge-when-green <owner/repo#n>.');
  if (has('--clear')) {
    if (['--by', '--method', '--note', '--hold', '--release-hold'].some(has)) throw new UsageError('--clear cannot change a merge request.');
    return cancelPrMerge(ref.key) ? `Cancelled merge when green for ${ref.key}.` : `No merge request for ${ref.key}.`;
  }
  if (has('--hold') && has('--release-hold')) throw new UsageError('Use --hold or --release-hold, not both.');
  const by = opt('--by') ?? 'chat';
  if (by !== 'chat' && !/^decision:\S+$/.test(by)) throw new UsageError('--by must be chat or decision:<key>.');
  const explicit = opt('--method');
  if (explicit && explicit !== 'merge' && explicit !== 'squash') throw new UsageError('--method must be merge or squash.');
  if (has('--hold') && !opt('--hold')?.trim()) throw new UsageError('--hold requires a reason.');
  if (has('--release-hold') && !readPr(ref.key)?.mergeRequest) throw new UsageError('There is no merge hold to release.');
  const repo = `${ref.owner}/${ref.repo}`;
  const allowed = (deps.methods ?? repositoryMethods)(repo);
  const configured = prMergeMethod(loadConfig(), repo);
  const method: PrMergeMethod = (explicit as 'merge' | 'squash' | undefined) ?? readPr(ref.key)?.mergeRequest?.method ?? configured;
  const permitted = { merge: allowed.mergeCommitAllowed, squash: allowed.squashMergeAllowed, rebase: allowed.rebaseMergeAllowed };
  if (!permitted[method]) throw new UsageError(`${repo} does not allow ${method} merges. Choose an allowed --method.`);
  if (!readPr(ref.key)) {
    (deps.observe ?? ((pr) => upsertPr(prEvidence(pr, ghPrViewDirect(pr), new Date().toISOString()))))(ref);
  }
  const request = requestPrMerge(ref.key, by, {
    authorized: true, method, note: opt('--note'), hold: opt('--hold'), releaseHold: has('--release-hold'),
  });
  return `${ref.key}: merge when green (${request.method}), authorized by ${request.by} at ${request.at}${request.hold ? `; held: ${request.hold}` : ''}.`;
}

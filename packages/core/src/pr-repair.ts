import type { PrRecord } from './prs.js';

export type RepairKind = 'conflict' | 'checks' | 'review';
export type PrCommit = {
  sha?: string;
  author?: { login?: string } | null;
  committer?: { login?: string } | null;
  commit?: { author?: { email?: string }; committer?: { email?: string } };
};

/** A known dispatch commit anchors identity; later commits must have the same author and committer. */
export function branchOwnership(commits: PrCommit[], knownShas: ReadonlySet<string>): { safe: boolean; reason?: string } {
  let lastKnown = -1;
  commits.forEach((c, i) => {
    if (c.sha && [...knownShas].some((sha) => c.sha!.startsWith(sha.split(' ')[0]!))) lastKnown = i;
  });
  if (lastKnown < 0) return { safe: false, reason: 'commit ownership unknown: no dispatch commit on the PR branch' };
  const identity = (c: PrCommit) => [
    c.author?.login ?? c.commit?.author?.email ?? '',
    c.committer?.login ?? c.commit?.committer?.email ?? '',
  ];
  const owner = identity(commits[lastKnown]!);
  if (owner.some((x) => !x)) return { safe: false, reason: 'commit ownership unknown: dispatch identity missing' };
  for (const commit of commits.slice(lastKnown + 1)) {
    const current = identity(commit);
    if (current.some((x) => !x)) return { safe: false, reason: 'commit ownership unknown: newer commit identity missing' };
    if (current[0] !== owner[0] || current[1] !== owner[1]) return { safe: false, reason: 'person commits since the last lobstah commit' };
  }
  return { safe: true };
}

export function repairKind(pr: PrRecord): RepairKind | undefined {
  if (pr.mergeStateStatus === 'DIRTY') return 'conflict';
  if (pr.checks.failed > 0) return 'checks';
  if (pr.review?.changesRequested) return 'review';
  return undefined;
}

export function repairLimit(n: number): number {
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
}

/**
 * The push rule for a worker on an existing PR: push to the PR's head
 * branch with `lobstah push`, which fetches and replays when the branch
 * moved; never a new branch or a new PR.
 */
export function pushRule(branch: string | undefined, id = '<dispatch id>'): string {
  const b = branch ?? "the PR's head branch";
  return [
    `Push only to the existing branch ${b}, with \`lobstah push ${id}\`.`,
    `If the push is rejected because ${b} moved, it fetches ${b}, replays your commits onto the moved head, runs the push checks again, and pushes again.`,
    `If a push hook reports a real error, fix it, commit, and run \`lobstah push ${id}\` again.`,
    'Never push to another branch. Never open a new PR.',
    'If the push still cannot land, lobstah marks this dispatch failed and leaves the PR as it was: stop there.',
  ].join(' ');
}

/** The repair prompt uses the PR's actual base branch, including stacked PRs. */
export function repairBrief(pr: PrRecord, kind: RepairKind): string {
  const intro = `Repair ${pr.url} on its existing branch ${pr.headRefName ?? '(see PR)'} at ${pr.headSha}. Do not open a new PR.`;
  const finish = `Run the relevant tests. ${pushRule(pr.headRefName)} Report done with the same PR URL.`;
  if (kind === 'conflict')
    return `${intro}\nFetch the PR's base branch ${pr.baseRefName ?? '(read from PR)'}. Bring the PR branch up to date with that base by this repo's convention. Resolve conflicts while keeping both sides' intent. ${finish}`;
  if (kind === 'checks') {
    const checks = (pr.failingChecks ?? []).map((c) => `- ${c.name}${c.detailsUrl ? ` — ${c.detailsUrl}` : ''}`).join('\n');
    return `${intro}\nLatest failing checks:\n${checks || '- Read the failing check from GitHub'}\nRead each check log. Fix a real failure. If it is a flake, rerun it at most once. ${finish}`;
  }
  return `${intro}\nRead the requested review changes and comments with gh pr view --comments. Address the feedback. If a comment needs a person's decision, report needs-decision instead of guessing. ${finish}`;
}

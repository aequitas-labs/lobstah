import { loadConfig } from './config.js';
import { readEvidence } from './evidence.js';
import { readPr, withPrLock, writePr } from './prs.js';
import type { PrRecord } from './prs.js';
import type { Lane } from './types.js';

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

/** Whether a check name matches a human-gate pattern. `*` matches any run of characters. */
export function matchesGate(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) =>
    p.includes('*') ? new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name) : p === name,
  );
}

/**
 * The human gates of one PR: `[repos.<key>].humanGateChecks` of the repo
 * the owning dispatch ran in, the gates recorded on the PR record, and the
 * gates named in the evidence of the given dispatches.
 */
export function humanGatesFor(pr: Pick<PrRecord, 'humanGates'> | undefined, repoKey: string | undefined, ids: Iterable<string> = []): string[] {
  const out = new Set<string>();
  const configured = repoKey ? loadConfig().repos[repoKey]?.humanGateChecks : undefined;
  for (const name of configured ?? []) out.add(name);
  for (const name of pr?.humanGates ?? []) out.add(name);
  for (const id of ids) for (const lane of ['work', 'chore'] as Lane[]) for (const name of readEvidence(id, lane).humanGates ?? []) out.add(name);
  return [...out];
}

/** Record checks a worker named as human gates on the PR record. Returns the record's gates, or undefined without a record. */
export function recordHumanGates(key: string, names: readonly string[]): string[] | undefined {
  if (names.length === 0) return readPr(key)?.humanGates;
  return withPrLock(key, () => {
    const pr = readPr(key);
    if (!pr) return undefined;
    const humanGates = [...new Set([...(pr.humanGates ?? []), ...names])];
    writePr({ ...pr, humanGates });
    return humanGates;
  });
}

/** Names of the failing checks on the PR's current head. */
export function failingCheckNames(pr: Pick<PrRecord, 'failingChecks' | 'checks'>): string[] {
  return [...new Set((pr.failingChecks ?? []).map((c) => c.name))];
}

/** Failing checks a repair may work on: every failing check that is not a human gate. */
export function repairableChecks(pr: Pick<PrRecord, 'failingChecks' | 'checks'>, gates: readonly string[] = []): string[] {
  return failingCheckNames(pr).filter((name) => !matchesGate(name, gates));
}

/**
 * The floor: one repair round per PR, check name, and commit. The checks
 * of `candidates` that have not had their round at this head.
 */
export function unrepairedChecks(candidates: readonly string[], repairedAtHead: readonly string[] | undefined): string[] {
  return candidates.filter((name) => !(repairedAtHead ?? []).includes(name));
}

export function repairKind(pr: PrRecord, gates: readonly string[] = []): RepairKind | undefined {
  if (pr.mergeStateStatus === 'DIRTY') return 'conflict';
  // Counts without names (an older record) are still a failure to repair.
  if (pr.checks.failed > 0 && (!pr.failingChecks?.length || repairableChecks(pr, gates).length > 0)) return 'checks';
  if (pr.review?.changesRequested) return 'review';
  return undefined;
}

export function repairLimit(n: number): number {
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
}

/** How many times a worker retries a push rejected because the PR branch moved. */
export const PUSH_RETRIES = 3;

/** The start of the failed note a worker writes when it cannot push to its PR's branch. */
export const PUSH_REJECTED = 'push rejected:';

/**
 * The push rule for a worker on an existing PR: push to the PR's head
 * branch only; on a non-fast-forward rejection fetch, rebase onto the moved
 * head, and push with a lease, up to three times; never a new branch or PR.
 */
export function pushRule(branch: string | undefined, id = '<dispatch id>'): string {
  const b = branch ?? "the PR's head branch";
  return [
    `Push only to the existing branch ${b}.`,
    `If the push is rejected as non-fast-forward because ${b} moved, fetch ${b}, rebase your commits onto the moved head again, and push with \`--force-with-lease=${b}:<the head you just fetched>\`. Retry at most ${PUSH_RETRIES} times.`,
    'If a push hook fails with a real test or type error, do not retry the push: fix the error, commit, and push again.',
    `If you still cannot push, report \`lobstah report ${id} failed "${PUSH_REJECTED} <rejection text>; moved head <full sha of the head you fetched>"\` and leave the PR as it was.`,
    'Never push to another branch. Never open a new PR.',
  ].join(' ');
}

/** The repair prompt uses the PR's actual base branch, including stacked PRs. */
export function repairBrief(pr: PrRecord, kind: RepairKind, arg: string | { id?: string; checks?: readonly string[]; gates?: readonly string[] } = {}): string {
  const opts = typeof arg === 'string' ? { id: arg } : arg;
  const intro = `Repair ${pr.url} on its existing branch ${pr.headRefName ?? '(see PR)'} at ${pr.headSha}. Do not open a new PR.`;
  const finish = `Run the relevant tests. ${pushRule(pr.headRefName, opts.id)} Report done with the same PR URL.`;
  if (kind === 'conflict')
    return `${intro}\nFetch the PR's base branch ${pr.baseRefName ?? '(read from PR)'}. Bring the PR branch up to date with that base by this repo's convention. Resolve conflicts while keeping both sides' intent. ${finish}`;
  if (kind === 'checks') {
    const failing = (pr.failingChecks ?? []).filter((c) => !opts.checks || opts.checks.includes(c.name));
    const checks = failing.map((c) => `- ${c.name}${c.detailsUrl ? ` — ${c.detailsUrl}` : ''}`).join('\n');
    const gated = failingCheckNames(pr).filter((name) => matchesGate(name, opts.gates ?? []));
    const gates = gated.length
      ? `\nThese failing checks are human gates. They pass only when a person approves. Do not work on them: ${gated.join(', ')}.`
      : '';
    return (
      `${intro}\nLatest failing checks:\n${checks || '- Read the failing check from GitHub'}${gates}\n` +
      `Read each check log. Fix a real failure. If it is a flake, rerun it at most once. ` +
      `If a check cannot pass until a person approves the change, it is a human gate: do not change code for it, and name it on your report with --human-gate "<check name>", once per check. ${finish}`
    );
  }
  return `${intro}\nRead the requested review changes and comments with gh pr view --comments. Address the feedback. If a comment needs a person's decision, report needs-decision instead of guessing. ${finish}`;
}

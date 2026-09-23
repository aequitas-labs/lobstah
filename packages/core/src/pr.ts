import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * The shipped GitHub PR watch: `pr:<owner>/<repo>#<n>`. The check reads one
 * `gh pr view` per cycle and diffs it against the previous observation,
 * which the opaque cursor carries — so a re-run over an unchanged PR emits
 * nothing and returns the same cursor, and the watch contract's idempotence
 * holds without any state beside the watch file. `gh` is the only forge
 * client, as in pick, and the check never writes to GitHub.
 */

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
  /** The watch key: `pr:<owner>/<repo>#<n>`. */
  key: string;
  url: string;
}

/** `pr:o/r#n`, `o/r#n`, or a github.com PR URL (any trailing path) → the ref. */
export function parsePrRef(s: string): PrRef | undefined {
  const m =
    /^(?:pr:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(s.trim()) ??
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(s.trim());
  if (!m) return undefined;
  const [, owner, repo, n] = m as unknown as [string, string, string, string];
  const number = Number(n);
  return { owner, repo, number, key: `pr:${owner}/${repo}#${number}`, url: `https://github.com/${owner}/${repo}/pull/${number}` };
}

/** The `gh pr view --json` fields the check reads. */
export const PR_VIEW_FIELDS =
  'state,isDraft,headRefOid,mergeStateStatus,reviewDecision,statusCheckRollup,mergedAt,closedAt,updatedAt,reviews';

export interface GhRollupItem {
  __typename?: string;
  /** CheckRun */
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string;
  /** StatusContext */
  context?: string;
  state?: string;
  targetUrl?: string;
}

/** One entry of `gh pr view --json reviews` — only the fields the check reads (never the body). */
export interface GhReview {
  author?: { login?: string };
  state?: string;
  submittedAt?: string;
}

export interface GhPrView {
  state: string;
  isDraft: boolean;
  headRefOid: string;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  statusCheckRollup?: GhRollupItem[] | null;
  mergedAt?: string | null;
  closedAt?: string | null;
  updatedAt?: string;
  reviews?: GhReview[] | null;
  /**
   * Unresolved review threads, from the one GraphQL query the check makes
   * while the PR is open (`gh pr view --json` has no reviewThreads field).
   * Absent when that query failed or was skipped — the observation then
   * carries no unresolvedThreads.
   */
  unresolvedThreads?: number;
}

type Outcome = 'passed' | 'failed' | 'pending';
interface Check {
  name: string;
  /** Completed conclusion (upper-case), or '' while pending. */
  conclusion: string;
  outcome: Outcome;
  detailsUrl?: string;
}

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING = new Set(['', 'PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);

function normalizeChecks(rollup: GhRollupItem[] | null | undefined): Check[] {
  const out: Check[] = [];
  for (const c of rollup ?? []) {
    const name = c.name ?? c.context ?? '?';
    // A CheckRun still running has no conclusion; a StatusContext's state is its verdict.
    const conclusion = (
      c.__typename === 'StatusContext' || (c.conclusion === undefined && c.state !== undefined)
        ? (c.state ?? '')
        : c.status && c.status !== 'COMPLETED'
          ? ''
          : (c.conclusion ?? '')
    ).toUpperCase();
    const outcome: Outcome = PENDING.has(conclusion) ? 'pending' : PASSED.has(conclusion) ? 'passed' : 'failed';
    out.push({ name, conclusion: outcome === 'pending' ? '' : conclusion, outcome, detailsUrl: c.detailsUrl ?? c.targetUrl });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The evidence `pr` object: the PR's state as last observed. */
export interface PrEvidence {
  url: string;
  number: number;
  state: string;
  draft: boolean;
  reviewDecision: string;
  mergeStateStatus: string;
  headSha: string;
  checks: { total: number; passed: number; failed: number; pending: number };
  /** Review state; comment bodies are never stored. */
  review?: PrReview;
  observedAt: string;
}

export interface PrReview {
  /** Absent when the reviewThreads query failed for this observation. */
  unresolvedThreads?: number;
  changesRequested: boolean;
  lastReviewAt?: string;
}

/**
 * Review state from the reviews list: changes are requested when the PR's
 * reviewDecision says so (branch protection) or when any reviewer's latest
 * decisive review (APPROVED / CHANGES_REQUESTED / DISMISSED) requests them —
 * reviewDecision is empty on repos that don't require reviews.
 */
export function prReview(view: GhPrView): PrReview {
  const latest = new Map<string, string>();
  let lastReviewAt: string | undefined;
  const reviews = [...(view.reviews ?? [])].sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''));
  for (const r of reviews) {
    if (r.submittedAt && (!lastReviewAt || r.submittedAt > lastReviewAt)) lastReviewAt = r.submittedAt;
    const state = (r.state ?? '').toUpperCase();
    if (state === 'APPROVED' || state === 'CHANGES_REQUESTED' || state === 'DISMISSED') latest.set(r.author?.login ?? '?', state);
  }
  const changesRequested = view.reviewDecision === 'CHANGES_REQUESTED' || [...latest.values()].includes('CHANGES_REQUESTED');
  return {
    ...(view.unresolvedThreads !== undefined ? { unresolvedThreads: view.unresolvedThreads } : {}),
    changesRequested,
    ...(lastReviewAt ? { lastReviewAt } : {}),
  };
}

export function prEvidence(ref: PrRef, view: GhPrView, observedAt: string): PrEvidence {
  const checks = normalizeChecks(view.statusCheckRollup);
  const count = (o: Outcome) => checks.filter((c) => c.outcome === o).length;
  return {
    url: ref.url,
    number: ref.number,
    state: view.state,
    draft: view.isDraft,
    reviewDecision: view.reviewDecision ?? '',
    mergeStateStatus: view.mergeStateStatus ?? '',
    headSha: view.headRefOid,
    checks: { total: checks.length, passed: count('passed'), failed: count('failed'), pending: count('pending') },
    review: prReview(view),
    observedAt,
  };
}

/** What the cursor remembers: enough of the last observation to diff against. */
interface Observed {
  /** head sha */
  h: string;
  /** state: OPEN | CLOSED | MERGED */
  s: string;
  d: boolean;
  r: string;
  m: string;
  /** check name → completed conclusion ('' = pending) */
  c: Record<string, string>;
}

function encodeCursor(o: Observed): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}
function decodeCursor(cursor: string | undefined): Observed | undefined {
  if (!cursor || cursor === '0') return undefined;
  try {
    const o = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Observed;
    return typeof o.h === 'string' && typeof o.c === 'object' ? o : undefined;
  } catch {
    return undefined;
  }
}

export type PrEventKind = 'check-completed' | 'review-decision' | 'merge-state' | 'draft' | 'merged' | 'closed';

export interface PrEvent {
  seq: string;
  kind: PrEventKind;
  summary: string;
  pr: string;
  url: string;
  headSha: string;
  name?: string;
  conclusion?: string;
  detailsUrl?: string;
  value?: string | boolean;
  /** Surface to the helm as a notice instead of forking work (the delivery rule). */
  notice: boolean;
}

export function isFailingConclusion(conclusion: string | undefined): boolean {
  return !!conclusion && !PASSED.has(conclusion) && !PENDING.has(conclusion);
}

/**
 * Diff one observation against the cursor. One event per change: a check
 * that completed (or completed differently) on the current head, a review
 * decision, merge state, or draft flip, and the terminal merged / closed.
 * A first observation (cursor "0") reports completed checks, a standing
 * review decision, and a terminal state — merge state and draft are its
 * baseline, not news. A new head sha resets check memory, so the same check
 * failing again after a push is a new event.
 *
 * Each event's seq is derived from the previous cursor and the change, so a
 * replay over the same cursor yields the same seqs and the watch's seq
 * dedupe keeps delivery exactly-once.
 */
export function derivePrEvents(
  ref: PrRef,
  view: GhPrView,
  cursor: string | undefined,
): { cursor: string; events: PrEvent[]; done: boolean } {
  const prev = decodeCursor(cursor);
  const checks = normalizeChecks(view.statusCheckRollup);
  const now: Observed = {
    h: view.headRefOid,
    s: view.state,
    d: view.isDraft,
    r: view.reviewDecision ?? '',
    m: view.mergeStateStatus ?? '',
    c: Object.fromEntries(checks.map((c) => [c.name, c.conclusion])),
  };
  const next = encodeCursor(now);
  const epoch = createHash('sha1').update(cursor ?? '0').digest('hex').slice(0, 10);
  const sha7 = view.headRefOid.slice(0, 7);
  const base = { pr: ref.key, url: ref.url, headSha: view.headRefOid };
  const events: PrEvent[] = [];
  const push = (kind: PrEventKind, detail: string, summary: string, extra: Partial<PrEvent>, notice: boolean) =>
    events.push({ seq: `${epoch}:${kind}:${detail}`, kind, summary: `${ref.key} ${summary}`, ...base, ...extra, notice });

  const sameHead = prev !== undefined && prev.h === now.h;
  for (const c of checks) {
    if (c.outcome === 'pending') continue;
    if (sameHead && prev!.c[c.name] === c.conclusion) continue;
    const failed = c.outcome === 'failed';
    push(
      'check-completed',
      `${c.name}:${c.conclusion}`,
      `check ${c.name} ${c.conclusion} at ${sha7}${c.detailsUrl ? ` — ${c.detailsUrl}` : ''}`,
      { name: c.name, conclusion: c.conclusion, detailsUrl: c.detailsUrl },
      !failed,
    );
  }
  if (now.r !== '' && (prev === undefined || prev.r !== now.r)) {
    // Routing of review feedback is decided at delivery (config-dependent);
    // the check marks it work-shaped.
    push('review-decision', now.r, `review decision ${now.r} at ${sha7}`, { value: now.r }, false);
  }
  if (prev !== undefined && prev.m !== now.m && now.s === 'OPEN') {
    push('merge-state', now.m, `merge state ${now.m || 'unknown'}`, { value: now.m }, true);
  }
  if (prev !== undefined && prev.d !== now.d) {
    push('draft', String(now.d), now.d ? 'converted to draft' : 'ready for review', { value: now.d }, true);
  }
  const done = now.s === 'MERGED' || now.s === 'CLOSED';
  if (done && prev?.s !== now.s) {
    if (now.s === 'MERGED') push('merged', 'merged', `merged at ${sha7}`, {}, true);
    else push('closed', 'closed', 'closed without merge', {}, true);
  }
  return { cursor: next, events, done };
}

/** One `gh pr view`; throws with gh's own stderr so the watch records it as lastError. */
export function ghPrView(ref: PrRef): GhPrView {
  const res = spawnSync(
    'gh',
    ['pr', 'view', String(ref.number), '--repo', `${ref.owner}/${ref.repo}`, '--json', PR_VIEW_FIELDS],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (res.error) throw new Error(`gh: ${res.error.message}`);
  if (res.status !== 0) throw new Error(res.stderr.trim() || `gh exited ${res.status}`);
  const view = JSON.parse(res.stdout) as GhPrView;
  if (view.state === 'OPEN') {
    const threads = ghUnresolvedThreads(ref);
    if (threads !== undefined) view.unresolvedThreads = threads;
  }
  return view;
}

const THREADS_QUERY =
  'query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved}}}}}';

/**
 * The one extra read-only call: unresolved review threads over GraphQL,
 * which `gh pr view --json` cannot return. Only isResolved is requested —
 * no bodies. A failure yields undefined, never an error: the observation
 * still stamps changesRequested and lastReviewAt from gh pr view.
 */
export function ghUnresolvedThreads(ref: PrRef): number | undefined {
  const res = spawnSync(
    'gh',
    ['api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-f', `owner=${ref.owner}`, '-f', `repo=${ref.repo}`, '-F', `n=${ref.number}`],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (res.error || res.status !== 0) return undefined;
  return parseUnresolvedThreads(res.stdout);
}

/** Count unresolved threads in the GraphQL response; undefined when it isn't the expected shape. */
export function parseUnresolvedThreads(stdout: string): number | undefined {
  try {
    const nodes = (
      JSON.parse(stdout) as {
        data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: Array<{ isResolved?: boolean }> } } } };
      }
    ).data?.repository?.pullRequest?.reviewThreads?.nodes;
    return Array.isArray(nodes) ? nodes.filter((t) => t.isResolved === false).length : undefined;
  } catch {
    return undefined;
  }
}

export interface PrBadge {
  text: string;
  tone: 'ok' | 'warn' | 'bad' | 'dim';
}

/**
 * The one-word PR state shown by tend, catch, and the glass — one
 * derivation so the three never disagree. Terminal first, then what blocks
 * a merge, in the order a human would act on it.
 */
export function prBadge(pr: PrEvidence): PrBadge {
  const { total, failed, pending, passed } = pr.checks;
  if (pr.state === 'MERGED') return { text: 'merged', tone: 'ok' };
  if (pr.state === 'CLOSED') return { text: 'closed', tone: 'dim' };
  if (pr.draft) return { text: 'draft', tone: 'dim' };
  if (failed > 0) return { text: `checks ${failed}/${total} failed`, tone: 'bad' };
  if (pr.reviewDecision === 'CHANGES_REQUESTED' || pr.review?.changesRequested) return { text: 'changes requested', tone: 'bad' };
  const threads = pr.review?.unresolvedThreads ?? 0;
  if (threads > 0) return { text: `${threads} unresolved`, tone: 'warn' };
  if (pending > 0) return { text: `checks ${passed}/${total}`, tone: 'warn' };
  if (pr.mergeStateStatus === 'DIRTY') return { text: 'conflicts', tone: 'bad' };
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return { text: 'review', tone: 'warn' };
  return { text: 'green', tone: 'ok' };
}

/** The continuation brief for PR events that are work: a failed check or a review decision. */
export function prFixBrief(ref: PrRef): string {
  return `The pull request ${ref.url} (${ref.key}) needs work:

{summaries}

For a failed check: read its log (the details URL above, or \`gh run view\`), reproduce locally, fix it, and push to the PR's existing branch at the head sha named above — do not open a new PR.
For a review decision: read the review with \`gh pr view ${ref.number} --repo ${ref.owner}/${ref.repo} --comments\`, address it, and push to the same branch.
Then report done with the same PR: \`lobstah report <id> done "<note>" --pr ${ref.url}\`.

Raw events:
{events}`;
}

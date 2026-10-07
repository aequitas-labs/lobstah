import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { AttentionKind } from './config.js';
import { firstMeaningfulLine } from './gh-errors.js';

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

/**
 * Every PR a dispatch owns, one per PR: its `prUrl`, then its `prUrls`,
 * else the PR its watch observed. Canonical URLs.
 */
export function dispatchPrUrls(ev: { prUrl?: string; prUrls?: string[]; pr?: { url: string } }): string[] {
  const out = new Map<string, string>();
  for (const u of [ev.prUrl, ...(ev.prUrls ?? [])]) {
    const ref = u ? parsePrRef(u) : undefined;
    if (ref && !out.has(ref.key)) out.set(ref.key, ref.url);
  }
  if (out.size === 0 && ev.pr?.url) {
    const ref = parsePrRef(ev.pr.url);
    if (ref) out.set(ref.key, ref.url);
  }
  return [...out.values()];
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
  'title,state,isDraft,isCrossRepository,headRefOid,baseRefName,baseRefOid,headRefName,mergeStateStatus,reviewDecision,statusCheckRollup,mergedAt,closedAt,updatedAt,reviews';

/** The same view without check results: the fallback when only statusCheckRollup is forbidden. */
export const PR_VIEW_FIELDS_NO_CHECKS = PR_VIEW_FIELDS.split(',')
  .filter((f) => f !== 'statusCheckRollup')
  .join(',');

/** GitHub's answer when an App installation (or fine-grained token) lacks a permission. */
const FORBIDDEN = /resource not accessible by (integration|personal access token)/i;

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
  startedAt?: string;
  completedAt?: string;
  createdAt?: string;
  workflowName?: string;
  app?: { name?: string; slug?: string };
}

/** One entry of `gh pr view --json reviews` — only the fields the check reads (never the body). */
export interface GhReview {
  author?: { login?: string };
  state?: string;
  submittedAt?: string;
}

export interface GhPrView {
  isCrossRepository?: boolean;
  title?: string;
  state: string;
  isDraft: boolean;
  headRefOid: string;
  baseRefName?: string;
  /** The base branch's head commit. Absent when this gh cannot return it. */
  baseRefOid?: string;
  headRefName?: string;
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
  /**
   * Set when check results could not be read (the App lacks `Checks: read`)
   * and the view was fetched without them: gh's reason. The observation then
   * marks its checks unknown, and the PR is never ready.
   */
  checksError?: string;
}

export type Outcome = 'passed' | 'failed' | 'pending' | 'unknown';
interface Check {
  key: string;
  name: string;
  /** Completed conclusion (upper-case), or '' while pending. */
  conclusion: string;
  outcome: Outcome;
  detailsUrl?: string;
}

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING = new Set(['', 'PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);

/** The latest run of each check, by name: its outcome. */
export function latestCheckOutcomes(rollup: GhRollupItem[] | null | undefined): Array<{ name: string; outcome: Outcome }> {
  return normalizeChecks(rollup).map((c) => ({ name: c.name, outcome: c.outcome }));
}

function normalizeChecks(rollup: GhRollupItem[] | null | undefined): Check[] {
  const latest = new Map<string, { check: Check; at: string; startedAt: string; index: number }>();
  for (const [index, c] of (rollup ?? []).entries()) {
    const name = c.name ?? c.context ?? '?';
    const key = [name, c.app?.slug ?? c.app?.name ?? '', c.workflowName ?? ''].join('\0');
    // A CheckRun still running has no conclusion; a StatusContext's state is its verdict.
    const conclusion = (
      c.__typename === 'StatusContext' || (c.conclusion === undefined && c.state !== undefined)
        ? (c.state ?? '')
        : c.status && c.status !== 'COMPLETED'
          ? ''
          : (c.conclusion ?? '')
    ).toUpperCase();
    const outcome: Outcome = PENDING.has(conclusion)
      ? 'pending'
      : PASSED.has(conclusion)
        ? 'passed'
        : FAILED.has(conclusion)
          ? 'failed'
          : 'unknown';
    const startedAt = c.startedAt ?? c.createdAt ?? '';
    const at = c.completedAt ?? startedAt;
    const old = latest.get(key);
    if (!old || at > old.at || (at === old.at && (startedAt > old.startedAt || (startedAt === old.startedAt && index > old.index)))) {
      latest.set(key, {
        check: { key, name, conclusion: outcome === 'pending' ? '' : conclusion, outcome, detailsUrl: c.detailsUrl ?? c.targetUrl },
        at,
        startedAt,
        index,
      });
    }
  }
  return [...latest.values()].map((v) => v.check).sort((a, b) => a.name.localeCompare(b.name));
}

/** The evidence `pr` object: the PR's state as last observed. */
export type PrStandingKind = Extract<AttentionKind, `pr:${string}`>;

export interface PrRepair {
  headSha: string;
  kind: 'conflict' | 'checks' | 'review';
  attempts: number;
  maxAttempts?: number;
  /**
   * `waiting`: a repair is due but is not queued yet. `reason` says why and
   * `heldBy` names the holder. A wait is not an attempt.
   */
  status: 'repairing' | 'gave-up' | 'blocked' | 'waiting';
  reason?: string;
  /**
   * Who holds a waiting repair: `wt:<trap>`, `dispatch:<id>`, `helm`,
   * `settle`, `checks`, `human-gate` (only human gates fail), or `repaired`
   * (each failing check already had its one round at this head).
   */
  heldBy?: string;
  /** A settle wait: the earliest time the repair can be queued (ISO). */
  until?: string;
  dispatchId?: string;
  /**
   * A failed push: the head the repair started from. The record is marked
   * at the moved head (`headSha`); this head is covered too until the PR
   * watch observes the move.
   */
  fromHeadSha?: string;
  /** Checks that had their one repair round at `headSha`. */
  checks?: string[];
  observationsAtRepair?: number;
  /** Atomic claim metadata for one repairer. */
  startedAt?: string;
  by?: string;
}

export interface PrEvidence {
  isCrossRepository?: boolean;
  /** Branch discovery's list result awaits the normal watch's full review-thread check. */
  discoveryPending?: boolean;
  url: string;
  number: number;
  /** The PR's title as last observed. Not part of the PR's state: a change is never news. */
  title?: string;
  state: string;
  draft: boolean;
  reviewDecision: string;
  mergeStateStatus: string;
  headSha: string;
  /** Current GitHub branch relation; the base may retarget after a lower PR merges. */
  baseRefName?: string;
  /** The base branch's head commit, when the forge supplied it. */
  baseSha?: string;
  headRefName?: string;
  /**
   * Check counts. `unknown` is set when the check results could not be read
   * (no permission); the counts are then zero and mean nothing.
   */
  checks: { total: number; passed: number; failed: number; pending: number; unknown?: 'no permission' | 'latest run' };
  /** Latest failing runs, for a repair brief. */
  failingChecks?: Array<{ name: string; detailsUrl?: string }>;
  /** Watch repair state, present in persistent PR records. */
  repair?: PrRepair;
  /** Review state; comment bodies are never stored. */
  review?: PrReview;
  observedAt: string;
  /** First observation at which each pr:* condition became true; pr:ready's settle starts here. */
  standingSince?: Partial<Record<PrStandingKind, string>>;
  /** Forge's last update, when the observation captured it. */
  updatedAt?: string;
  /** Present for a merged or closed PR when the forge supplies it. */
  mergedAt?: string;
  closedAt?: string;
}

/** Which pr:* kinds stand on this observation, independent of display suppression. */
export function prStandingKinds(pr: PrEvidence, settle?: { readySettleSecs: number; now: number }): PrStandingKind[] {
  if (pr.state !== 'OPEN') return [];
  const out: PrStandingKind[] = [];
  const { failed, pending, total } = pr.checks;
  if (pr.draft) out.push('pr:draft');
  const review = (pr.review?.unresolvedThreads ?? 0) > 0 || pr.review?.changesRequested === true;
  if (review) out.push('pr:review');
  if (failed > 0) out.push('pr:checks');
  if (isConflicting(pr.mergeStateStatus)) out.push('pr:conflict');
  // Unknown checks (no permission to read them) never stand as ready.
  if (
    !pr.discoveryPending &&
    !pr.checks.unknown &&
    !pr.draft &&
    !review &&
    isMergeable(pr.mergeStateStatus) &&
    failed === 0 &&
    pending === 0 &&
    (pr.reviewDecision === 'APPROVED' || total > 0)
  ) {
    // Without settle options, return the raw conditions for the record writer.
    // Readers re-evaluate the persisted start on every poll, even without a forge event.
    const since = Date.parse(pr.standingSince?.['pr:ready'] ?? pr.observedAt);
    if (!settle || settle.readySettleSecs === 0 || settle.now >= since + settle.readySettleSecs * 1000) out.push('pr:ready');
  }
  return out;
}

export interface PrReview {
  /** Absent when the reviewThreads query failed for this observation. */
  unresolvedThreads?: number;
  changesRequested: boolean;
  lastReviewAt?: string;
  /** The latest approval's time: a conflict repair waits the settle time after it. */
  lastApprovalAt?: string;
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
  let lastApprovalAt: string | undefined;
  const reviews = [...(view.reviews ?? [])].sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''));
  for (const r of reviews) {
    if (r.submittedAt && (!lastReviewAt || r.submittedAt > lastReviewAt)) lastReviewAt = r.submittedAt;
    const state = (r.state ?? '').toUpperCase();
    if (state === 'APPROVED' && r.submittedAt && (!lastApprovalAt || r.submittedAt > lastApprovalAt)) lastApprovalAt = r.submittedAt;
    if (state === 'APPROVED' || state === 'CHANGES_REQUESTED' || state === 'DISMISSED') latest.set(r.author?.login ?? '?', state);
  }
  const changesRequested = view.reviewDecision === 'CHANGES_REQUESTED' || [...latest.values()].includes('CHANGES_REQUESTED');
  return {
    ...(view.unresolvedThreads !== undefined ? { unresolvedThreads: view.unresolvedThreads } : {}),
    changesRequested,
    ...(lastReviewAt ? { lastReviewAt } : {}),
    ...(lastApprovalAt ? { lastApprovalAt } : {}),
  };
}

export function prEvidence(ref: PrRef, view: GhPrView, observedAt: string): PrEvidence {
  const checks = normalizeChecks(view.statusCheckRollup);
  const count = (o: Outcome) => checks.filter((c) => c.outcome === o).length;
  return {
    url: ref.url,
    number: ref.number,
    ...(view.title ? { title: view.title } : {}),
    state: view.state,
    ...(view.isCrossRepository !== undefined ? { isCrossRepository: view.isCrossRepository } : {}),
    draft: view.isDraft,
    reviewDecision: view.reviewDecision ?? '',
    mergeStateStatus: view.mergeStateStatus ?? '',
    headSha: view.headRefOid,
    ...(view.baseRefName ? { baseRefName: view.baseRefName } : {}),
    ...(view.baseRefOid ? { baseSha: view.baseRefOid } : {}),
    ...(view.headRefName ? { headRefName: view.headRefName } : {}),
    checks: {
      total: checks.length,
      passed: count('passed'),
      failed: count('failed'),
      pending: count('pending'),
      ...(view.checksError ? { unknown: 'no permission' as const } : count('unknown') > 0 ? { unknown: 'latest run' as const } : {}),
    },
    ...(count('failed') > 0
      ? {
          failingChecks: checks
            .filter((c) => c.outcome === 'failed')
            .map((c) => ({ name: c.name, ...(c.detailsUrl ? { detailsUrl: c.detailsUrl } : {}) })),
        }
      : {}),
    review: prReview(view),
    observedAt,
    ...(view.updatedAt ? { updatedAt: view.updatedAt } : {}),
    ...(view.mergedAt ? { mergedAt: view.mergedAt } : {}),
    ...(view.closedAt ? { closedAt: view.closedAt } : {}),
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
  return FAILED.has((conclusion ?? '').toUpperCase());
}

/**
 * Diff one observation against the cursor. One event per change: a check
 * that completed (or completed differently) on the current head, a review
 * decision, merge state, or draft flip, and the terminal merged / closed.
 *
 * The first observation (cursor "0", or a cursor that does not decode) is
 * the baseline, not news:
 * - An OPEN PR: completed checks, merge state, and draft are recorded in the
 *   cursor and emit nothing. A check that already failed is in the PR record
 *   and in tend, but it forks no CI-fix dispatch. A standing review decision
 *   is still reported.
 * - A MERGED or CLOSED PR: nothing is emitted and the watch is done. The PR
 *   record carries the terminal state; the merged / closed notice comes from
 *   the record (observePr), not from here.
 * After the baseline, only a check that completes (or changes conclusion) on
 * the same head, or any completed check on a new head sha, is news. A new
 * head sha resets check memory, so the same check failing again after a push
 * is a new event. A PR that is MERGED or CLOSED never emits check or review
 * events: there is nothing left to fix.
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
    c: Object.fromEntries(checks.map((c) => [c.key, c.conclusion])),
  };
  const next = encodeCursor(now);
  const epoch = createHash('sha1')
    .update(cursor ?? '0')
    .digest('hex')
    .slice(0, 10);
  const sha7 = view.headRefOid.slice(0, 7);
  const base = { pr: ref.key, url: ref.url, headSha: view.headRefOid };
  const events: PrEvent[] = [];
  const push = (kind: PrEventKind, detail: string, summary: string, extra: Partial<PrEvent>, notice: boolean) =>
    events.push({ seq: `${epoch}:${kind}:${detail}`, kind, summary: `${ref.key} ${summary}`, ...base, ...extra, notice });

  const done = now.s === 'MERGED' || now.s === 'CLOSED';
  // First sight of a terminal PR: record only. No checks, no review, no notice event.
  if (prev === undefined && done) return { cursor: next, events, done };

  const sameHead = prev !== undefined && prev.h === now.h;
  // The first observation of an open PR is the check baseline; a terminal PR has nothing to fix.
  for (const c of prev === undefined || done ? [] : checks) {
    if (c.outcome === 'pending' || c.outcome === 'unknown') continue;
    if (sameHead && (prev!.c[c.key] ?? prev!.c[c.name]) === c.conclusion) continue;
    const failed = c.outcome === 'failed';
    push(
      'check-completed',
      `${c.key}:${c.conclusion}`,
      `check ${c.name} ${c.conclusion} at ${sha7}${c.detailsUrl ? ` — ${c.detailsUrl}` : ''}`,
      { name: c.name, conclusion: c.conclusion, detailsUrl: c.detailsUrl },
      !failed,
    );
  }
  if (!done && now.r !== '' && (prev === undefined || prev.r !== now.r)) {
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
  if (done && prev!.s !== now.s) {
    if (now.s === 'MERGED') push('merged', 'merged', `merged at ${sha7}`, {}, true);
    else push('closed', 'closed', 'closed without merge', {}, true);
  }
  return { cursor: next, events, done };
}

/**
 * One `gh pr view`; throws with gh's own first stderr line so the watch
 * records it as lastError. When the App may not read check results, the
 * view is fetched again without statusCheckRollup: the PR state is still
 * recorded, checksError carries the reason, and the checks read unknown.
 * If the view fails even without check results, the error says so.
 */
export function ghPrView(ref: PrRef): GhPrView {
  const view1 = (fields: string) =>
    spawnSync('gh', ['pr', 'view', String(ref.number), '--repo', `${ref.owner}/${ref.repo}`, '--json', fields], {
      encoding: 'utf8',
      timeout: 60_000,
    });
  const reason = (r: ReturnType<typeof view1>) => firstMeaningfulLine(r.stderr) ?? `gh exited ${r.status}`;
  // An older gh does not know baseRefOid: read the view without it.
  const unknownBase = (r: ReturnType<typeof view1>) => r.status !== 0 && /unknown json field.*baseRefOid/i.test(r.stderr ?? '');
  const withoutBase = (fields: string) => fields.split(',').filter((f) => f !== 'baseRefOid').join(',');
  let fields = PR_VIEW_FIELDS;
  let res = view1(fields);
  if (unknownBase(res)) res = view1((fields = withoutBase(fields)));
  if (res.error) throw new Error(`gh: ${res.error.message}`);
  let checksError: string | undefined;
  if (res.status !== 0 && FORBIDDEN.test(res.stderr ?? '')) {
    checksError = reason(res);
    const retry = view1(fields === PR_VIEW_FIELDS ? PR_VIEW_FIELDS_NO_CHECKS : withoutBase(PR_VIEW_FIELDS_NO_CHECKS));
    if (retry.error) throw new Error(`gh: ${retry.error.message}`);
    if (retry.status !== 0) {
      throw new Error(FORBIDDEN.test(retry.stderr ?? '') ? `${reason(retry)} (fails even without check results)` : reason(retry));
    }
    res = retry;
  }
  if (res.status !== 0) throw new Error(reason(res));
  const view = JSON.parse(res.stdout) as GhPrView;
  if (checksError) view.checksError = checksError;
  if (view.state === 'OPEN') {
    const threads = ghUnresolvedThreads(ref);
    if (threads !== undefined) view.unresolvedThreads = threads;
  }
  return view;
}

/** The PR's title alone: one `gh pr view --json title`. Throws gh's reason on failure. */
export function ghPrTitle(ref: PrRef): string {
  const res = spawnSync('gh', ['pr', 'view', String(ref.number), '--repo', `${ref.owner}/${ref.repo}`, '--json', 'title'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (res.error) throw new Error(`gh: ${res.error.message}`);
  if (res.status !== 0) throw new Error(firstMeaningfulLine(res.stderr) ?? `gh exited ${res.status}`);
  const title = (JSON.parse(res.stdout) as { title?: unknown }).title;
  if (typeof title !== 'string') throw new Error('gh returned no title');
  return title;
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

/**
 * GitHub merge states under which an open PR can merge. CLEAN is the plain
 * case; HAS_HOOKS is clean with pre-receive hooks; UNSTABLE is mergeable with
 * non-required checks failing — those failures already stand as pr:checks,
 * so they do not also withhold ready. DIRTY (conflicts), BEHIND, BLOCKED,
 * UNKNOWN, and an unobserved '' never yield ready.
 */
export const MERGEABLE_STATES: ReadonlySet<string> = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE']);

/** True when the observed merge state lets the PR merge (see MERGEABLE_STATES). */
export function isMergeable(mergeStateStatus: string | undefined): boolean {
  return MERGEABLE_STATES.has((mergeStateStatus ?? '').toUpperCase());
}

/** True when GitHub reports the PR conflicting with its base. */
export function isConflicting(mergeStateStatus: string | undefined): boolean {
  return (mergeStateStatus ?? '').toUpperCase() === 'DIRTY';
}

export interface PrBadge {
  text: string;
  tone: 'ok' | 'warn' | 'bad' | 'dim';
  /** GitHub's PR state, which the glass colors the way GitHub does (merged purple, open green, draft grey, closed red). */
  state: 'open' | 'draft' | 'merged' | 'closed';
  /** Set when the badge is about the merge state: the glass fills `conflicts` GitHub red and `behind` grey. */
  merge?: 'conflicts' | 'behind';
}

/**
 * The one-word PR state shown by tend, catch, and the glass — one
 * derivation so the three never disagree. Terminal first, then what blocks
 * a merge, in the order a human would act on it: a conflict first (a rebase
 * reruns everything after it), then checks and review. `green` only when the
 * merge state is mergeable, so the badge never reads ready where tend's
 * pr:ready would not stand.
 */
export function prBadge(pr: PrEvidence): PrBadge {
  if (pr.state === 'MERGED') return { text: 'merged', tone: 'ok', state: 'merged' };
  if (pr.state === 'CLOSED') return { text: 'closed', tone: 'bad', state: 'closed' };
  if (pr.repair?.status === 'repairing' && pr.repair.headSha === pr.headSha) {
    const { kind, attempts, maxAttempts } = pr.repair;
    return { text: `repairing: ${kind} (attempt ${attempts} of ${maxAttempts ?? 2})`, tone: 'warn', state: 'open' };
  }
  const badge = openBadge(pr);
  if (pr.repair?.status === 'waiting' && pr.repair.headSha === pr.headSha && badge.state === 'open') {
    return { ...badge, text: `${badge.text} · repair waits: ${pr.repair.heldBy ?? 'held'}` };
  }
  return badge;
}

function openBadge(pr: PrEvidence): PrBadge {
  const { total, failed, pending, passed } = pr.checks;
  const merge = (pr.mergeStateStatus ?? '').toUpperCase();
  if (pr.draft) return { text: 'draft', tone: 'dim', state: 'draft' };
  if (merge === 'DIRTY') return { text: 'conflicts', tone: 'bad', state: 'open', merge: 'conflicts' };
  if (failed > 0) return { text: `checks ${failed}/${total} failed`, tone: 'bad', state: 'open' };
  if (pr.reviewDecision === 'CHANGES_REQUESTED' || pr.review?.changesRequested)
    return { text: 'changes requested', tone: 'bad', state: 'open' };
  const threads = pr.review?.unresolvedThreads ?? 0;
  if (threads > 0) return { text: `${threads} unresolved`, tone: 'warn', state: 'open' };
  if (pr.checks.unknown) return { text: 'checks unknown', tone: 'warn', state: 'open' };
  if (pending > 0) return { text: `checks ${passed}/${total}`, tone: 'warn', state: 'open' };
  if (merge === 'BEHIND') return { text: 'behind', tone: 'dim', state: 'open', merge: 'behind' };
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return { text: 'review', tone: 'warn', state: 'open' };
  if (MERGEABLE_STATES.has(merge)) return { text: 'green', tone: 'ok', state: 'open' };
  if (merge === 'BLOCKED') return { text: 'blocked', tone: 'warn', state: 'open' };
  return { text: 'merge unknown', tone: 'dim', state: 'open' };
}

/** The continuation brief for PR events that are work: a failed check or a review decision. */
export function prFixBrief(ref: PrRef): string {
  return `The pull request ${ref.url} (${ref.key}) needs work:

{summaries}

For a failed check: read its log (the details URL above, or \`gh run view\`), reproduce locally, fix it, and push to the PR's existing branch at the head sha named above — do not open a new PR.
If a failed check cannot pass until a person approves the change, do not try to fix it: name it with \`--human-gate "<check name>"\` on your report, once per check.
For a review decision: read the review with \`gh pr view ${ref.number} --repo ${ref.owner}/${ref.repo} --comments\`, address it, and push to the same branch.
Then report done with the same PR: \`lobstah report <id> done "<note>" --pr ${ref.url}\`.

Raw events:
{events}`;
}

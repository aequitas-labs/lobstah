import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  enqueue,
  loadConfig,
  mergeRequestAuthority,
  stackMergeRevision,
  parsePrRef,
  postNotice,
  prMergeStep,
  readPr,
  readPrs,
  readWatch,
  withPrLock,
  writePr,
  type Config,
  stackMergeStep,
  type PrMergeMethod,
  type PrMergeRequest,
  type PrRecord,
  type StackMergeRequest,
} from '@lobstah/core';
import { githubRepoFromOrigin, loadPickupConfig } from '@lobstah/pick';
import { githubViewer, mayAutoWatch, prAuthorship } from './pr-ownership.js';
import { addPrWatch } from './pr-watch.js';
import { deliverMergeWatchActions } from './watch-sources/merge.js';

/** A merge request the boat refuses, with the HTTP status the glass answers. */
export class PrMergeRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The configured repo whose origin is this forge repo (`owner/repo`), if any. */
export function repoKeyForForge(cfg: Pick<Config, 'repos'>, forgeRepo: string): string | undefined {
  const want = forgeRepo.toLowerCase();
  return Object.entries(cfg.repos).find(([, r]) => r.origin && githubRepoFromOrigin(r.origin)?.toLowerCase() === want)?.[0];
}

/**
 * How a PR in this forge repo merges: its repo's `[repos.<key>].mergeMethod`,
 * else merge commits for lobstah, then `[pickup.github]`, then squash.
 */
export function prMergeMethod(
  cfg: Pick<Config, 'repos'>,
  forgeRepo: string,
  pickup: () => PrMergeMethod | undefined = pickupMergeMethod,
): PrMergeMethod {
  const key = repoKeyForForge(cfg, forgeRepo);
  return (key && cfg.repos[key]?.mergeMethod) || (forgeRepo.split('/').at(-1) === 'lobstah' ? 'merge' : undefined) || pickup() || 'squash';
}

/** pick's method, read at most once a minute: loading pick's config resolves its token, and the glass asks per PR. */
let pickupCache: { at: number; method: PrMergeMethod | undefined } | undefined;
function pickupMergeMethod(now = Date.now()): PrMergeMethod | undefined {
  if (pickupCache && now - pickupCache.at < 60_000) return pickupCache.method;
  let method: PrMergeMethod | undefined;
  try {
    const found = loadPickupConfig().github[0]?.merge.method;
    method = found === 'merge' || found === 'squash' || found === 'rebase' ? found : undefined;
  } catch {
    // No pickup section, or one pick can't load: the default stands.
  }
  pickupCache = { at: now, method };
  return method;
}

/** Options for a merge authorization, shared by the ownership-checked Glass and local helm CLI. */
export interface PrMergeOptions {
  viewer?: () => string | undefined;
  now?: number;
  cfg?: Config;
  method?: PrMergeMethod;
  note?: string;
  hold?: string;
  releaseHold?: boolean;
  /** The local helm CLI explicitly authorized this PR, regardless of its author. */
  authorized?: boolean;
}

/**
 * Record permission to merge an open PR. Glass requests require ownership;
 * the helm CLI supplies explicit authorization. Completed requests retain
 * their provenance and merge SHA until cancelled.
 */
export function requestPrMerge(
  key: string,
  by: string,
  opts: PrMergeOptions = {},
): PrMergeRequest {
  const cfg = opts.cfg ?? loadConfig();
  return withPrLock(key, () => {
    const pr = readPr(key);
    if (!pr) throw new PrMergeRefused(404, 'lobstah has no record of that PR. Watch it first.');
    if (pr.state !== 'OPEN') throw new PrMergeRefused(409, `That PR is ${pr.state.toLowerCase()}.`);
    if (!opts.authorized && !mayAutoWatch(prAuthorship(pr, opts.viewer ?? (() => githubViewer())))) {
      throw new PrMergeRefused(403, 'Only your own PRs, or ones a dispatch opened, merge from the glass.');
    }
    const request: PrMergeRequest = pr.mergeRequest ?? {
      at: new Date(opts.now ?? Date.now()).toISOString(),
      by,
      method: opts.method ?? prMergeMethod(cfg, pr.repo),
    };
    if (opts.method) request.method = opts.method;
    if (opts.note !== undefined) request.note = opts.note;
    if (opts.hold !== undefined) request.hold = opts.hold;
    if (opts.releaseHold) delete request.hold;
    writePr({ ...pr, mergeRequest: request });
    // Its watch checks it every poll; a PR watched by no one yet gets one.
    const ref = parsePrRef(pr.url);
    if (ref && !readWatch(ref.key)) addPrWatch(ref);
    return request;
  });
}

/** Withdraw a PR's merge request. True when there was one. */
export function cancelPrMerge(key: string): boolean {
  return withPrLock(key, () => {
    const pr = readPr(key);
    if (!pr?.mergeRequest) return false;
    const { mergeRequest: _gone, ...rest } = pr;
    writePr(rest);
    return true;
  });
}

/** Whether an open PR sits below this one in its stack: its base is that PR's branch. */
export function openPrBelow(pr: PrRecord, records: readonly PrRecord[]): boolean {
  return records.some((r) => r.key !== pr.key && r.repo === pr.repo && r.state === 'OPEN' && r.headRefName === pr.baseRefName);
}

/** Test seams for the merge pass. */
export interface PrMergeDeps {
  api?: GithubApi;
  /** Scope a recorded source action to one authorization and head. */
  keys?: readonly string[];
  records?: readonly PrRecord[];
  expectedHead?: string;
  authority?: string;
  dispatchId?: string;
  /** Read the outcome of a submission whose response was not persisted. */
  readMerge?: (pr: PrRecord) => { merged: boolean; sha?: string };
  merge?: (pr: PrRecord, method: PrMergeMethod) => { ok: true; sha?: string } | { ok: false; why: string };
  retarget?: (pr: PrRecord, base: string) => { ok: boolean; why?: string };
  now?: number;
}

/** REST merges exactly the checked head; it cannot enable auto-merge or bypass protection. */
function ghMerge(pr: PrRecord, method: PrMergeMethod, api: GithubApi = ghApi): { ok: true; sha?: string } | { ok: false; why: string } {
  const result = api('PUT', `repos/${pr.repo}/pulls/${pr.number}/merge`, { sha: pr.headSha, merge_method: method });
  if (!result.ok) return result;
  if (result.json.merged !== true || typeof result.json.sha !== 'string') {
    return { ok: false, why: String(result.json.message ?? 'GitHub did not confirm the merge.') };
  }
  return { ok: true, sha: result.json.sha };
}

/** Change only the next PR's base; its checks must be observed again before merging. */
function ghRetarget(pr: PrRecord, base: string, api: GithubApi = ghApi): { ok: boolean; why?: string } {
  return api('PATCH', `repos/${pr.repo}/pulls/${pr.number}`, { base });
}

/**
 * The daemon's pass over merge requests, once per tick:
 * - a green, mergeable PR at the bottom of its stack merges with its method;
 * - a failing or conflicting PR is repaired: lobstah's PR repair already
 *   covers a dispatch's PR; for one no dispatch owns, this files one repair
 *   dispatch per head, after which the repair chain takes the next rounds;
 * - a PR whose repair stopped tells the helm once per head;
 * - anything else waits for the next check.
 */
export function mergeRequestedPrs(log: (message: string) => void, deps: PrMergeDeps = {}): void {
  deliverMergeWatchActions(log, { pr: deps });
}

/** Reconcile only the merge request admitted by the source effect handler. */
export function reconcileRequestedPrs(log: (message: string) => void, deps: PrMergeDeps = {}): void {
  const records = deps.records ?? readPrs();
  const cfg = loadConfig();
  for (const record of records) {
    if (!record.mergeRequest || (deps.keys && !deps.keys.includes(record.key))) continue;
    withPrLock(record.key, () => {
      const pr = readPr(record.key);
      const request = pr?.mergeRequest;
      if (!pr || !request || !mergeRequestAuthority(pr.key, request)) return;
      if (deps.expectedHead && pr.headSha !== deps.expectedHead) return;
      if (deps.authority && mergeRequestAuthority(pr.key, request) !== deps.authority) return;
      // A batch fetched before our successful merge can still report OPEN.
      if (request.status === 'merged' && pr.state === 'OPEN') return;
      const failure = pr.mergeStateStatus === 'DIRTY' ? 'conflict' : (pr.checks?.failed ?? 0) > 0 ? 'checks' : undefined;
      if (failure) {
        postNotice({ kind: 'stack-stopped', text: `${pr.key}: merge when green is waiting on ${failure}.`, refId: pr.key,
          dedupeKey: `merge-wait-${pr.key}-${pr.headSha}-${failure}` });
      }
      const step = prMergeStep(pr, openPrBelow(pr, records));
      const retargetChildren = () => {
        let complete = true;
        for (const child of readPrs().filter((p) => p.repo === pr.repo && p.state === 'OPEN' && !!pr.headRefName && p.baseRefName === pr.headRefName && p.key !== pr.key)) {
          if (!pr.baseRefName) { complete = false; continue; }
          const result = (deps.retarget ?? ((child, base) => ghRetarget(child, base, deps.api)))(child, pr.baseRefName);
          if (!result.ok) {
            complete = false;
            postNotice({ kind: 'stack-stopped', text: `Could not retarget ${child.key}: ${result.why ?? 'GitHub refused'}`, refId: child.key,
              dedupeKey: `merge-retarget-${child.key}-${pr.headSha}` });
            continue;
          }
          withPrLock(child.key, () => {
            const current = readPr(child.key);
            if (current) writePr({ ...current, baseRefName: pr.baseRefName, mergeStateStatus: 'UNKNOWN', checks: { ...current.checks, unknown: 'latest run' } });
          });
        }
        return complete;
      };
      if (request.status === 'merging' && pr.state === 'OPEN') {
        const result = deps.readMerge ? deps.readMerge(pr) : (() => {
          const read = (deps.api ?? ghApi)('GET', `repos/${pr.repo}/pulls/${pr.number}`);
          return read.ok ? { merged: read.json.merged === true, sha: typeof read.json.merge_commit_sha === 'string' ? read.json.merge_commit_sha : undefined } : { merged: false };
        })();
        if (!result.merged) {
          log(`${pr.key}: merge submission outcome is not confirmed; checking again next tick`);
          return;
        }
        const mergedAt = new Date(deps.now ?? Date.now()).toISOString();
        writePr({ ...pr, state: 'MERGED', mergedAt, mergeRequest: { ...request, status: 'merged', mergeSha: result.sha, mergedAt, retargetPending: true } });
        const complete = retargetChildren(), merged = readPr(pr.key)!;
        writePr({ ...merged, mergeRequest: { ...merged.mergeRequest!, retargetPending: !complete } });
        postNotice({ kind: 'pr-merged', text: `Merged ${pr.key} (${request.method})${result.sha ? ` at ${result.sha}` : ''}, authorized by ${request.by}.`,
          refId: pr.key, dedupeKey: `merge-complete-${pr.key}-${pr.headSha}` });
        log(`recovered accepted merge for ${pr.key} without submitting again`);
        return;
      }
      if (step.kind === 'done') {
        if (pr.state === 'MERGED') {
          const complete = request.retargetPending ? retargetChildren() : true;
          writePr({ ...pr, mergeRequest: { ...request, status: 'merged', retargetPending: !complete } });
        } else {
          const { mergeRequest: _done, ...rest } = pr;
          writePr(rest);
        }
        return;
      }
      if (step.kind === 'merge') {
        writePr({ ...pr, mergeRequest: { ...request, status: 'merging', error: undefined } });
        const result = (deps.merge ?? ((pr, method) => ghMerge(pr, method, deps.api)))(pr, request.method);
        if (result.ok) {
          log(`merged ${pr.key} (${request.method}), as authorized by ${request.by}`);
          const mergedAt = new Date(deps.now ?? Date.now()).toISOString();
          // Persist completion before retargeting, so a restart cannot submit a second merge.
          writePr({ ...pr, state: 'MERGED', mergedAt, mergeRequest: { ...request, status: 'merged', mergeSha: result.sha, mergedAt, retargetPending: true } });
          const complete = retargetChildren();
          const merged = readPr(pr.key)!;
          writePr({ ...merged, mergeRequest: { ...merged.mergeRequest!, retargetPending: !complete } });
          postNotice({ kind: 'pr-merged', text: `Merged ${pr.key} (${request.method})${result.sha ? ` at ${result.sha}` : ''}, authorized by ${request.by}.`,
            refId: pr.key, dedupeKey: `merge-complete-${pr.key}-${pr.headSha}` });
        } else {
          writePr({ ...pr, mergeRequest: { ...request, status: 'failed', error: result.why } });
          postNotice({ kind: 'stack-stopped', text: `Could not merge ${pr.key}: ${result.why}`, refId: pr.key,
            dedupeKey: `merge-refused-${pr.key}-${pr.headSha}-${result.why}` });
          log(`could not merge ${pr.key}, will try again: ${result.why}`);
        }
        return;
      }
      if (step.kind === 'wait') {
        if (request.status !== 'waiting') writePr({ ...pr, mergeRequest: { ...request, status: 'waiting', error: undefined } });
        return;
      }
      if (step.kind === 'stuck') {
        if (request.stuckHeadSha === pr.headSha) return;
        writePr({ ...pr, mergeRequest: { ...request, stuckHeadSha: pr.headSha } });
        postNotice({
          kind: 'repair-stopped',
          text: `#${pr.number} ${pr.title ?? ''}: asked to merge when green, but its repair stopped (${step.why}). It needs you. (${pr.url})`.replace(
            / +/g,
            ' ',
          ),
          refId: pr.key,
          dedupeKey: `merge-stuck-${pr.key}-${pr.headSha}`,
        });
        return;
      }
      if (step.kind === 'repair') {
        // A dispatch's PR: the daemon's PR repair already works it ([watch].autoRepair).
        if (pr.dispatches.length > 0) return;
        // One repair dispatch per head. Once it reports this PR, the PR is a dispatch's and its chain takes the next rounds.
        if (request.repair?.headSha === pr.headSha) return;
        const repo = repoKeyForForge(cfg, pr.repo);
        if (!repo) {
          log(`cannot repair ${pr.key} for its merge: no configured repo has ${pr.repo} as its origin`);
          return;
        }
        const id = deps.dispatchId ?? randomUUID();
        enqueue({ id, repo, trapAny: true, brief: repairBrief(pr, step.why) });
        writePr({ ...pr, mergeRequest: { ...request, repair: { dispatchId: id, headSha: pr.headSha } } });
        log(`filed repair ${id.slice(0, 8)} for ${pr.key} (${step.why}), so its merge can go ahead`);
      }
    });
  }
}

/** The brief for a repair of a PR no dispatch owns. */
export function repairBrief(pr: PrRecord, why: 'checks' | 'conflict'): string {
  const what =
    why === 'conflict'
      ? `It conflicts with its base, \`${pr.baseRefName}\`. Merge \`${pr.baseRefName}\` into it with a merge commit and resolve the conflicts.`
      : `Its checks fail${pr.failingChecks?.length ? `: ${pr.failingChecks.map((c) => c.name).join(', ')}` : ''}. Find why, and fix it.`;
  return [
    `# Get #${pr.number} green so it merges`,
    '',
    `Chris asked the glass to merge ${pr.url} (${pr.title ?? 'untitled'}) once it's green. ${what}`,
    '',
    `- Work on its branch, \`${pr.headRefName}\`, and push to it. Don't open a new PR, rebase or force-push.`,
    `- Keep the change to what makes it green.`,
    `- Report \`done --pr ${pr.url}\` once it's pushed. lobstah merges it when its checks pass.`,
  ].join('\n');
}

/**
 * A stack's PRs bottom first, from its bottom PR: each next one is the PR in
 * the same repo whose base is the branch of the one below. A fork in the
 * chain (two PRs on one branch) ends it there.
 */
export function stackChain(root: PrRecord, records: readonly PrRecord[]): PrRecord[] {
  const chain = [root];
  for (;;) {
    const top = chain.at(-1)!;
    const next = records.filter((r) => r.repo === top.repo && !!top.headRefName && r.baseRefName === top.headRefName && !chain.includes(r));
    if (next.length !== 1) return chain;
    chain.push(next[0]!);
  }
}

/**
 * Ask the boat to merge a whole stack once every PR in it is green
 * (`stack-merge`). The stack is named by its bottom PR's key, as the glass
 * names it, and must hold several PRs that are all the person's own or a
 * dispatch's. The request lives on the bottom PR's record until the stack
 * has merged, one PR closes, GitHub refuses, or `cancelStackMerge`.
 */
export function requestStackMerge(
  stackKey: string,
  by: string,
  opts: { viewer?: () => string | undefined; now?: number; cfg?: Config; records?: PrRecord[] } = {},
): StackMergeRequest {
  const cfg = opts.cfg ?? loadConfig();
  const records = opts.records ?? readPrs();
  return withPrLock(stackKey, () => {
    const root = readPr(stackKey);
    if (!root) throw new PrMergeRefused(404, 'lobstah has no record of that stack.');
    const members = stackChain(root, records);
    const open = members.filter((p) => p.state === 'OPEN');
    if (members.length < 2) throw new PrMergeRefused(409, 'That is a lone PR: use Merge when green on it.');
    if (!open.length) throw new PrMergeRefused(409, 'That stack has nothing left to merge.');
    const viewer = opts.viewer ?? (() => githubViewer());
    if (!open.every((p) => mayAutoWatch(prAuthorship(p, viewer)))) {
      throw new PrMergeRefused(403, "Only stacks of your own PRs, or a dispatch's, merge from the glass.");
    }
    const request: StackMergeRequest = root.stackMergeRequest ?? {
      at: new Date(opts.now ?? Date.now()).toISOString(),
      by,
      method: prMergeMethod(cfg, root.repo),
      numbers: members.map((p) => p.number),
    };
    writePr({ ...root, stackMergeRequest: request });
    // Each PR's watch checks it every poll; a PR watched by no one yet gets one.
    for (const p of open) {
      const ref = parsePrRef(p.url);
      if (ref && !readWatch(ref.key)) addPrWatch(ref);
    }
    return request;
  });
}

/**
 * Withdraw a stack's merge request: `cancelled`, `none` when there was none,
 * or `merging` once GitHub has taken the merge, which can't be called back.
 */
export function cancelStackMerge(stackKey: string): 'cancelled' | 'none' | 'merging' {
  return withPrLock(stackKey, () => {
    const pr = readPr(stackKey);
    if (!pr?.stackMergeRequest) return 'none';
    if (pr.stackMergeRequest.merging || pr.stackMergeRequest.submission) return 'merging';
    const { stackMergeRequest: _gone, ...rest } = pr;
    writePr(rest);
    return 'cancelled';
  });
}

/** One GitHub REST call: its JSON, or why it failed. */
export type GithubApi = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  path: string,
  body?: unknown,
) => { ok: true; json: Record<string, unknown> } | { ok: false; why: string };

/** `gh api`, signed in as the person, with the body on stdin. */
function ghApi(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown): ReturnType<GithubApi> {
  const res = spawnSync('gh', ['api', '-X', method, path, ...(body === undefined ? [] : ['--input', '-'])], {
    encoding: 'utf8',
    input: body === undefined ? undefined : JSON.stringify(body),
    timeout: 60_000,
    windowsHide: true,
  });
  if (res.status !== 0) return { ok: false, why: (res.stderr || res.stdout || `gh exited ${res.status}`).trim().split('\n')[0]! };
  try {
    return { ok: true, json: res.stdout.trim() ? (JSON.parse(res.stdout) as Record<string, unknown>) : {} };
  } catch {
    return { ok: false, why: 'GitHub answered with something that is not JSON.' };
  }
}

/** Test seams for the stack merge pass. */
export interface StackMergeDeps {
  api?: GithubApi;
  /** A source receipt binds the stored request and every member head. */
  keys?: readonly string[];
  expectedRevision?: string;
  authority?: string;
  dispatchId?: string;
  now?: number;
}

/**
 * The daemon's pass over stack merge requests, once per tick, for each
 * stack's bottom PR that holds one:
 * - once GitHub has taken the merge, read its result: merged clears the
 *   request when every PR merged; failed tells the helm and clears it;
 * - every PR merged clears it; a PR closed unmerged tells the helm and clears it;
 * - a red check or a conflict on a PR no dispatch owns files one repair per
 *   head, as a single PR's merge does; a stuck repair tells the helm once;
 * - once every open PR is green: link a plain stack on GitHub
 *   (`POST repos/<repo>/stacks`, the call `gh stack submit` makes, so no
 *   branch is checked out, rebased or pushed), then ask GitHub to merge the
 *   top PR with everything under it (`PUT pulls/<top>/merge-async`), the
 *   repo's way, on the head that was checked.
 */
export function mergeRequestedStacks(log: (message: string) => void, deps: StackMergeDeps = {}): void {
  deliverMergeWatchActions(log, { stack: deps });
}

/** Reconcile a source-authorized stack while retaining the existing native merge path. */
export function reconcileRequestedStacks(log: (message: string) => void, deps: StackMergeDeps = {}): void {
  const api = deps.api ?? ghApi;
  const cfg = loadConfig();
  for (const record of readPrs()) {
    if (!record.stackMergeRequest || (deps.keys && !deps.keys.includes(record.key))) continue;
    withPrLock(record.key, () => {
      const root = readPr(record.key);
      const request = root?.stackMergeRequest;
      if (!root || !request || !mergeRequestAuthority(root.key, request)) return;
      if (deps.authority && mergeRequestAuthority(root.key, request) !== deps.authority) return;
      if (deps.expectedRevision && stackMergeRevision(root, readPrs()) !== deps.expectedRevision) return;
      const save = (patch: Partial<StackMergeRequest>) => writePr({ ...root, stackMergeRequest: { ...request, ...patch } });
      const clear = () => {
        const { stackMergeRequest: _gone, ...rest } = root;
        writePr(rest);
      };
      const tell = (why: string, end: boolean) => {
        const text = `Stack through #${request.numbers.at(-1)} (${root.repo}): ${why}`;
        if (request.stuck !== why) {
          log(text);
          postNotice({ kind: 'stack-stopped', text, refId: root.key, dedupeKey: `stack-merge-${root.key}-${why}` });
        }
        if (end) clear();
        else if (request.stuck !== why) save({ stuck: why });
      };
      const members = request.numbers.map((n) => (n === root.number ? root : readPr(`pr:${root.repo}#${n}`)));
      if (members.some((m) => !m)) return tell('lobstah lost track of a PR in it; ask again from the glass.', true);
      const prs = members as PrRecord[];
      const step = stackMergeStep(prs);
      if (step.kind === 'done') {
        log(`merged the stack through #${request.numbers.at(-1)} (${root.repo}), as asked from the glass`);
        return clear();
      }
      if (step.kind === 'closed') return tell(`#${step.number} closed without merging, so the stack merge stopped.`, true);
      if (request.merging) {
        if (request.merging.id === 'merged') return;
        const result = api(
          'GET',
          `repos/${root.repo}/pulls/${request.merging.number}/merge-async/${encodeURIComponent(request.merging.id)}`,
        );
        if (!result.ok) return log(`could not read the stack merge through #${request.merging.number}, will try again: ${result.why}`);
        if (result.json.status === 'failed') {
          const details = result.json.details as { message?: string } | undefined;
          return tell(`GitHub refused the merge: ${details?.message ?? 'no reason given'}.`, true);
        }
        // Pending or queued: the PRs' own records say when each merges.
        return;
      }
      if (request.submission) {
        const result = api('GET', `repos/${root.repo}/pulls/${request.submission.number}`);
        if (result.ok && result.json.merged === true) {
          save({ submission: undefined, merging: { ...request.submission, id: 'merged' } });
          log(`recovered accepted stack merge through #${request.submission.number} without submitting again`);
        } else log(`stack through #${request.submission.number}: submission outcome is not confirmed; checking again next tick`);
        return;
      }
      if (step.kind === 'stuck') return tell(`${step.why}. It needs you.`, false);
      if (step.kind === 'wait') return;
      if (step.kind === 'repair') {
        const pr = step.pr;
        // A dispatch's PR: the daemon's PR repair already works it ([watch].autoRepair).
        if (pr.dispatches.length > 0) return;
        if (request.repairs?.[pr.number] === pr.headSha) return;
        const repo = repoKeyForForge(cfg, pr.repo);
        if (!repo) return log(`cannot repair ${pr.key} for its stack's merge: no configured repo has ${pr.repo} as its origin`);
        const id = deps.dispatchId ?? randomUUID();
        enqueue({ id, repo, trapAny: true, brief: repairBrief(pr, step.why) });
        save({ repairs: { ...request.repairs, [pr.number]: pr.headSha } });
        return log(`filed repair ${id.slice(0, 8)} for ${pr.key} (${step.why}), so its stack can merge`);
      }
      // Every open PR is green: link the stack on GitHub if it isn't, then merge the top.
      const top = prs.filter((p) => p.state === 'OPEN').at(-1)!;
      let linked = request.linked;
      if (!linked) {
        const pull = api('GET', `repos/${root.repo}/pulls/${top.number}`);
        linked = pull.ok ? stackNumber(pull.json.stack) : undefined;
        if (!linked) {
          const made = api('POST', `repos/${root.repo}/stacks`, {
            pull_requests: prs.filter((p) => p.state === 'OPEN').map((p) => p.number),
          });
          if (!made.ok) return tell(`it could not be linked as a stack on GitHub: ${made.why}`, true);
          linked = stackNumber(made.json) ?? stackNumber(made.json.stack);
          if (!linked) return tell('GitHub linked no stack for it.', true);
          log(`linked ${root.repo} #${prs[0]!.number}..#${top.number} as stack ${linked} on GitHub, to merge it`);
        }
      }
      // Persist intent before the remote call: a lost response must never submit twice.
      const submission = { number: top.number, headSha: top.headSha, at: new Date(deps.now ?? Date.now()).toISOString() };
      save({ linked, submission });
      const merge = api('PUT', `repos/${root.repo}/pulls/${top.number}/merge-async`, {
        merge_method: request.method,
        sha: top.headSha,
        merge_action: 'default',
      });
      if (!merge.ok) {
        save({ linked, submission: undefined });
        return log(`could not ask GitHub to merge the stack through #${top.number}, will try again: ${merge.why}`);
      }
      const details = merge.json.details as { uuid?: string; message?: string } | undefined;
      if (merge.json.status === 'failed') return tell(`GitHub refused the merge: ${details?.message ?? 'no reason given'}.`, true);
      if (merge.json.status === 'merged') {
        log(`GitHub merged the stack through #${top.number} (${root.repo}), as asked from the glass`);
        return save({
          linked,
          submission: undefined,
          merging: {
            id: details?.uuid ?? 'merged',
            number: top.number,
            headSha: top.headSha,
            at: new Date(deps.now ?? Date.now()).toISOString(),
          },
        });
      }
      if (!details?.uuid) return log(`GitHub took the stack merge through #${top.number} but named no id; checking its disposition next tick`);
      save({
        linked,
        submission: undefined,
        merging: { id: details.uuid, number: top.number, headSha: top.headSha, at: new Date(deps.now ?? Date.now()).toISOString() },
      });
      log(`asked GitHub to merge the stack through #${top.number} (${root.repo}) as ${request.method}, as asked from the glass`);
    });
  }
}

/** A stack's number from GitHub's answer: `{ number }`, else none. */
function stackNumber(value: unknown): number | undefined {
  const n = (value as { number?: unknown } | null | undefined)?.number;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined;
}

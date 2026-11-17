import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { githubBlockedUntil, latestRound, loadConfig, markReviewPosted, readReview, recordGitHubResponse, recordGitHubRateLimit, reviewMarker, reviewRoundDir, reviewSettings, writeReview } from '@lobstah/core';
import type { ReviewItem } from '@lobstah/core';
import type { FetchLike } from './reviews-post.js';

const exec = promisify(execFile);
const sha = /^[a-f0-9]{40,64}$/;

/** Verify the update against Git's merge result, including changes that have landed in the base. */
export function onlyBaseUpdate(cwd: string, approved: string, head: string, base: string): boolean {
  if (![approved, head, base].every(value => sha.test(value)) || approved === head) return false;
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    if (result.status !== 0) throw new Error('Cannot verify base update');
    return result.stdout.trim();
  };
  try {
    const incorporatedBase = git('merge-base', base, head);
    // A base must actually have advanced since the approved head.
    if (git('merge-base', approved, incorporatedBase) === incorporatedBase) return false;
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', approved, head], { cwd, windowsHide: true });
    if (ancestor.status === 0) {
      // Walk the PR's first-parent chain: every intervening commit must
      // merge a base ancestor. An edit followed by a revert is not eligible.
      let cursor = head;
      while (cursor !== approved) {
        const parents = git('show', '-s', '--format=%P', cursor).split(' ');
        if (parents.length !== 2) return false;
        if (spawnSync('git', ['merge-base', '--is-ancestor', parents[1]!, base], { cwd, windowsHide: true }).status !== 0) return false;
        cursor = parents[0]!;
      }
    } else if (ancestor.status === 1) {
      // A rebase rewrites the PR commits on the newer base, without merges.
      if (git('rev-list', '--merges', `${incorporatedBase}..${head}`)) return false;
    } else return false;
    // Equal trees give equal base..head patches, including binary and
    // whitespace changes. A clean merge proves disappearing changes are
    // supplied by base (for example, a stacked parent that landed);
    // conflict resolutions or new edits cannot match this tree.
    const expectedTree = git('-c', 'core.hooksPath=', 'merge-tree', '--write-tree', approved, incorporatedBase).split('\n')[0];
    return expectedTree === git('rev-parse', `${head}^{tree}`);
  } catch { return false; }
}

const verifiedUpdates = new Map<string, boolean>();

export async function verifiedBaseUpdate(item: ReviewItem, approved: string, token: string): Promise<boolean> {
  if (![approved, item.pr.headSha, item.pr.baseSha ?? ''].every(value => sha.test(value))) return false;
  const key = `${item.key}:${approved}:${item.pr.headSha}:${item.pr.baseSha}`;
  const cached = verifiedUpdates.get(key);
  if (cached !== undefined) return cached;
  const remember = (result: boolean) => {
    if (verifiedUpdates.size >= 100) verifiedUpdates.delete(verifiedUpdates.keys().next().value!);
    verifiedUpdates.set(key, result);
    return result;
  };
  const local = item.pr.repoKey && loadConfig().repos[item.pr.repoKey]?.path;
  if (local && [approved, item.pr.headSha, item.pr.baseSha!].every(sha => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: local, stdio: 'ignore', timeout: 10_000, windowsHide: true }).status === 0))
    return remember(onlyBaseUpdate(local, approved, item.pr.headSha, item.pr.baseSha!));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-reapprove-'));
  try {
    await exec('git', ['init', '--bare', dir], { timeout: 10_000, windowsHide: true });
    // Fetch into a disposable object store: no checkout, hooks, or changes
    // to the person's repo. Pass credentials in the environment only.
    await exec('git', ['-C', dir, 'fetch', '--no-tags', `https://github.com/${item.pr.owner}/${item.pr.repo}.git`, approved, item.pr.headSha, item.pr.baseSha!], {
      timeout: 45_000, windowsHide: true, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` },
    });
    return remember(onlyBaseUpdate(dir, approved, item.pr.headSha, item.pr.baseSha!));
  } catch { return false; }
  finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

interface Review { id: number; state: string; submitted_at: string; commit_id: string; user: { login: string } | null; body?: string }
interface Comment { created_at: string; updated_at: string }
interface Pull { state: string; draft: boolean; head: { sha: string }; base: { sha: string }; requested_reviewers: Array<{ login: string }> }
interface Options {
  token: () => string; fetch?: FetchLike; now: number; log: (message: string) => void;
  verify?: (item: ReviewItem, approved: string, token: string) => Promise<boolean>;
}

/** Reuse only this identity's approval, with fresh complete feedback and head checks before posting. */
export async function reapproveBaseUpdate(item: ReviewItem, identity: string, opts: Options): Promise<void> {
  const round = latestRound(item);
  if (!round || (round.wharf && !round.wharf.mine) || item.mutedAt || !item.pr.baseSha || !sha.test(item.pr.headSha) || githubBlockedUntil(opts.now)) return;
  const cfg = loadConfig();
  const repoKey = item.pr.repoKey;
  const inGrounds = repoKey && Object.values(cfg.grounds).some(grounds => grounds.repos.includes(repoKey));
  const enabled = inGrounds && reviewSettings(cfg.reviews, repoKey).autoReapproveBaseOnly;
  const accessToken = opts.token();
  const f: FetchLike = opts.fetch ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }));
  const root = `https://api.github.com/repos/${item.pr.owner}/${item.pr.repo}/pulls/${item.pr.number}`;
  const api = async <T>(url: string, body?: unknown): Promise<T> => {
    if (githubBlockedUntil(opts.now)) throw new Error('GitHub budget blocked');
    const response = await f(url, { method: body ? 'POST' : 'GET', headers: {
      authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'lobstah-pick',
      ...(body ? { 'content-type': 'application/json' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    recordGitHubResponse(headers, { now: opts.now, success: response.ok });
    if (response.status === 429 || (response.status === 403 && (headers['retry-after'] || headers['x-ratelimit-remaining'] === '0')))
      recordGitHubRateLimit(opts.now, Number(headers['retry-after']) > 0 ? opts.now + Number(headers['retry-after']) * 1000 : undefined);
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    return await response.json() as T;
  };
  const all = async <T>(url: string): Promise<T[]> => {
    const rows: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await api<T[]>(`${url}?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('Incomplete GitHub feedback');
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
    throw new Error('Incomplete GitHub feedback');
  };
  const save = () => writeReview({ ...item, updatedAt: new Date(opts.now).toISOString() });
  const needsReview = () => {
    if (round.reReview?.headSha !== item.pr.headSha) {
      round.reReview = { headSha: item.pr.headSha, at: new Date(opts.now).toISOString() };
      delete round.seenAt; delete round.acknowledgedAt;
      save();
    }
  };
  try {
    needsReview();
    const reviews = await all<Review>(`${root}/reviews`);
    const mine = reviews.filter(review => review.user?.login.toLowerCase() === identity.toLowerCase() && review.state !== 'PENDING')
      .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at) || a.id - b.id).at(-1);
    if (!mine) return;
    if (mine.commit_id === item.pr.headSha) {
      const approvedHead = /^Re-approving: only the base branch was merged in since my approval at ([a-f0-9]{40,64});/.exec(mine.body ?? '')?.[1];
      const automatic = mine.state === 'APPROVED' && approvedHead && mine.body?.includes(reviewMarker(round.id));
      if (automatic && !round.autoReapprovals?.some(receipt => receipt.reviewId === String(mine.id))) {
        round.autoReapprovals = [...(round.autoReapprovals ?? []), { headSha: item.pr.headSha, approvedHeadSha: approvedHead, reviewId: String(mine.id), at: mine.submitted_at }];
        save();
      }
      if (round.reReview || automatic) {
        if (['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'].includes(mine.state))
          markReviewPosted(item.key, round.id, { reviewId: String(mine.id), by: automatic ? 'auto re-approval' : 'review tool', at: mine.submitted_at,
            verdict: mine.state === 'APPROVED' ? 'approve' : mine.state === 'CHANGES_REQUESTED' ? 'request_changes' : 'comment' });
        else { delete round.reReview; save(); }
      }
      return;
    }
    if (!enabled || mine.state !== 'APPROVED' || !sha.test(mine.commit_id) || !Number.isFinite(Date.parse(mine.submitted_at))) return;
    const fresh = await api<Pull>(root);
    const ready = (pr: Pull) => pr.state === 'open' && pr.draft === false && pr.head.sha === item.pr.headSha && pr.base.sha === item.pr.baseSha;
    if (!ready(fresh)) return;
    const feedbackClear = async () => {
      const reviews = await all<Review>(`${root}/reviews`);
      const comments = await all<Comment>(`${root}/comments`);
      const discussion = await all<Comment>(root.replace('/pulls/', '/issues/') + '/comments');
      const since = Date.parse(mine.submitted_at);
      return reviews.some(review => review.id === mine.id && review.state === 'APPROVED') &&
        !reviews.some(review => review.id !== mine.id && (Date.parse(review.submitted_at) > since || (Date.parse(review.submitted_at) === since && review.id > mine.id))) &&
        ![...comments, ...discussion].some(comment => !Number.isFinite(Date.parse(comment.updated_at)) || Date.parse(comment.updated_at) > since || Date.parse(comment.created_at) > since);
    };
    if (!await feedbackClear()) return;
    if ((await api<{ login: string }>('https://api.github.com/user')).login?.toLowerCase() !== identity.toLowerCase()) return;
    if (!await (opts.verify ?? verifiedBaseUpdate)(item, mine.commit_id, accessToken)) return;
    if (!await feedbackClear() || !ready(await api<Pull>(root))) return;
    // Recheck policy and round ownership after network awaits.
    const current = readReview(item.key);
    const settings = loadConfig();
    if (!Object.values(settings.grounds).some(grounds => grounds.repos.includes(repoKey!)) || !settings.reviews.enabled || !reviewSettings(settings.reviews, repoKey).autoReapproveBaseOnly || current?.mutedAt ||
        current?.pr.headSha !== item.pr.headSha || latestRound(current)?.id !== round.id) return;
    const dir = reviewRoundDir(item.key, round.id)!;
    fs.mkdirSync(dir, { recursive: true });
    const receipt = path.join(dir, `reapprove-${item.pr.headSha}.json`);
    try { fs.writeFileSync(receipt, JSON.stringify({ startedAt: new Date(opts.now).toISOString() }), { flag: 'wx' }); }
    catch { return; } // An uncertain write is never repeated automatically.
    const result = await api<{ id: number; html_url: string; submitted_at: string }>(`${root}/reviews`, {
      commit_id: item.pr.headSha, event: 'APPROVE',
      body: `Re-approving: only the base branch was merged in since my approval at ${mine.commit_id}; the PR's changes are unchanged.\n\n${reviewMarker(round.id)}\n<!-- lobstah -->`,
    });
    const at = result.submitted_at;
    const freshItem = readReview(item.key)!;
    const freshRound = latestRound(freshItem)!;
    freshRound.autoReapprovals = [...(freshRound.autoReapprovals ?? []), { headSha: item.pr.headSha, approvedHeadSha: mine.commit_id, reviewId: String(result.id), at }];
    writeReview(freshItem);
    markReviewPosted(item.key, round.id, { reviewId: String(result.id), by: 'auto re-approval', at, verdict: 'approve', event: 'APPROVE' });
    fs.writeFileSync(receipt, JSON.stringify({ reviewId: result.id, at }));
    opts.log(`${item.key}: automatically re-approved unchanged PR changes (${result.id})`);
  } catch (error) {
    needsReview();
    opts.log(`${item.key}: re-approval deferred: ${error instanceof Error ? error.message : String(error)}`);
  }
}

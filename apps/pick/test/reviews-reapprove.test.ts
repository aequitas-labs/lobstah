import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, latestRound, observeReviewRequest, readReview, refreshReviewNotifications, reviewSettings, loadConfig, writeReview } from '@lobstah/core';
import { reviewsLoop } from '../src/loops/reviews.js';
import { onlyBaseUpdate, reapproveBaseUpdate } from '../src/reviews-reapprove.js';
import type { FetchLike } from '../src/reviews-post.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let repo: string;
const KEY = 'review:acme/web#1';
const AT = '2026-11-17T20:17:00Z';
const NOW = Date.parse('2026-11-17T21:00:00Z');
function git(...args: string[]) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function commit(file: string, contents: string) {
  fs.writeFileSync(path.join(repo, file), contents);
  git('add', file); git('commit', '-m', 'fixture');
  return git('rev-parse', 'HEAD');
}
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-reapproval-test-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  repo = path.join(home, 'repo'); fs.mkdirSync(repo);
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\nmode = "on-demand"\n[repos.lobstah]\npath = "/w"\norigin = "https://github.com/acme/web.git"\n[grounds.home]\nrepos = ["lobstah"]\n');
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });
function history() {
  const original = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const base = commit('code', original);
  git('checkout', '-b', 'parent');
  const parent = commit('parent', 'stacked change\n');
  git('checkout', '-b', 'topic');
  const approved = commit('code', original.replace('line 25', 'PR change'));
  git('checkout', 'main');
  git('merge', '--no-ff', 'parent', '-m', 'Merge parent');
  const nextBase = commit('code', 'new base line\n' + original.replace('line 22', 'base context changed'));
  git('checkout', 'topic'); git('merge', '--no-ff', 'main', '-m', 'Merge main');
  const merged = git('rev-parse', 'HEAD');
  return { base, parent, approved, nextBase, merged };
}
function item(approved: string, head: string, base: string) {
  const result = observeReviewRequest({ pr: { owner: 'acme', repo: 'web', number: 1, url: 'https://github.com/acme/web/pull/1', title: 'PR', author: 'dana', repoKey: 'lobstah', headSha: head, baseSha: base, state: 'OPEN' }, round: { id: 'RRE_1', requestedAt: AT } }, NOW).item;
  Object.assign(latestRound(result)!, { state: 'posted', headSha: approved, verdict: 'approve', postedAt: AT });
  writeReview(result);
  return result;
}
function remote(approved: string, head: string, base: string, change: { comments?: boolean; review?: string; draft?: boolean; state?: string; moved?: boolean; request?: boolean } = {}) {
  let reads = 0;
  const reviews = [{ id: 10, state: change.review ?? 'APPROVED', submitted_at: AT, commit_id: approved, user: { login: 'chris' } }];
  const f = vi.fn<FetchLike>(async (url, init) => {
    if (url === 'https://api.github.com/user') return new Response(JSON.stringify({ login: 'chris' }));
    if (init.method === 'POST') return new Response(JSON.stringify({ id: 20, submitted_at: new Date(NOW).toISOString() }));
    if (url.includes('/reviews?')) return new Response(JSON.stringify(reviews));
    if (url.includes('/comments?')) return new Response(JSON.stringify(change.comments ? [{ created_at: '2026-11-17T20:30:00Z', updated_at: '2026-11-17T20:30:00Z' }] : []));
    reads++;
    return new Response(JSON.stringify({ state: change.state ?? 'open', draft: change.draft ?? false, head: { sha: change.moved && reads > 1 ? 'f'.repeat(40) : head }, base: { sha: base }, requested_reviewers: change.request === false ? [] : [{ login: 'chris' }] }));
  });
  return f;
}
async function attempt(approved: string, head: string, base: string, f = remote(approved, head, base)) {
  await reapproveBaseUpdate(item(approved, head, base), 'chris', { token: () => 'token', fetch: f, now: NOW, log: () => {}, verify: async (pr, approved) => onlyBaseUpdate(repo, approved, pr.pr.headSha, pr.pr.baseSha!) });
  return f;
}
const posts = (f: ReturnType<typeof remote>) => f.mock.calls.filter(([, init]) => init.method === 'POST');

describe('base-only re-approval', () => {
  it('re-approves a base merge with a stacked parent now in base and shifted context, recording its review link', async () => {
    const h = history();
    expect(git('diff', '--name-only', `${h.base}...${h.approved}`)).toContain('parent');
    expect(git('diff', '--name-only', `${h.nextBase}...${h.merged}`)).not.toContain('parent');
    const f = await attempt(h.approved, h.merged, h.nextBase);
    expect(posts(f)).toHaveLength(1);
    expect(JSON.parse(posts(f)[0]![1].body!)).toMatchObject({ commit_id: h.merged, event: 'APPROVE', body: expect.stringContaining(`my approval at ${h.approved}`) });
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'posted', by: 'auto re-approval', postedReviewId: '20', autoReapprovals: [{ headSha: h.merged, approvedHeadSha: h.approved, reviewId: '20' }] });
    expect(latestRound(readReview(KEY)!).reReview).toBeUndefined();
    // A stale read cannot duplicate the GitHub write.
    await attempt(h.approved, h.merged, h.nextBase, f);
    expect(posts(f)).toHaveLength(1);
  });
  it('accepts a plain base merge without stacked changes', async () => {
    const base = commit('code', 'initial\n');
    git('checkout', '-b', 'topic'); const approved = commit('code', 'own change\n');
    git('checkout', 'main'); const nextBase = commit('base-only', 'base update\n');
    git('checkout', 'topic'); git('merge', '--no-ff', 'main', '-m', 'Merge main');
    expect(posts(await attempt(approved, git('rev-parse', 'HEAD'), nextBase))).toHaveLength(1);
  });
  it.each([false, true])('the poll shows re-review needed without adding a round (missing request: %s)', async missing => {
    const h = history();
    const config = path.join(home, 'config.toml');
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('path = "/w"', `path = ${JSON.stringify(repo.split(path.sep).join('/'))}`));
    item(h.approved, h.approved, h.base);
    const review = { databaseId: 10, state: 'APPROVED', submittedAt: AT, commit: { oid: h.approved } };
    const pr = { state: 'OPEN', number: 1, url: 'https://github.com/acme/web/pull/1', headRefOid: h.merged, baseRefOid: h.nextBase, isDraft: false,
      repository: { nameWithOwner: 'acme/web' }, author: { login: 'dana' }, reviews: { nodes: [review] },
      timelineItems: { nodes: [{ id: 'RRE_2', createdAt: '2026-11-17T20:30:00Z', actor: { login: 'bot', __typename: 'Bot' }, requestedReviewer: { __typename: 'User', login: 'chris' } }] } };
    const original = remote(h.approved, h.merged, h.nextBase, { comments: true });
    const f: FetchLike = (url, init) => url.includes('/compare/') ? Promise.resolve(new Response(git('diff', '--binary', url.split('/compare/')[1]!))) : original(url, init);
    await reviewsLoop('chris', () => 'token', () => {}, { now: NOW, fetch: f,
      run: ({ query }) => ({ status: 0, stdout: JSON.stringify({ data: query.includes('search(') ? { search: { issueCount: missing ? 0 : 1, nodes: missing ? [] : [pr] } } : { pr0: { pullRequest: pr } } }) }) });
    expect(readReview(KEY)!.rounds).toHaveLength(1);
    expect(latestRound(readReview(KEY)!).reReview?.headSha).toBe(h.merged);
    expect(latestRound(readReview(KEY)!).notification?.text).toContain('Re-review needed');
    expect(posts(original)).toHaveLength(0);
  });
  it('accepts a rebase onto the newer base', async () => {
    const h = history(); git('checkout', '-b', 'rebased', h.approved); git('rebase', '--onto', h.nextBase, h.parent);
    const f = await attempt(h.approved, git('rev-parse', 'HEAD'), h.nextBase);
    expect(posts(f)).toHaveLength(1);
  });
  it.each(['edit', 'edit-revert', 'conflict-resolution', 'unrelated-merge'] as const)('refuses a %s and shows that re-review is needed', async kind => {
    const h = history();
    let head: string;
    let base = h.nextBase;
    if (kind === 'conflict-resolution') {
      git('checkout', 'main');
      const contents = fs.readFileSync(path.join(repo, 'code'), 'utf8');
      base = commit('code', contents.replace('line 25', 'base conflict'));
      git('checkout', '-b', 'resolved', h.approved);
      expect(spawnSync('git', ['merge', '--no-ff', 'main', '-m', 'Merge main'], { cwd: repo }).status).toBe(1);
      fs.writeFileSync(path.join(repo, 'code'), contents.replace('line 25', 'changed PR resolution'));
      git('add', 'code'); git('commit', '-m', 'Merge with resolution'); head = git('rev-parse', 'HEAD');
    } else if (kind === 'unrelated-merge') {
      git('checkout', '-b', 'unrelated'); commit('extra', 'not base\n'); git('checkout', 'topic'); git('merge', '--no-ff', 'unrelated', '-m', 'Merge unrelated'); head = git('rev-parse', 'HEAD');
    } else {
      const changed = commit('extra', 'new change\n');
      if (kind === 'edit-revert') git('revert', '--no-edit', changed);
      head = git('rev-parse', 'HEAD');
    }
    const f = await attempt(h.approved, head, base);
    expect(posts(f)).toHaveLength(0);
    expect(latestRound(readReview(KEY)!).reReview?.headSha).toBe(head);
    expect(refreshReviewNotifications(NOW)[0]?.notification.text).toContain('Re-review needed');
  });
  it.each([{ comments: true }, { review: 'CHANGES_REQUESTED' }, { review: 'COMMENTED' }, { review: 'DISMISSED' }, { draft: true }, { state: 'closed' }, { moved: true }])('refuses changed eligibility: %j', async change => {
    const h = history();
    const f = await attempt(h.approved, h.merged, h.nextBase, remote(h.approved, h.merged, h.nextBase, change));
    expect(posts(f)).toHaveLength(0);
    expect(latestRound(readReview(KEY)!).reReview).toBeDefined();
  });
  it('also repairs stale approvals without a re-request', async () => {
    const h = history();
    expect(posts(await attempt(h.approved, h.merged, h.nextBase, remote(h.approved, h.merged, h.nextBase, { request: false })))).toHaveLength(1);
  });
  it.each(['disabled', 'outside-grounds'] as const)('does not approve when %s', async kind => {
    const h = history();
    fs.appendFileSync(path.join(home, 'config.toml'), kind === 'disabled' ? '\n[repos.lobstah.reviews]\nautoReapproveBaseOnly = false\n' : '\n[grounds.home]\n');
    if (kind === 'outside-grounds') {
      const file = path.join(home, 'config.toml'); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('[grounds.home]\nrepos = ["lobstah"]\n\n[grounds.home]\n', ''));
    }
    const f = await attempt(h.approved, h.merged, h.nextBase);
    expect(posts(f)).toHaveLength(0);
  });
  it.each(['review', 'inline-comment', 'discussion', 'unavailable', 'partial-page'] as const)('blocks newer or incomplete feedback: %s', async kind => {
    const h = history();
    const original = remote(h.approved, h.merged, h.nextBase);
    const f = vi.fn<FetchLike>(async (url, init) => {
      if (init.method === 'GET' && url.includes('/reviews?') && kind === 'review') {
        return new Response(JSON.stringify([
          { id: 10, state: 'APPROVED', submitted_at: AT, commit_id: h.approved, user: { login: 'chris' } },
          { id: 11, state: 'CHANGES_REQUESTED', submitted_at: '2026-11-17T20:30:00Z', commit_id: h.approved, user: { login: 'another-reviewer' } },
        ]));
      }
      if (url.includes('/comments?')) {
        if (kind === 'unavailable') return new Response('', { status: 503 });
        if (kind === 'partial-page') return new Response('{}');
        const inline = url.includes('/pulls/');
        if ((kind === 'inline-comment' && inline) || (kind === 'discussion' && !inline))
          return new Response(JSON.stringify([{ created_at: AT, updated_at: '2026-11-17T20:30:00Z' }]));
      }
      return original(url, init);
    });
    await attempt(h.approved, h.merged, h.nextBase, f);
    expect(posts(f)).toHaveLength(0);
  });
  it('refuses a token belonging to another identity', async () => {
    const h = history();
    const original = remote(h.approved, h.merged, h.nextBase);
    const f = vi.fn<FetchLike>((url, init) => url === 'https://api.github.com/user' ? Promise.resolve(new Response(JSON.stringify({ login: 'dana' }))) : original(url, init));
    await attempt(h.approved, h.merged, h.nextBase, f);
    expect(posts(f)).toHaveLength(0);
  });
  it('reads feedback past the first page before approving', async () => {
    const h = history();
    const original = remote(h.approved, h.merged, h.nextBase);
    const f = vi.fn<FetchLike>(async (url, init) => {
      if (url.includes('/comments?') && url.includes('/pulls/'))
        return new Response(JSON.stringify(url.endsWith('page=1')
          ? Array.from({ length: 100 }, () => ({ created_at: '2026-11-17T10:00:00Z', updated_at: '2026-11-17T10:00:00Z' }))
          : [{ created_at: '2026-11-17T20:30:00Z', updated_at: '2026-11-17T20:30:00Z' }]));
      return original(url, init);
    });
    await attempt(h.approved, h.merged, h.nextBase, f);
    expect(f.mock.calls.some(([url]) => url.endsWith('page=2'))).toBe(true);
    expect(posts(f)).toHaveLength(0);
  });
  it('rechecks feedback after verifying Git history', async () => {
    const h = history();
    const original = remote(h.approved, h.merged, h.nextBase);
    let verified = false;
    const f = vi.fn<FetchLike>(async (url, init) => {
      if (verified && url.includes('/comments?')) return new Response(JSON.stringify([{ created_at: '2026-11-17T20:30:00Z', updated_at: '2026-11-17T20:30:00Z' }]));
      return original(url, init);
    });
    await reapproveBaseUpdate(item(h.approved, h.merged, h.nextBase), 'chris', { token: () => 'token', fetch: f, now: NOW, log: () => {}, verify: async () => { verified = true; return true; } });
    expect(verified).toBe(true);
    expect(posts(f)).toHaveLength(0);
  });
  it('defaults on for homebase and lobstah, with explicit per-repo opt-out', () => {
    const config = loadConfig().reviews;
    expect(reviewSettings(config, 'homebase').autoReapproveBaseOnly).toBe(true);
    expect(reviewSettings(config, 'lobstah').autoReapproveBaseOnly).toBe(true);
    expect(reviewSettings(config, 'other').autoReapproveBaseOnly).toBe(false);
    config.perRepo.lobstah = { autoReapproveBaseOnly: false };
    expect(reviewSettings(config, 'lobstah').autoReapproveBaseOnly).toBe(false);
  });
});

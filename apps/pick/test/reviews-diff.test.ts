import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dismissReview, ensureLayout, latestRound, readReview, writeReview } from '@lobstah/core';
import { GithubSource } from '../src/sources/github.js';
import { qualifiedApproval, staleApprovals } from '../src/loops/merge.js';
import { reviewsLoop } from '../src/loops/reviews.js';
import type { GhGraphql } from '../src/loops/reviews.js';
import { reviewDiffId, reviewPatchId } from '../src/reviews-diff.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let repo: string;
const KEY = 'review:acme/web#1';
const NOW = Date.parse('2026-10-15T12:00:00Z');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-review-diff-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\nmode = "on-demand"\n[repos.web]\npath = "/w"\norigin = "https://github.com/acme/web.git"\n');
});
afterEach(() => {
  vi.unstubAllGlobals();
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

function git(...args: string[]): string {
  const out = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
}

function commit(file: string, contents: string): string {
  fs.writeFileSync(path.join(repo, file), contents);
  git('add', file);
  git('commit', '-m', 'Change fixture');
  return git('rev-parse', 'HEAD');
}

function history() {
  const original = Array.from({ length: 50 }, (_, index) => `line ${index}`).join('\n') + '\n';
  const base = commit('code.txt', original);
  git('checkout', '-b', 'topic');
  const changed = original.replace('line 25', 'real PR change');
  const head = commit('code.txt', changed);
  git('checkout', 'main');
  // Shift the PR's hunk without changing its contents or context.
  const nextBase = commit('code.txt', 'new base line\n' + original.replace('line 22', 'base context changed'));
  git('checkout', 'topic');
  git('merge', '--no-ff', 'main', '-m', 'Merge main');
  const merged = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'rebased', head);
  git('rebase', 'main');
  const rebased = git('rev-parse', 'HEAD');
  const real = commit('code.txt', 'new base line\n' + changed.replace('line 40', 'another real PR change'));
  return { base, head, nextBase, merged, rebased, real };
}

function search(head: string, base: string): GhGraphql {
  return () => ({ status: 0, stdout: JSON.stringify({ data: { search: { issueCount: 1, nodes: [{
    number: 1, url: 'https://github.com/acme/web/pull/1', headRefOid: head, baseRefOid: base,
    repository: { nameWithOwner: 'acme/web' }, author: { login: 'dana' },
    timelineItems: { nodes: [{ id: 'RRE_1', createdAt: '2026-10-15T09:00:00Z', requestedReviewer: { __typename: 'User', login: 'chris' } }] },
  }] } } }) });
}

const compare = async (url: string) => {
  const range = url.split('/compare/')[1]!;
  return new Response(git('diff', '--binary', '--no-ext-diff', '--no-textconv', range) + '\n');
};

describe('review diffs', () => {
  it.each(['dismissed', 'posted', 'stale'] as const)('a base merge keeps the %s round; an equivalent rebase also keeps it; a real change opens one', async (state) => {
    const h = history();
    const fetch = vi.fn(compare);
    const poll = (head: string, base: string) => reviewsLoop('chris', () => 'token', () => {}, { run: search(head, base), fetch, now: NOW });
    await poll(h.head, h.base);
    if (state === 'dismissed') dismissReview(KEY, 'glass');
    else {
      const item = readReview(KEY)!;
      latestRound(item)!.state = state;
      writeReview(item);
    }
    await poll(h.merged, h.nextBase);
    expect(readReview(KEY)!.rounds).toHaveLength(1);
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state, headSha: h.head });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![0]).toContain(`${h.base}...${h.head}`);
    await poll(h.merged, h.nextBase);
    expect(fetch).toHaveBeenCalledTimes(2); // repeated polls reuse the fingerprints
    await poll(h.rebased, h.nextBase);
    expect(readReview(KEY)!.rounds).toHaveLength(1);
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state, headSha: h.head });
    await poll(h.real, h.nextBase);
    expect(readReview(KEY)!.rounds).toHaveLength(2);
    expect(latestRound(readReview(KEY)!)).toMatchObject({ state: 'requested', headSha: h.real });
  });

  it.each(['base-merge', 'own-change', 'comparison-failure'] as const)('preserves approvals only with verified matching PR changes: %s', async kind => {
    const h = history();
    const current = kind === 'own-change' ? h.real : h.merged;
    const comparisons: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/compare/')) {
        comparisons.push(url);
        return kind === 'comparison-failure' ? new Response('unavailable', { status: 503 }) : compare(url);
      }
      if (url.includes('/reviews')) return new Response(JSON.stringify([
        { id: 10, user: { login: 'chris' }, state: 'APPROVED', commit_id: h.head },
      ]));
      return new Response(JSON.stringify({ number: 1, html_url: 'https://github.com/acme/web/pull/1', state: 'open',
        user: { login: 'dana' }, head: { ref: 'topic', sha: current }, base: { ref: 'main', sha: h.nextBase, repo: { default_branch: 'main' } },
        labels: [], assignees: [], draft: false, mergeable_state: 'clean' }));
    });
    const github = new GithubSource({ repo: 'acme/web', key: 'web', identity: 'dana', token: () => 'token', startLabel: 'start', claimedLabel: 'claimed' });
    const candidate = (await github.refresh(1))!;
    const policy = { enabled: true, approvers: ['chris'], assigneeApproves: false, restrictedLabels: [], method: 'merge' };
    expect(qualifiedApproval(policy, candidate)?.id).toBe(kind === 'base-merge' ? 10 : undefined);
    expect(staleApprovals(policy, candidate)).toEqual(kind === 'base-merge' ? [] : ['chris']);
    if (kind === 'base-merge') {
      await github.refresh(1);
      expect(comparisons).toHaveLength(2);
    }
    vi.unstubAllGlobals();
  });

  it('defers a new round when comparison fails, then retries without needing another head', async () => {
    const h = history();
    const poll = (head: string, fetch = compare) => reviewsLoop('chris', () => 'token', () => {}, { run: search(head, h.nextBase), fetch, now: NOW });
    await poll(h.head);
    dismissReview(KEY, 'glass');
    await poll(h.real, async () => new Response('unavailable', { status: 503 }));
    expect(readReview(KEY)!.rounds).toHaveLength(1);
    await poll(h.real);
    expect(readReview(KEY)!.rounds).toHaveLength(2);
  });

  it('distinguishes whitespace changes and binary contents', () => {
    const base = commit('binary', '\0one');
    const first = commit('binary', '\0two');
    const second = commit('binary', '\0three');
    expect(reviewPatchId(git('diff', '--binary', `${base}...${first}`))).not.toBe(reviewPatchId(git('diff', '--binary', `${base}...${second}`)));
    const diff = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n';
    expect(reviewPatchId(diff)).not.toBe(reviewPatchId(diff.replace('+new', '+ new')));
    expect(reviewPatchId('')).toBe('empty');
    expect(reviewPatchId('{"message":"error"}')).toBeUndefined();
  });

  it('distinguishes changes to the final newline', () => {
    const base = commit('a.txt', 'old\n');
    const first = commit('a.txt', 'new\n');
    const second = commit('a.txt', 'new');
    expect(reviewPatchId(git('diff', `${base}...${first}`))).not.toBe(reviewPatchId(git('diff', `${base}...${second}`)));
  });

  it('shares GitHub rate limits with the review loop', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '60' } }));
    const opts = { fetch, token: () => 'token', now: NOW, log: () => {} };
    expect(await reviewDiffId('acme/web', 'base', 'head', opts)).toBeUndefined();
    expect(await reviewDiffId('acme/web', 'base', 'head', opts)).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, latestRound, listReviews, readReview, recordGitHubRateLimit } from '@lobstah/core';
import { REVIEW_SEARCH, reviewsLoop } from '../src/loops/reviews.js';
import type { GhGraphql } from '../src/loops/reviews.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-reviews-loop-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const ME = 'chris';
// work = "off": these tests are about the search; drafting has its own (reviews-draft.test.ts).
const CONFIG = ['[reviews]', 'enabled = true', 'work = "off"', '[repos.web]', 'path = "/w"', 'origin = "git@github.com:acme/web.git"'];

interface Pr {
  number: number;
  repo?: string;
  author?: string;
  labels?: string[];
  head?: string;
  requests?: Array<{ id: string; at: string; to: string; team?: boolean }>;
}

function node(pr: Pr) {
  return {
    number: pr.number,
    url: `https://github.com/${pr.repo ?? 'acme/web'}/pull/${pr.number}`,
    title: `pr ${pr.number}`,
    isDraft: false,
    headRefOid: pr.head ?? 'aaaaaaa1',
    author: { login: pr.author ?? 'dana' },
    repository: { nameWithOwner: pr.repo ?? 'acme/web' },
    labels: { nodes: (pr.labels ?? []).map((name) => ({ name })) },
    timelineItems: {
      nodes: (pr.requests ?? [{ id: `RRE_${pr.number}`, at: '2026-10-15T09:00:00Z', to: ME }]).map((r) => ({
        id: r.id,
        createdAt: r.at,
        actor: { login: 'dana' },
        requestedReviewer: r.team ? { __typename: 'Team' } : { __typename: 'User', login: r.to },
      })),
    },
  };
}

/** A fake `gh api graphql --include` that answers with these PRs and records each call. */
function gh(prs: Pr[], calls: Array<{ query: string; q: string }>, issueCount?: number): GhGraphql {
  return (body) => {
    calls.push({ query: body.query, q: String(body.variables.q) });
    const headers = 'HTTP/2.0 200 OK\nX-Ratelimit-Resource: graphql\nX-Ratelimit-Limit: 5000\nX-Ratelimit-Remaining: 4990\nX-Ratelimit-Reset: 9999999999\n\n';
    const data = { rateLimit: { cost: 1 }, search: { issueCount: issueCount ?? prs.length, nodes: prs.map(node) } };
    return { status: 0, stdout: headers + JSON.stringify({ data }) };
  };
}

const config = (...extra: string[]) => fs.writeFileSync(path.join(home, 'config.toml'), [...CONFIG, ...extra].join('\n'));
const tok = () => 'token';

describe('the reviews loop', () => {
  it('with no [reviews] table makes no call and files nothing', async () => {
    const calls: Array<{ query: string; q: string }> = [];
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1 }], calls) });
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(home, 'reviews'))).toBe(false);
  });

  it('searches once per cycle for direct requests, on the shared budget', async () => {
    config();
    const calls: Array<{ query: string; q: string }> = [];
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1 }, { number: 2 }], calls) });
    expect(calls).toEqual([{ query: REVIEW_SEARCH, q: 'is:pr is:open user-review-requested:chris archived:false' }]);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'github-budget.json'), 'utf8')).resources.graphql).toMatchObject({ remaining: 4990 });
    expect(listReviews().map((r) => r.key).sort()).toEqual(['review:acme/web#1', 'review:acme/web#2']);
    expect(readReview('review:acme/web#1')).toMatchObject({ pr: { repoKey: 'web', author: 'dana' }, rounds: [{ id: 'RRE_1', requestedBy: 'dana', state: 'requested' }] });
  });

  it('makes no call while the GitHub budget is blocked', async () => {
    config();
    recordGitHubRateLimit(Date.now(), Date.now() + 60_000);
    const calls: Array<{ query: string; q: string }> = [];
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1 }], calls) });
    expect(calls).toEqual([]);
  });

  it('a PR whose only request names a team files nothing; the newest direct request is the round', async () => {
    config();
    const calls: Array<{ query: string; q: string }> = [];
    await reviewsLoop(ME, tok, () => {}, {
      run: gh(
        [
          { number: 3, requests: [{ id: 'RRE_t', at: '2026-10-15T09:00:00Z', to: '', team: true }] },
          {
            number: 4,
            requests: [
              { id: 'RRE_a', at: '2026-10-15T08:00:00Z', to: ME },
              { id: 'RRE_b', at: '2026-10-15T09:00:00Z', to: ME },
              { id: 'RRE_c', at: '2026-10-15T10:00:00Z', to: 'someone-else' },
            ],
          },
        ],
        calls,
      ),
    });
    expect(listReviews().map((r) => r.key)).toEqual(['review:acme/web#4']);
    expect(latestRound(readReview('review:acme/web#4')!)!.id).toBe('RRE_b');
  });

  it('keeps to configured repos unless repos = "any"; skip rules file with a reason', async () => {
    fs.writeFileSync(path.join(home, 'config.toml'), ['[reviews]', 'enabled = true', 'skipLabels = ["deps"]', ...CONFIG.slice(3)].join('\n'));
    const prs = [{ number: 5, repo: 'other/lib' }, { number: 6, labels: ['deps'] }];
    await reviewsLoop(ME, tok, () => {}, { run: gh(prs, []) });
    expect(listReviews().map((r) => r.key)).toEqual(['review:acme/web#6']);
    expect(latestRound(readReview('review:acme/web#6')!)!.reason).toBe('skipped: label deps is in skipLabels');

    fs.writeFileSync(path.join(home, 'config.toml'), ['[reviews]', 'enabled = true', 'repos = "any"', ...CONFIG.slice(3)].join('\n'));
    await reviewsLoop(ME, tok, () => {}, { run: gh(prs, []) });
    expect(readReview('review:other/lib#5')!.pr.repoKey).toBeUndefined();
  });

  it('withdraws a request the search stopped returning, unless the search was truncated', async () => {
    config();
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1 }, { number: 2 }], []) });
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 2 }], [], 60) });
    expect(latestRound(readReview('review:acme/web#1')!)!.state).toBe('requested');
    const logs: string[] = [];
    await reviewsLoop(ME, tok, (m) => logs.push(m), { run: gh([{ number: 2 }], []) });
    expect(latestRound(readReview('review:acme/web#1')!)!.state).toBe('withdrawn');
    expect(logs).toEqual(['review:acme/web#1: review request gone; round withdrawn']);
  });

  it('a failed search changes nothing', async () => {
    config();
    await reviewsLoop(ME, tok, () => {}, { run: gh([{ number: 1 }], []) });
    const logs: string[] = [];
    await reviewsLoop(ME, tok, (m) => logs.push(m), { run: () => ({ status: 1, stdout: '', stderr: 'HTTP 502: bad gateway' }) });
    expect(latestRound(readReview('review:acme/web#1')!)!.state).toBe('requested');
    expect(logs[0]).toContain('reviews: search failed: HTTP 502');
  });
});

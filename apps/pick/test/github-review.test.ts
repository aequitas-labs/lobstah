import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, laneDirs } from '@lobstah/core';
import { GithubSource } from '../src/sources/github.js';
import { marker } from '../src/types.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-ghrev-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

const IDENTITY = 'octoclaw';
const UUID = '11111111-1111-1111-1111-111111111111';

function source(): GithubSource {
  return new GithubSource({
    repo: 'o/r',
    key: 'demo',
    identity: IDENTITY,
    token: () => 't',
    startLabel: 'lobstah',
    claimedLabel: 'lobstah-claimed',
  });
}

interface PrFixture {
  number: number;
  branch: string;
  reviews?: Array<{ id: number; login: string; state: string; sha?: string; body?: string; at: string }>;
  reviewComments?: Array<{ id: number; login: string; body: string; at: string }>;
  issueComments?: Array<{ id: number; login: string; body: string; at: string }>;
}

/** Stub the GitHub API with just the routes poll() walks. */
function stubApi(prs: PrFixture[]): void {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = new URL(String(input));
    const p = url.pathname;
    let body: unknown = [];
    if (p === '/repos/o/r/issues') body = [];
    else if (p === '/repos/o/r/pulls') {
      body = prs.map((pr) => ({
        number: pr.number,
        title: `pr ${pr.number}`,
        state: 'open',
        html_url: `https://github.com/o/r/pull/${pr.number}`,
        user: { login: IDENTITY },
        head: { ref: pr.branch, sha: 'headsha' },
        labels: [],
        assignees: [],
        draft: false,
      }));
    } else {
      const m = /^\/repos\/o\/r\/(pulls|issues)\/(\d+)\/(reviews|comments)$/.exec(p);
      const pr = m ? prs.find((x) => x.number === Number(m[2])) : undefined;
      if (m && pr && url.searchParams.get('page') === '1') {
        if (m[1] === 'pulls' && m[3] === 'reviews') {
          body = (pr.reviews ?? []).map((r) => ({
            id: r.id,
            user: { login: r.login },
            state: r.state,
            commit_id: r.sha ?? 'headsha',
            submitted_at: r.at,
            body: r.body ?? null,
          }));
        } else {
          const list = m[1] === 'pulls' ? pr.reviewComments : pr.issueComments;
          body = (list ?? []).map((c) => ({ id: c.id, user: { login: c.login }, body: c.body, created_at: c.at }));
        }
      }
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

describe('post-PR feedback pickup', () => {
  it('a COMMENTED review with a body is feedback, keyed by its id', async () => {
    stubApi([
      {
        number: 5,
        branch: `lobstah/${UUID}`,
        reviews: [{ id: 90, login: 'chris', state: 'COMMENTED', body: 'two nits inline', at: '2026-09-21T10:00:00Z' }],
      },
    ]);
    const items = await source().poll();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'gh:o/r#pr5@rv90', subject: 'gh:o/r#pr5', kind: 'review', followUp: UUID });
  });

  it('CHANGES_REQUESTED counts even when reviewed on a stale sha', async () => {
    stubApi([
      {
        number: 6,
        branch: `lobstah/${UUID}`,
        reviews: [{ id: 91, login: 'chris', state: 'CHANGES_REQUESTED', sha: 'oldsha', at: '2026-09-21T10:00:00Z' }],
      },
    ]);
    const items = await source().poll();
    expect(items.map((i) => i.key)).toEqual(['gh:o/r#pr6@rv91']);
  });

  it('conversation and review-thread comments are feedback; identity and marker comments are not', async () => {
    stubApi([
      {
        number: 7,
        branch: `lobstah/${UUID}`,
        reviewComments: [
          { id: 40, login: 'chris', body: 'rename this', at: '2026-09-21T09:00:00Z' },
          { id: 41, login: IDENTITY, body: 'done, renamed', at: '2026-09-21T09:30:00Z' },
        ],
        issueComments: [
          { id: 50, login: 'chris', body: 'also update the docs', at: '2026-09-21T10:00:00Z' },
          { id: 51, login: 'chris', body: `${marker(UUID)} **done**`, at: '2026-09-21T11:00:00Z' },
        ],
      },
    ]);
    const items = await source().poll();
    expect(items.map((i) => i.key)).toEqual(['gh:o/r#pr7@ic50']);
  });

  it('a newer human event re-keys the round', async () => {
    const pr: PrFixture = {
      number: 8,
      branch: `lobstah/${UUID}`,
      reviews: [{ id: 92, login: 'chris', state: 'CHANGES_REQUESTED', at: '2026-09-21T10:00:00Z' }],
    };
    stubApi([pr]);
    expect((await source().poll())[0]!.key).toBe('gh:o/r#pr8@rv92');
    pr.issueComments = [{ id: 60, login: 'chris', body: 'one more thing', at: '2026-09-21T12:00:00Z' }];
    stubApi([pr]);
    expect((await source().poll())[0]!.key).toBe('gh:o/r#pr8@ic60');
  });

  it('maps a non-lobstah branch through reported evidence', async () => {
    fs.writeFileSync(
      path.join(laneDirs('work').state, `${UUID}.evidence`),
      JSON.stringify({ prUrl: 'https://github.com/o/r/pull/9' }),
    );
    stubApi([
      {
        number: 9,
        branch: 'feat/session-branch',
        issueComments: [{ id: 70, login: 'chris', body: 'please split this commit', at: '2026-09-21T10:00:00Z' }],
      },
    ]);
    const items = await source().poll();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'gh:o/r#pr9@ic70', followUp: UUID });
  });

  it('an unmapped PR, an APPROVED review, and a bodyless COMMENTED review are all quiet', async () => {
    stubApi([
      {
        number: 10,
        branch: 'feat/unrelated',
        issueComments: [{ id: 80, login: 'chris', body: 'nice', at: '2026-09-21T10:00:00Z' }],
      },
      {
        number: 11,
        branch: `lobstah/${UUID}`,
        reviews: [
          { id: 93, login: 'chris', state: 'APPROVED', body: 'ship it', at: '2026-09-21T10:00:00Z' },
          { id: 94, login: 'chris', state: 'COMMENTED', body: '  ', at: '2026-09-21T11:00:00Z' },
        ],
      },
    ]);
    expect(await source().poll()).toEqual([]);
  });
});

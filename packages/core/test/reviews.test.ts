import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_ATTENTION_KINDS,
  ensureLayout,
  latestRound,
  listReviews,
  loadConfig,
  observeReviewRequest,
  parseReviews,
  readReview,
  reviewAttention,
  reviewSettings,
  withdrawUnseenReviews,
  writeReview,
} from '../src/index.js';
import type { ReviewRequestSeen } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-reviews-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const T0 = Date.parse('2026-10-15T10:00:00Z');

function seen(over: { id?: string; head?: string; number?: number; skip?: string } = {}): ReviewRequestSeen {
  return {
    pr: {
      owner: 'acme',
      repo: 'web',
      number: over.number ?? 7,
      url: `https://github.com/acme/web/pull/${over.number ?? 7}`,
      title: 'Add the thing',
      author: 'dana',
      headSha: over.head ?? 'aaaaaaa1',
      repoKey: 'web',
    },
    round: { id: over.id ?? 'RRE_1', requestedAt: '2026-10-15T09:00:00Z', requestedBy: 'dana' },
    ...(over.skip ? { skip: over.skip } : {}),
  };
}

describe('[reviews] config', () => {
  it('is off by default, with the planned defaults', () => {
    const cfg = loadConfig().reviews;
    expect(cfg).toMatchObject({ enabled: false, repos: 'configured', work: 'trap', post: 'draft', trapWaitSecs: 600, maxPerDay: 20 });
    expect(cfg.limits).toEqual({ wallClockSecs: 900, maxTurns: 40 });
  });

  it('reads the table and per-repo overrides, and refuses bad values', () => {
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      ['[reviews]', 'enabled = true', 'work = "headless"', 'maxBudgetUsd = 2', 'skipAuthors = ["dependabot[bot]"]', '[repos.web]', 'path = "/w"', '[repos.web.reviews]', 'work = "off"', 'wallClockSecs = 300'].join('\n'),
    );
    const cfg = loadConfig().reviews;
    expect(cfg).toMatchObject({ enabled: true, work: 'headless', skipAuthors: ['dependabot[bot]'] });
    expect(reviewSettings(cfg, 'web')).toMatchObject({ work: 'off', limits: { wallClockSecs: 300, maxTurns: 40, maxBudgetUsd: 2 } });
    expect(reviewSettings(cfg, 'other')).toMatchObject({ work: 'headless', limits: { wallClockSecs: 900 } });
    expect(() => parseReviews({ post: 'approve' })).toThrow('[reviews].post must be "draft", "auto"');
    expect(reviewSettings(parseReviews({ rules: '  Flag missing tests.  ' }, { web: { reviews: { rules: 'Check the migration order.' } } }), 'web').rules).toBe('Check the migration order.');
    expect(reviewSettings(parseReviews({ rules: 'Flag missing tests.' }), 'other').rules).toBe('Flag missing tests.');
    expect(() => parseReviews({ rules: 3 })).toThrow('[reviews].rules must be text');
    expect(() => parseReviews({}, { web: { reviews: { work: 'always' } } })).toThrow('[repos.web.reviews].work');
  });

  it('review is an attention kind, and an opt-in one', () => {
    expect(DEFAULT_ATTENTION_KINDS).not.toContain('review');
    fs.writeFileSync(path.join(home, 'config.toml'), 'attentionKinds = ["review"]\n');
    expect(loadConfig().attentionKinds).toEqual(['review']);
  });
});

describe('review rounds', () => {
  it('the same standing request seen on three polls is one item with one round', () => {
    expect(observeReviewRequest(seen(), T0).opened).toBe(true);
    expect(observeReviewRequest(seen(), T0 + 45_000).opened).toBe(false);
    observeReviewRequest(seen(), T0 + 90_000);
    expect(listReviews()).toHaveLength(1);
    expect(readReview('review:acme/web#7')!.rounds).toHaveLength(1);
  });

  it('a re-request opens a second round on the same item, withdrawing the first', () => {
    observeReviewRequest(seen(), T0);
    observeReviewRequest(seen({ id: 'RRE_2' }), T0 + 1000);
    const item = readReview('review:acme/web#7')!;
    expect(item.rounds.map((r) => [r.id, r.state])).toEqual([
      ['RRE_1', 'withdrawn'],
      ['RRE_2', 'requested'],
    ]);
  });

  it('a moved head follows a requested round, and makes a drafted round stale', () => {
    observeReviewRequest(seen(), T0);
    observeReviewRequest(seen({ head: 'bbbbbbb2' }), T0 + 1000);
    expect(latestRound(readReview('review:acme/web#7')!)).toMatchObject({ state: 'requested', headSha: 'bbbbbbb2' });

    const item = readReview('review:acme/web#7')!;
    item.rounds[0]!.state = 'drafted';
    writeReview(item);
    observeReviewRequest(seen({ head: 'ccccccc3' }), T0 + 2000);
    const after = readReview('review:acme/web#7')!;
    expect(latestRound(after)).toMatchObject({ state: 'stale', headSha: 'bbbbbbb2' });
    expect(after.pr.headSha).toBe('ccccccc3');
    expect(after.rounds).toHaveLength(1);
  });

  it('a skip rule files the round with its reason', () => {
    observeReviewRequest(seen({ skip: 'skipped: author dana is in skipAuthors' }), T0);
    expect(latestRound(readReview('review:acme/web#7')!)).toMatchObject({ state: 'requested', reason: 'skipped: author dana is in skipAuthors' });
  });

  it('a request the search stopped returning is withdrawn, inside the scope only', () => {
    observeReviewRequest(seen(), T0);
    observeReviewRequest(seen({ number: 8 }), T0);
    expect(withdrawUnseenReviews(new Set(['review:acme/web#8']), () => false, T0)).toEqual([]);
    expect(withdrawUnseenReviews(new Set(['review:acme/web#8']), () => true, T0)).toEqual(['review:acme/web#7']);
    expect(latestRound(readReview('review:acme/web#7')!)!.state).toBe('withdrawn');
    expect(latestRound(readReview('review:acme/web#8')!)!.state).toBe('requested');
  });
});

describe('review attention', () => {
  it('stands while the newest round is requested with no job, drafted, stale or failed', () => {
    observeReviewRequest(seen(), T0);
    const item = readReview('review:acme/web#7')!;
    const stands = (state: string, dispatch?: string): boolean => {
      item.rounds[0] = { ...item.rounds[0]!, state: state as never, ...(dispatch ? { dispatch } : {}) };
      if (!dispatch) delete item.rounds[0].dispatch;
      return reviewAttention(T0, [item]).length === 1;
    };
    expect(stands('requested')).toBe(true);
    expect(stands('requested', 'd1')).toBe(false); // a job is drafting it
    expect(stands('drafting', 'd1')).toBe(false);
    for (const s of ['drafted', 'stale', 'failed']) expect(stands(s)).toBe(true);
    for (const s of ['posted', 'dismissed', 'withdrawn']) expect(stands(s)).toBe(false);
  });

  it('carries the PR, and a state hash that changes with the round', () => {
    observeReviewRequest(seen(), T0);
    const [a] = reviewAttention(T0 + 60_000);
    expect(a).toMatchObject({ kind: 'review', key: 'review:acme/web#7', verb: 'requested', ageSecs: 3660, prUrl: 'https://github.com/acme/web/pull/7', repo: 'web' });
    observeReviewRequest(seen({ head: 'bbbbbbb2' }), T0);
    expect(reviewAttention(T0)[0]!.stateHash).not.toBe(a!.stateHash);
  });
});

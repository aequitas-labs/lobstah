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
  dismissReview,
  muteReview,
  unmuteReview,
  readReview,
  redraftReview,
  reviewAttention,
  refreshReviewNotifications,
  markReviewSeen,
  acknowledgeReview,
  reviewRoundDir,
  readRoundDraft,
  reviewBrief,
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
  it('resolves mode and publish overrides per repo, with global defaults and legacy auto posting', () => {
    const cfg = parseReviews({ mode: 'auto-review', autoPostApprove: 'auto-post' }, {
      web: { reviews: { mode: 'on-demand', publish: false, autoPostRequestChanges: 'auto-post' } },
      api: { reviews: { mode: 'auto-draft' } },
      cli: { reviews: { publish: false } },
      ops: { reviews: { mode: 'notify', publish: true } },
    });
    expect(reviewSettings(cfg, 'web')).toMatchObject({ mode: 'on-demand', publish: false, work: 'off', autoPostApprove: 'auto-post', autoPostRequestChanges: 'auto-post' });
    expect(reviewSettings(cfg, 'api')).toMatchObject({ mode: 'auto-draft', publish: false, work: 'trap' });
    expect(reviewSettings(cfg, 'cli')).toMatchObject({ mode: 'auto-draft', publish: false });
    expect(reviewSettings(cfg, 'ops')).toMatchObject({ mode: 'notify', publish: true, work: 'off' });
    expect(reviewSettings(cfg, 'other')).toMatchObject({ mode: 'auto-review', publish: true, work: 'trap', post: 'auto' });
    expect(reviewSettings(cfg, 'other').autoPostRequestChanges).toBe('ask');
    expect(parseReviews({ post: 'auto', work: 'off' })).toMatchObject({ mode: 'auto-review', publish: true, work: 'trap' });
    expect(parseReviews({ mode: 'on-demand', publish: true })).toMatchObject({ mode: 'on-demand', publish: true, work: 'off' });
    expect(() => parseReviews({ publish: 'yes' })).toThrow('publish must be a boolean');
  });
  it('is off by default, with the planned defaults', () => {
    const cfg = loadConfig().reviews;
    expect(cfg).toMatchObject({ enabled: false, mode: 'notify', repos: 'configured', work: 'off', post: 'draft', autoPostApprove: 'ask', autoPostRequestChanges: 'ask', trapWaitSecs: 600, maxPerDay: 20 });
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

  it('a dismissed round stays dismissed at its head and a new head starts a fresh round', () => {
    observeReviewRequest(seen(), T0);
    dismissReview('review:acme/web#7', 'glass', T0 + 1);
    expect(observeReviewRequest(seen(), T0 + 2).opened).toBe(false);
    expect(observeReviewRequest(seen({ head: 'bbbbbbb2' }), T0 + 3).opened).toBe(true);
    const rounds = readReview('review:acme/web#7')!.rounds;
    expect(rounds.map((round) => round.state)).toEqual(['dismissed', 'requested']);
    expect(rounds[1]).toMatchObject({ requestEventId: 'RRE_1', headSha: 'bbbbbbb2' });
    expect(observeReviewRequest(seen({ head: 'bbbbbbb2' }), T0 + 4).opened).toBe(false);
  });

  it('a dismissed request that disappears and returns starts a fresh round on PR reopen', () => {
    observeReviewRequest(seen(), T0);
    dismissReview('review:acme/web#7', 'glass', T0 + 1);
    withdrawUnseenReviews(new Set(), () => true, T0 + 2);
    expect(observeReviewRequest(seen(), T0 + 3).opened).toBe(true);
    expect(readReview('review:acme/web#7')!.rounds.map((round) => round.state)).toEqual(['dismissed', 'requested']);
  });

  it('mutes PR requests until unmuted and keeps the item visible', () => {
    observeReviewRequest(seen(), T0);
    muteReview('review:acme/web#7', T0 + 1);
    expect(observeReviewRequest(seen({ id: 'RRE_2', head: 'bbbbbbb2' }), T0 + 2).opened).toBe(false);
    expect(readReview('review:acme/web#7')!.mutedAt).toBe(new Date(T0 + 1).toISOString());
    unmuteReview('review:acme/web#7', T0 + 3);
    expect(observeReviewRequest(seen({ id: 'RRE_2', head: 'bbbbbbb2' }), T0 + 4).opened).toBe(true);
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

describe('review notifications', () => {
  const key = 'review:acme/web#7';
  it('requests are silent; draft ready notifies once and opening only marks seen', () => {
    observeReviewRequest(seen(), T0);
    expect(refreshReviewNotifications(T0)).toEqual([]);
    expect(reviewAttention(T0)).toEqual([]);
    const item = readReview(key)!;
    Object.assign(item.rounds[0]!, { state: 'drafted', verdict: 'request_changes', blocking: [{ path: 'a.ts', line: 4, body: 'race' }], draftedAt: new Date(T0).toISOString() });
    writeReview(item);
    expect(refreshReviewNotifications(T0 + 1)[0]).toMatchObject({ hash: '#review-review%3Aacme%2Fweb%237', notification: { kind: 'needs-you', text: 'Draft ready (needs you): #7 Add the thing · request changes · 1 blocking' } });
    expect(refreshReviewNotifications(T0 + 2)).toEqual([]);
    markReviewSeen(key, T0 + 3);
    expect(latestRound(readReview(key)!)).toMatchObject({ seenAt: new Date(T0 + 3).toISOString(), notification: { kind: 'needs-you' } });
    expect(reviewAttention(T0 + 3)).toHaveLength(1);
    acknowledgeReview(key, T0 + 4);
    expect(reviewAttention(T0 + 4)).toEqual([]);
    expect(refreshReviewNotifications(T0 + 5)).toEqual([]);
  });

  it('approve waits with needs-you; an action clears it without renotifying', () => {
    const item = observeReviewRequest(seen(), T0).item;
    Object.assign(item.rounds[0]!, { state: 'drafted', verdict: 'approve', draftedAt: new Date(T0).toISOString() });
    writeReview(item);
    expect(refreshReviewNotifications(T0 + 1)[0]?.notification.kind).toBe('needs-you');
    expect(latestRound(readReview(key)!)?.needsYou).toBe(true);
    markReviewSeen(key, T0 + 2);
    expect(latestRound(readReview(key)!)?.needsYou).toBe(true);
    acknowledgeReview(key, T0 + 3);
    expect(latestRound(readReview(key)!)?.needsYou).toBeUndefined();
    expect(refreshReviewNotifications(T0 + 4)).toEqual([]);
  });

  it('auto published reviews notify published, while human publishing is already acknowledged', () => {
    const item = observeReviewRequest(seen(), T0).item;
    Object.assign(item.rounds[0]!, { state: 'posted', by: 'auto', postedAt: new Date(T0).toISOString(), verdict: 'comment' });
    writeReview(item);
    expect(refreshReviewNotifications(T0 + 1)[0]?.notification).toMatchObject({ kind: 'published', text: 'Published: #7 Add the thing · comment · 0 blocking' });
    item.rounds[0]!.by = 'glass'; writeReview(item);
    expect(refreshReviewNotifications(T0 + 2)).toEqual([]);
  });
});

describe('drafts', () => {
  it('reads verdict and file/line blockers, rejects malformed or contradictory metadata, and defaults legacy drafts to comment', () => {
    observeReviewRequest(seen(), T0);
    const dir = reviewRoundDir('review:acme/web#7', 'RRE_1')!; fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'review.md'), 'Summary');
    expect(readRoundDraft('review:acme/web#7', 'RRE_1')).toMatchObject({ verdict: 'comment', blocking: [] });
    const meta = (verdict: string, blocking: unknown[]) => fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ verdict, blocking }));
    meta('request_changes', [{ path: 'a.ts', line: 9, body: 'Race' }]);
    expect(readRoundDraft('review:acme/web#7', 'RRE_1')).toMatchObject({ verdict: 'request_changes', blocking: [{ path: 'a.ts', line: 9 }] });
    // Sound code drafts approve as written, whatever the PR's checks say: nothing here reads them.
    meta('approve', []);
    expect(readRoundDraft('review:acme/web#7', 'RRE_1')).toMatchObject({ verdict: 'approve', blocking: [] });
    meta('approve', [{ path: 'a.ts', line: 9, body: 'Race' }]);
    expect(readRoundDraft('review:acme/web#7', 'RRE_1')).toHaveProperty('error');
    meta('request_changes', []);
    expect(readRoundDraft('review:acme/web#7', 'RRE_1')).toHaveProperty('error');
    meta('comment', [{ path: 'a.ts', line: 0, body: 'Race' }]);
    expect(readRoundDraft('review:acme/web#7', 'RRE_1')).toHaveProperty('error');
  });

  it('accepts an empty body only with an explicit approve verdict and no blockers', () => {
    observeReviewRequest(seen(), T0);
    const dir = reviewRoundDir('review:acme/web#7', 'RRE_1')!; fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'review.md'), '');
    fs.writeFileSync(path.join(dir, 'comments.json'), '[]');
    expect(readRoundDraft('review:acme/web#7', 'RRE_1')).toEqual({ error: 'review.md is empty' });
    fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ verdict: 'approve', blocking: [] }));
    expect(readRoundDraft('review:acme/web#7', 'RRE_1')).toEqual({ body: '', comments: [], verdict: 'approve', blocking: [] });
    fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ verdict: 'comment', blocking: [] }));
    expect(readRoundDraft('review:acme/web#7', 'RRE_1')).toEqual({ error: 'review.md is empty' });
  });

  it('the brief drafts into the round directory and forbids every write to the PR', () => {
    observeReviewRequest(seen(), T0);
    const item = readReview('review:acme/web#7')!;
    const brief = reviewBrief(item, item.rounds[0]!, { identity: 'chris', id: 'd1', outDir: '/x/rounds/RRE_1', checkout: '/x/rounds/RRE_1/checkout' });
    expect(brief).toContain('dana asked chris for this review. You write the draft; you do not post it.');
    expect(brief).toContain('gh pr diff 7 --repo acme/web');
    expect(brief).toContain('git worktree add --detach /x/rounds/RRE_1/checkout FETCH_HEAD');
    expect(brief).toContain('Use no other path; lobstah removes it when the job ends.');
    expect(brief).not.toContain('<tmpdir>');
    expect(brief).toContain('Write three files in /x/rounds/RRE_1');
    expect(brief).toContain('Do not post, approve, request changes, comment on, push to, or edit the PR.');
    expect(brief).toContain('lobstah report d1 done');
    expect(brief).toContain("Follow the repo's own rules: read any review guidance at the PR head (REVIEW.md, CONTRIBUTING.md, AGENTS.md, CLAUDE.md");
    expect(brief).toContain('Follow any review rules appended below this brief too.');
  });

  it('the brief judges the code alone: a red or stale merge gate never downgrades the verdict or reaches the review', () => {
    observeReviewRequest(seen(), T0);
    const item = readReview('review:acme/web#7')!;
    const brief = reviewBrief(item, item.rounds[0]!, { identity: 'chris', id: 'd1', outDir: '/x', checkout: '/x/checkout' });
    expect(brief).toContain('Judge the code alone.');
    expect(brief).toContain('A merge gate, required check, submit or approval label, or CI status that is red, pending or older than the head');
    expect(brief).toContain('it never changes the verdict, and the review never mentions it or asks anyone to rerun it.');
    expect(brief).toContain('approve when there are no blockers or inline comments worth posting');
    expect(brief).toContain('comment only for real non-blocking findings in the diff');
    expect(brief).toContain('For approve, leave review.md empty or use at most one short line.');
    expect(brief).toContain('Process items outside the diff—issue checklists, manual or real-world verification still to do, and whether you ran tests—never change the verdict or go in the body.');
    expect(brief).not.toContain('ready to merge');
    // A test this change breaks is still a finding, with its file and line.
    expect(brief).toContain('A test that fails because of this change is a code finding: give its file and line.');
  });

  it('a stale or failed round re-drafts at the current head; others refuse', () => {
    observeReviewRequest(seen(), T0);
    expect(redraftReview('review:acme/web#7')).toContain('only a drafted, stale or failed round re-drafts');
    const item = readReview('review:acme/web#7')!;
    Object.assign(item.rounds[0]!, { state: 'stale', dispatch: 'd1', dispatchedAt: 'x', draftedAt: 'y', reason: 'moved' });
    item.pr.headSha = 'bbbbbbb2';
    writeReview(item);
    redraftReview('review:acme/web#7', T0);
    expect(readReview('review:acme/web#7')!.rounds[0]).toEqual({ id: 'RRE_1', requestEventId: 'RRE_1', requestedAt: '2026-10-15T09:00:00Z', requestedBy: 'dana', headSha: 'bbbbbbb2', state: 'requested', draftStarts: ['x'], byHand: true });
    expect(redraftReview('review:acme/web#9')).toBe('no review item review:acme/web#9');
  });
});

describe('dismiss', () => {
  it('dismisses an open round, once', () => {
    observeReviewRequest(seen(), T0);
    dismissReview('review:acme/web#7', 'glass', T0);
    expect(latestRound(readReview('review:acme/web#7')!)).toMatchObject({ state: 'dismissed', by: 'glass' });
    expect(dismissReview('review:acme/web#7', 'cli')).toContain('already dismissed');
    expect(reviewAttention(T0)).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  appendStatus,
  claimNext,
  ensureLayout,
  laneDirs,
  latestRound,
  observeReviewRequest,
  pendingIds,
  queuedDescriptor,
  readReview,
  reviewCheckoutDir,
  reviewRoundDir,
  writeReview,
} from '@lobstah/core';
import { draftReviewOnDemand, draftReviews } from '../src/loops/reviews.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-reviews-draft-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  process.env.LOBSTAH_TEST_REVIEW_TOKEN = 'fixture';
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
  delete process.env.LOBSTAH_TEST_REVIEW_TOKEN;
});

const NOW = Date.parse('2026-10-15T12:00:00Z');
const KEY = 'review:acme/web#7';
const config = (...lines: string[]) =>
  fs.writeFileSync(path.join(home, 'config.toml'), ['[reviews]', 'enabled = true', 'identity = "chris"', 'tokenEnv = "LOBSTAH_TEST_REVIEW_TOKEN"', ...(lines.some((s) => s.startsWith('work') || s.startsWith('mode')) ? [] : ['work = "trap"']), ...lines, '[repos.web]', 'path = "/w"'].join('\n'));

function request(over: { number?: number; repoKey?: string | null; head?: string; skip?: string } = {}): string {
  const number = over.number ?? 7;
  observeReviewRequest(
    {
      pr: {
        owner: 'acme',
        repo: 'web',
        number,
        url: `https://github.com/acme/web/pull/${number}`,
        title: 'Add the thing',
        author: 'dana',
        headSha: over.head ?? 'aaaaaaa1',
        ...(over.repoKey === null ? {} : { repoKey: over.repoKey ?? 'web' }),
      },
      round: { id: `RRE_${number}`, requestedAt: '2026-10-15T11:00:00Z', requestedBy: 'dana' },
      ...(over.skip ? { skip: over.skip } : {}),
    },
    NOW,
  );
  return `review:acme/web#${number}`;
}

const round = (key = KEY) => latestRound(readReview(key)!)!;

describe('starting a review job', () => {
  it('notify starts no jobs; on-demand starts only the clicked round as a pending-only trap review', async () => {
    config('mode = "notify"');
    request();
    draftReviews('chris', () => {}, NOW);
    expect(pendingIds('chore')).toEqual([]);
    expect(await draftReviewOnDemand(KEY, NOW)).toContain('notify mode');
    config('mode = "on-demand"');
    request({ number: 8 });
    expect(await draftReviewOnDemand(KEY, NOW)).toBeUndefined();
    expect(round()).toMatchObject({ state: 'drafting', draftOnly: true });
    expect(queuedDescriptor(round().dispatch!, 'chore')).toMatchObject({ readOnly: true, trapAny: true });
    expect(round('review:acme/web#8').state).toBe('requested');
    expect(pendingIds('chore')).toHaveLength(1);
  });

  it('manual redrafts respect the daily cap, including prior starts of the same round', async () => {
    config('mode = "on-demand"', 'maxPerDay = 1');
    request();
    expect(await draftReviewOnDemand(KEY, NOW)).toBeUndefined();
    const item = readReview(KEY)!;
    item.rounds[0]!.state = 'failed';
    writeReview(item);
    expect(await draftReviewOnDemand(KEY, NOW)).toContain('daily cap');
    expect(pendingIds('chore')).toHaveLength(1);
    expect(await draftReviewOnDemand(KEY, NOW + 24 * 3600_000)).toBeUndefined();
    expect(round().draftStarts).toHaveLength(2);
  });
  it('work = trap: a read-only chore for a free trap of the repo, with the cost bounds and the trap wait', () => {
    config('maxBudgetUsd = 3');
    fs.appendFileSync(path.join(home, 'config.toml'), '\n[hooks.brief]\nprReview = "Flag missing tests."\n[repos.web.hooks.brief]\nprReview = "Check the migration order."\n');
    request();
    draftReviews('chris', () => {}, NOW);
    const r = round();
    expect(r).toMatchObject({ state: 'drafting', dispatchedAt: new Date(NOW).toISOString() });
    const d = queuedDescriptor(r.dispatch!, 'chore')!;
    expect(d).toMatchObject({
      repo: 'web',
      readOnly: true,
      trapAny: true,
      limits: { wallClockSecs: 900, maxTurns: 40, maxBudgetUsd: 3 },
      systemRepair: { trapWaitUntil: new Date(NOW + 600_000).toISOString() },
    });
    expect(d.brief).toContain(reviewRoundDir(KEY, 'RRE_7')!);
    expect(d.brief).toContain('Do not post, approve, request changes, comment on, push to, or edit the PR.');
    expect(d.brief.endsWith('\n\nFlag missing tests.\n\nCheck the migration order.')).toBe(true); // [hooks.brief], then the repo's
    expect(fs.existsSync(reviewRoundDir(KEY, 'RRE_7')!)).toBe(true);
    draftReviews('chris', () => {}, NOW); // one job per round
    expect(pendingIds('chore')).toHaveLength(1);
  });

  it('work = headless queues for the daemon; work = off starts nothing', () => {
    config('work = "headless"');
    request();
    draftReviews('chris', () => {}, NOW);
    expect(queuedDescriptor(round().dispatch!, 'chore')!.trapAny).toBeUndefined();

    config('work = "off"');
    request({ number: 8 });
    draftReviews('chris', () => {}, NOW);
    expect(round('review:acme/web#8')).toMatchObject({ state: 'requested' });
    expect(round('review:acme/web#8').reason).toBeUndefined();
  });

  it('a skip rule, an unconfigured repo, and the daily cap start no job and say why', () => {
    config('maxPerDay = 1');
    request({ number: 1, skip: 'skipped: author dana is in skipAuthors' });
    request({ number: 2, repoKey: null });
    request({ number: 3 });
    request({ number: 4 });
    draftReviews('chris', () => {}, NOW);
    expect(round('review:acme/web#1')).toMatchObject({ state: 'requested', reason: 'skipped: author dana is in skipAuthors' });
    expect(round('review:acme/web#2').reason).toContain('not a configured repo');
    const states = [round('review:acme/web#3'), round('review:acme/web#4')];
    expect(states.filter((r) => r.state === 'drafting')).toHaveLength(1);
    expect(states.find((r) => r.state === 'requested')!.reason).toBe('no job: the daily cap ([reviews].maxPerDay = 1) is reached');
    expect(pendingIds('chore')).toHaveLength(1);
  });
});

describe('finishing a review job', () => {
  function drafting(): string {
    config('work = "headless"');
    request();
    draftReviews('chris', () => {}, NOW);
    const id = round().dispatch!;
    claimNext('chore');
    return id;
  }

  it('done with review.md and comments.json: drafted', () => {
    const id = drafting();
    const dir = reviewRoundDir(KEY, 'RRE_7')!;
    fs.writeFileSync(path.join(dir, 'review.md'), 'Looks right; one question inline.');
    fs.writeFileSync(path.join(dir, 'comments.json'), JSON.stringify([{ path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'Why not reuse b()?' }]));
    appendStatus(id, 'chore', 'done', 'drafted', '2026-10-15T12:10:00.000Z');
    draftReviews('chris', () => {}, NOW + 600_000);
    expect(round()).toMatchObject({ state: 'drafted', draftedAt: '2026-10-15T12:10:00.000Z' });
  });

  it('done without a draft, or with bad comments, or failed: failed with the reason', () => {
    const id = drafting();
    appendStatus(id, 'chore', 'done', 'drafted');
    draftReviews('chris', () => {}, NOW);
    expect(round()).toMatchObject({ state: 'failed' });
    expect(round().reason).toContain('no review.md');

    const item = readReview(KEY)!;
    Object.assign(item.rounds[0]!, { state: 'drafting' });
    writeReview(item);
    const dir = reviewRoundDir(KEY, 'RRE_7')!;
    fs.writeFileSync(path.join(dir, 'review.md'), 'ok');
    fs.writeFileSync(path.join(dir, 'comments.json'), JSON.stringify([{ path: 'a.ts', line: 0, body: 'x' }]));
    draftReviews('chris', () => {}, NOW);
    expect(round().reason).toContain('comments.json entry 0 needs path, a positive line, and a body');
  });

  it('a failed job fails the round', () => {
    const id = drafting();
    appendStatus(id, 'chore', 'failed', 'wall clock');
    draftReviews('chris', () => {}, NOW);
    expect(round()).toMatchObject({ state: 'failed', reason: 'the review job failed: wall clock' });
  });

  it('a head that moved while the job ran makes the draft stale', () => {
    const id = drafting();
    fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'review.md'), 'fine');
    request({ head: 'bbbbbbb2' });
    appendStatus(id, 'chore', 'done', 'drafted');
    draftReviews('chris', () => {}, NOW);
    expect(round()).toMatchObject({ state: 'stale', headSha: 'aaaaaaa1' });
  });

  it('a trap job no trap took in time goes to the daemon', () => {
    config();
    request();
    draftReviews('chris', () => {}, NOW);
    const id = round().dispatch!;
    draftReviews('chris', () => {}, NOW + 599_000);
    expect(queuedDescriptor(id, 'chore')!.trapAny).toBe(true);
    draftReviews('chris', () => {}, NOW + 600_000);
    expect(queuedDescriptor(id, 'chore')).toMatchObject({ systemRepair: {} });
    expect(queuedDescriptor(id, 'chore')!.trapAny).toBeUndefined();
  });

  it("a withdrawn round's running job is cancelled", () => {
    const id = drafting();
    const item = readReview(KEY)!;
    item.rounds[0]!.state = 'withdrawn';
    writeReview(item);
    draftReviews('chris', () => {}, NOW);
    expect(fs.existsSync(path.join(laneDirs('chore').active, id, 'cancel'))).toBe(true);
  });
});

describe('the review checkout', () => {
  let repo: string;
  const git = (...args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const checkout = () => reviewCheckoutDir(KEY, 'RRE_7')!;
  const listed = () => git('worktree', 'list', '--porcelain').stdout.includes(path.basename(path.dirname(checkout())));

  beforeEach(() => {
    repo = path.join(home, 'web');
    fs.mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one');
    fs.writeFileSync(path.join(home, 'config.toml'), ['[reviews]', 'enabled = true', 'work = "headless"', '[repos.web]', `path = '${repo.replaceAll('\\', '/')}'`].join('\n'));
  });

  /** A drafting round whose job made its checkout where the brief said, the way `git worktree add --detach` does. */
  function drafting(): string {
    request();
    draftReviews('chris', () => {}, NOW);
    const id = round().dispatch!;
    claimNext('chore');
    expect(queuedOrActiveBrief(id)).toContain(`git worktree add --detach ${checkout()} FETCH_HEAD`);
    git('worktree', 'add', '-q', '--detach', checkout(), 'HEAD');
    expect(fs.existsSync(checkout())).toBe(true);
    return id;
  }
  const queuedOrActiveBrief = (id: string): string => JSON.parse(fs.readFileSync(path.join(laneDirs('chore').active, id, 'descriptor.json'), 'utf8')).brief;
  const gone = () => {
    expect(fs.existsSync(checkout())).toBe(false);
    expect(git('worktree', 'list', '--porcelain').stdout).not.toContain(checkout());
  };

  it('is removed when the round is drafted', () => {
    const id = drafting();
    fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'review.md'), 'Fine.');
    appendStatus(id, 'chore', 'done', 'drafted');
    draftReviews('chris', () => {}, NOW);
    expect(round().state).toBe('drafted');
    gone();
  });

  it('is removed when the draft is stale', () => {
    const id = drafting();
    fs.writeFileSync(path.join(reviewRoundDir(KEY, 'RRE_7')!, 'review.md'), 'Fine.');
    request({ head: 'bbbbbbb2' });
    appendStatus(id, 'chore', 'done', 'drafted');
    draftReviews('chris', () => {}, NOW);
    expect(round().state).toBe('stale');
    gone();
  });

  it('is removed when the job fails', () => {
    const id = drafting();
    appendStatus(id, 'chore', 'failed', 'wall clock');
    draftReviews('chris', () => {}, NOW);
    expect(round().state).toBe('failed');
    gone();
  });

  it("is removed once a withdrawn round's job ends, not while it still runs", () => {
    const id = drafting();
    const item = readReview(KEY)!;
    item.rounds[0]!.state = 'withdrawn';
    writeReview(item);
    draftReviews('chris', () => {}, NOW);
    expect(fs.existsSync(path.join(laneDirs('chore').active, id, 'cancel'))).toBe(true);
    expect(fs.existsSync(checkout())).toBe(true); // the job may still be in it
    appendStatus(id, 'chore', 'failed', 'cancelled by request');
    draftReviews('chris', () => {}, NOW);
    gone();
  });

  it('is removed for a round a re-request superseded, once its cancelled job ends', () => {
    const id = drafting();
    observeReviewRequest(
      {
        pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 'Add the thing', author: 'dana', headSha: 'aaaaaaa1', repoKey: 'web' },
        round: { id: 'RRE_7b', requestedAt: '2026-10-15T11:30:00Z', requestedBy: 'dana' },
      },
      NOW,
    );
    expect(readReview(KEY)!.rounds[0]).toMatchObject({ state: 'withdrawn', reason: 'superseded by a new request' });
    draftReviews('chris', () => {}, NOW);
    expect(fs.existsSync(path.join(laneDirs('chore').active, id, 'cancel'))).toBe(true);
    appendStatus(id, 'chore', 'failed', 'cancelled by request');
    draftReviews('chris', () => {}, NOW);
    gone();
  });

  it('is a no-op when the path is absent', () => {
    const id = drafting();
    git('worktree', 'remove', '--force', checkout());
    appendStatus(id, 'chore', 'failed', 'wall clock');
    const logs: string[] = [];
    draftReviews('chris', (m) => logs.push(m), NOW);
    expect(round().state).toBe('failed');
    expect(logs.some((m) => m.includes('removed the review checkout'))).toBe(false);
    expect(listed()).toBe(false);
  });
});

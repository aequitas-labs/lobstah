import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { latestRound, observeReviewRequest, readReview, readRoundDraft, reviewBrief, reviewRoundDir, writeReview } from '../src/reviews.js';
import type { ReviewThread } from '../src/reviews.js';
import { fixedReviewThreads, ownReviewThreads, parseReviewThreadCalls, reviewThreadReplies } from '../src/review-threads.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const key = 'review:acme/web#7';
const draft = { roundId: 'round2', headSha: 'bbb', draftedAt: '2026-11-18T12:00:00Z' };
const thread = (id: string, author: string, line: number | null = 4): ReviewThread => ({
  id, path: 'src/a.ts', line, isOutdated: false, comments: [{ author, body: 'Possible race', url: `https://github.com/acme/web/pull/7#discussion_${id}` }, { author: 'dana', body: 'Fixed.', url: 'u' }],
});
const OPEN = [thread('mine-fixed', 'Chris'), thread('mine-partly', 'chris'), thread('theirs', 'sam'), thread('bot', 'coderabbitai[bot]')];
const CALLS = [
  { id: 'mine-fixed', status: 'addressed', reason: 'The retry now holds the lock.' },
  { id: 'mine-partly', status: 'partly', reason: 'Only one caller is fixed.', reply: 'The second caller in b.ts still races.' },
  { id: 'theirs', status: 'addressed', reason: 'Fixed too.' },
  { id: 'bot', status: 'addressed', reason: 'Fixed too.' },
];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-review-threads-'));
  process.env.LOBSTAH_HOME = home;
  fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\nidentity = "chris"\n');
  const item = observeReviewRequest({
    pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 'Retry', author: 'dana', headSha: draft.headSha },
    round: { id: draft.roundId, requestedAt: draft.draftedAt },
  }).item;
  Object.assign(item.rounds[0]!, { state: 'drafted', draftedAt: draft.draftedAt, openThreads: OPEN });
  writeReview(item);
  const dir = reviewRoundDir(key, draft.roundId)!;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review.md'), '');
  fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ verdict: 'comment', blocking: [], threads: CALLS }));
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

describe('thread calls in the draft', () => {
  it('reads thread calls from verdict.json; a reply alone carries a comment draft', () => {
    const read = readRoundDraft(key, draft.roundId);
    expect(read).toMatchObject({ verdict: 'comment', threads: [
      { id: 'mine-fixed', status: 'addressed', reason: 'The retry now holds the lock.' },
      { id: 'mine-partly', status: 'partly', reply: 'The second caller in b.ts still races.' },
      { id: 'theirs' }, { id: 'bot' },
    ] });
  });

  it.each([
    [{}, 'threads must be an array'],
    [[{ id: 'a', status: 'done', reason: 'x' }], 'thread status must be addressed, partly, or not'],
    [[{ id: 'a', status: 'addressed', reason: 'two\nlines' }], 'each thread needs a one-line reason'],
    [[{ id: 'a', status: 'not', reason: 'x' }, { id: 'a', status: 'not', reason: 'y' }], 'thread ids must be unique'],
  ])('refuses malformed thread calls %#', (raw, why) => {
    expect(parseReviewThreadCalls(raw)).toBe(why);
  });

  it('drops a reply on an addressed thread, since it is resolved', () => {
    expect(parseReviewThreadCalls([{ id: 'a', status: 'addressed', reason: 'Fixed.', reply: 'Thanks' }])).toEqual([{ id: 'a', status: 'addressed', reason: 'Fixed.' }]);
  });

  it('a draft without threads has none', () => {
    fs.writeFileSync(path.join(reviewRoundDir(key, draft.roundId)!, 'verdict.json'), JSON.stringify({ verdict: 'approve', blocking: [] }));
    expect(readRoundDraft(key, draft.roundId)).toMatchObject({ threads: [] });
  });
});

describe('only the reviewer’s own threads', () => {
  it('keeps threads the identity opened, matching login case-insensitively', () => {
    expect(ownReviewThreads(OPEN, 'chris').map(t => t.id)).toEqual(['mine-fixed', 'mine-partly']);
    expect(ownReviewThreads(OPEN, undefined)).toEqual([]);
  });

  it('treats only fully addressed calls on own threads as fixed, with the reason and a link', () => {
    const round = latestRound(readReview(key)!)!;
    expect(fixedReviewThreads(round, CALLS as never, 'chris')).toEqual([
      { id: 'mine-fixed', path: 'src/a.ts', line: 4, url: 'https://github.com/acme/web/pull/7#discussion_mine-fixed', reason: 'The retry now holds the lock.' },
    ]);
    expect(fixedReviewThreads({}, CALLS as never, 'chris')).toEqual([]);
  });

  it('writes replies only for own threads that stay open', () => {
    const round = latestRound(readReview(key)!)!;
    expect(reviewThreadReplies(round, [...CALLS, { id: 'theirs', status: 'not', reason: 'x', reply: 'no' }] as never, 'chris')).toBe(
      '**Earlier threads**\n\n- [src/a.ts:4](https://github.com/acme/web/pull/7#discussion_mine-partly): The second caller in b.ts still races.');
  });

  it('the brief lists only the identity’s own open thread ids', () => {
    const item = readReview(key)!;
    const brief = reviewBrief(item, latestRound(item)!, { identity: 'chris', id: 'job', outDir: '/tmp/d', checkout: '/tmp/c' });
    expect(brief).toContain('Threads chris opened that are still unresolved (ids): ["mine-fixed","mine-partly"]');
    expect(brief).toContain('lobstah resolves those threads as soon as this draft is done');
    const none = reviewBrief(item, { ...latestRound(item)!, openThreads: [thread('theirs', 'sam')] }, { identity: 'chris', id: 'job', outDir: '/tmp/d', checkout: '/tmp/c' });
    expect(none).not.toContain('Threads chris opened');
  });
});

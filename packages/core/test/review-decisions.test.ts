import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { answerReviewDecision, latestRound, observeReviewRequest, readReview, readRoundDraft, redraftReview, reviewBrief, reviewRoundDir, writeReview } from '../src/reviews.js';
import { carryReviewDecisionAnswers, parseReviewDecisions, unansweredReviewDecisions } from '../src/review-decisions.js';
import { REVIEW_DECISIONS } from '../../../test/review-decisions.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const key = 'review:acme/web#7';
const draft = { roundId: 'round1', headSha: 'aaa', draftedAt: '2026-11-16T12:00:00Z' };
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-review-decisions-'));
  process.env.LOBSTAH_HOME = home;
  const item = observeReviewRequest({
    pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 'Release defaults', author: 'dana', headSha: 'aaa' },
    round: { id: draft.roundId, requestedAt: draft.draftedAt },
  }).item;
  Object.assign(item.rounds[0]!, { state: 'drafted', draftedAt: draft.draftedAt, decisions: REVIEW_DECISIONS });
  writeReview(item);
  const dir = reviewRoundDir(key, draft.roundId)!;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review.md'), '');
  fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ verdict: 'comment', blocking: [], decisions: REVIEW_DECISIONS }));
});
afterEach(() => { removeTempDir(home); delete process.env.LOBSTAH_HOME; });

describe('review decisions', () => {
  it('reads explicitly typed calls beside findings, including a decision-only comment draft', () => {
    expect(readRoundDraft(key, draft.roundId)).toMatchObject({ verdict: 'comment', body: '', blocking: [], decisions: REVIEW_DECISIONS });
    const item = readReview(key)!;
    const brief = reviewBrief(item, latestRound(item)!, { identity: 'chris', id: 'job', outDir: '/tmp/draft', checkout: '/tmp/checkout' });
    expect(brief).toContain('Only real product or ownership calls');
    expect(brief).toContain('Free-text answers are always allowed');
    expect(brief).toContain('rollout-owner');
    expect(parseReviewDecisions(undefined)).toEqual([]);
  });

  it.each([
    null, {}, [null], [{ ...REVIEW_DECISIONS[0], question: 'two\nlines' }],
    [{ ...REVIEW_DECISIONS[0], recommendation: 'missing' }],
    [REVIEW_DECISIONS[0], REVIEW_DECISIONS[0]],
    [{ ...REVIEW_DECISIONS[0], options: [] }],
    [{ ...REVIEW_DECISIONS[0], options: [REVIEW_DECISIONS[0]!.options[0], REVIEW_DECISIONS[0]!.options[0]] }],
    [{ ...REVIEW_DECISIONS[0], options: [{ id: 'a', label: '', consequence: 'x' }, REVIEW_DECISIONS[0]!.options[1]] }],
  ])('rejects malformed calls: %j', value => {
    expect(typeof parseReviewDecisions(value)).toBe('string');
    fs.writeFileSync(path.join(reviewRoundDir(key, draft.roundId)!, 'verdict.json'), JSON.stringify({ verdict: 'approve', blocking: [], decisions: value }));
    expect(readRoundDraft(key, draft.roundId)).toHaveProperty('error');
  });

  it('saves choices and free text per round, without counting the recommendation as an answer', () => {
    expect(unansweredReviewDecisions(latestRound(readReview(key)!)!)).toHaveLength(2);
    expect(answerReviewDecision(key, draft, 'rollout-owner', { optionId: 'product' })).toBeUndefined();
    expect(answerReviewDecision(key, draft, 'existing-users', { text: '  Ask each user before migrating.  ' })).toBeUndefined();
    const round = latestRound(readReview(key)!)!;
    expect(round.decisionAnswers).toEqual({ 'rollout-owner': { optionId: 'product' }, 'existing-users': { text: 'Ask each user before migrating.' } });
    expect(unansweredReviewDecisions(round)).toEqual([]);
    expect(answerReviewDecision(key, draft, 'rollout-owner', null)).toBeUndefined();
    expect(unansweredReviewDecisions(latestRound(readReview(key)!)!)).toHaveLength(1);
  });

  it('refuses unknown choices, empty answers, old drafts, and edits after posting starts', () => {
    expect(answerReviewDecision(key, draft, 'rollout-owner', { optionId: 'unknown' })).toContain('Choose');
    expect(answerReviewDecision(key, draft, 'rollout-owner', { text: ' ' })).toContain('Choose');
    expect(answerReviewDecision(key, draft, 'missing', { text: 'yes' })).toContain('no longer');
    expect(answerReviewDecision(key, { ...draft, headSha: 'old' }, 'rollout-owner', { text: 'yes' })).toContain('changed');
    fs.writeFileSync(path.join(reviewRoundDir(key, draft.roundId)!, 'posted.json'), '{}');
    expect(answerReviewDecision(key, draft, 'rollout-owner', { text: 'yes' })).toContain('already being posted');
  });

  it('keeps only valid answers to surviving ids when the next draft changes the questions', () => {
    answerReviewDecision(key, draft, 'rollout-owner', { optionId: 'product' });
    answerReviewDecision(key, draft, 'existing-users', { text: 'Ask each user.' });
    const item = readReview(key)!;
    item.pr.headSha = 'bbb'; writeReview(item);
    expect(redraftReview(key)).toMatchObject({ rounds: [{ state: 'requested', headSha: 'bbb', decisionAnswers: { 'rollout-owner': { optionId: 'product' } } }] });
    const answers = latestRound(readReview(key)!)!.decisionAnswers;
    expect(carryReviewDecisionAnswers([REVIEW_DECISIONS[0]!], answers)).toEqual({ 'rollout-owner': { optionId: 'product' } });
    expect(carryReviewDecisionAnswers([{ ...REVIEW_DECISIONS[0]!, options: [{ id: 'new', label: 'New', consequence: 'New meaning' }] }], answers)).toEqual({});
    expect(answerReviewDecision(key, draft, 'rollout-owner', { text: 'old tab' })).toContain('changed');
  });
});

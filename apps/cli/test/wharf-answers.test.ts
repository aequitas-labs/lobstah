import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, latestRound, listGrants, readDecisionAnswer, readReview, standingDecisions, unhandled } from '@lobstah/core';
import type { CardAnswerReceipt, DecisionMeta, TendAttention } from '@lobstah/core';
import { postReview } from '@lobstah/pick';
import { askPermission } from '../src/grants-cli.js';
import { applyReceipt, applyReviewPost, ALLOW_HERE_ONLY, REVIEW_CHANGED, REVIEWS_HERE_ONLY } from '../src/wharf-answers.js';
import { draftReview, github, HEAD, pushAfterDraft, REVIEW_KEY, reviewShown } from './review-draft.js';
import type { Call } from './review-draft.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-answers-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '');
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

const card = (): DecisionMeta => askPermission({ dispatch: 'd-1', lane: 'work', ask: { command: 'wrangler deploy', harness: 'codex' } });
/** What this boat's attention shows for a decision: its key and the state it stands on. */
const shown = (d: DecisionMeta): TendAttention[] => [{ kind: 'decision', key: d.key, stateHash: d.stateHash, id: d.key, lane: 'work', verb: 'decision', ageSecs: 0 }];
let n = 0;
const receipt = (d: DecisionMeta, action: CardAnswerReceipt['action'], extra: Partial<CardAnswerReceipt> = {}): CardAnswerReceipt => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, family: 'permission', key: d.key, stateHash: d.stateHash, revision: 1,
  action, by: 'person-a', at: new Date().toISOString(), state: 'pending', ...extra,
});
const on = { wharfRemoteAnswers: { cloud: true } }, off = { wharfRemoteAnswers: { cloud: false } };

it('an Allow once from the wharf writes the grant a glass click writes, by its receipt, once', () => {
  const d = card(); const r = receipt(d, { kind: 'allow-once' });
  const first = applyReceipt(on, 'cloud', r, shown(d));
  expect(first).toEqual({ state: 'applied', outcome: expect.stringMatching(/^grant /) });
  expect(listGrants().grants).toEqual([expect.objectContaining({ command: 'wrangler deploy', mode: 'once', harness: 'codex', by: `wharf:${r.id}`, dispatch: 'd-1' })]);
  expect(readDecisionAnswer(d.key)).toMatchObject({ option: 'Allow once', by: 'wharf', receipt: r.id });
  expect(unhandled('d-1', 'work').at(-1)!.text).toContain('through the wharf');
  // The same receipt again is the same outcome, and no second grant.
  expect(applyReceipt(on, 'cloud', r, shown(d))).toEqual(first);
  expect(listGrants().grants).toHaveLength(1);
});

it('a boat that takes Allow only in its own glass refuses it; No still answers', () => {
  const d = card();
  expect(applyReceipt(off, 'cloud', receipt(d, { kind: 'allow-always' }), shown(d))).toEqual({ state: 'refused', outcome: ALLOW_HERE_ONLY });
  expect(listGrants().grants).toEqual([]);
  expect(standingDecisions().map((x) => x.key)).toContain(d.key);
  expect(applyReceipt(off, 'cloud', receipt(d, { kind: 'deny' }), shown(d))).toEqual({ state: 'applied', outcome: 'answered' });
  expect(listGrants().grants).toEqual([]);
  expect(unhandled('d-1', 'work').at(-1)!.text).toContain('Do not run it');
});

it('applies only to the exact state answered, and free text or seen never grant', () => {
  const d = card();
  expect(applyReceipt(on, 'cloud', receipt(d, { kind: 'allow-once' }, { stateHash: 'an-older-state' }), shown(d))).toMatchObject({ state: 'refused' });
  expect(applyReceipt(on, 'cloud', receipt(d, { kind: 'allow-once' }), [])).toMatchObject({ state: 'refused' });
  // A permission card takes options, not words: free text is refused and grants nothing.
  expect(applyReceipt(on, 'cloud', receipt(d, { kind: 'answer-text' }, { text: 'sure, go ahead' }), shown(d))).toMatchObject({ state: 'refused' });
  expect(applyReceipt(on, 'cloud', receipt(d, { kind: 'seen' }), shown(d))).toEqual({ state: 'applied', outcome: 'seen' });
  expect(listGrants().grants).toEqual([]);
  expect(standingDecisions().map((x) => x.key)).toContain(d.key);
});

it('after a crash between applying and recording, the same receipt finishes once', () => {
  const d = card(); const r = receipt(d, { kind: 'allow-once' });
  applyReceipt(on, 'cloud', r, shown(d));
  // As if the boat stopped after the answer, before its ledger said so.
  fs.writeFileSync(path.join(home, 'wharf-answers', 'cloud', `${r.id}.json`), '{"state":"applying"}');
  expect(applyReceipt(on, 'cloud', r, [])).toMatchObject({ state: 'applied' });
  expect(listGrants().grants).toHaveLength(1);
});

it('remoteAnswers is on for each listed wharf unless that boat sets it false', async () => {
  const { loadConfig } = await import('@lobstah/core');
  const wharf = (extra: string) => `[wharves.cloud]\nurl = 'https://wharf.invalid'\naccount = 'person'\ntokenEnv = 'LOBSTAH_TEST_TOKEN'\n${extra}\n`;
  fs.writeFileSync(path.join(home, 'config.toml'), wharf(''));
  expect(loadConfig().wharfRemoteAnswers).toEqual({ cloud: true });
  fs.writeFileSync(path.join(home, 'config.toml'), wharf('remoteAnswers = false'));
  expect(loadConfig().wharfRemoteAnswers).toEqual({ cloud: false });
  expect(loadConfig().wharves?.cloud).toEqual({ kind: 'wharf', url: 'https://wharf.invalid', account: 'person', tokenEnv: 'LOBSTAH_TEST_TOKEN' });
  fs.writeFileSync(path.join(home, 'config.toml'), wharf("remoteAnswers = 'no'"));
  expect(() => loadConfig()).toThrow('remoteAnswers must be true or false');
});

it('Allow always through the wharf grants exactly what a glass click grants, scope for scope', async () => {
  const { answerKey } = await import('../src/decision-answer.js');
  const scope = (g: Record<string, unknown>) => Object.fromEntries(Object.entries(g).filter(([k]) => !['id', 'at', 'by', 'uses'].includes(k)));
  const byGlass = card();
  answerKey(byGlass.key, { option: 'Allow always', by: 'glass' });
  const glassGrant = listGrants().grants[0]!;
  const viaWharf = card();
  applyReceipt(on, 'cloud', receipt(viaWharf, { kind: 'allow-always' }), shown(viaWharf));
  const wharfGrant = listGrants().grants.find((g) => g.by.startsWith('wharf:'))!;
  expect(glassGrant.by).toBe('glass');
  expect(scope(wharfGrant as unknown as Record<string, unknown>)).toEqual(scope(glassGrant as unknown as Record<string, unknown>));
});

describe('a drafted review posted from Slack', () => {
  const reviewReceipt = (action: CardAnswerReceipt['action'], stateHash = reviewShown()[0]!.stateHash): CardAnswerReceipt => ({
    id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, family: 'review', key: REVIEW_KEY, stateHash, revision: 1,
    action, by: 'person-a', at: new Date().toISOString(), state: 'pending',
  });
  /** postReview against a fake GitHub whose PR head is `head`. */
  const poster = (calls: Call[], head?: string): typeof postReview => (key, opts) => postReview(key, { ...opts, token: () => 'token', fetch: github(calls, head) });
  const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST');

  it('a confirmed Submit review at the draft’s head posts the draft’s verdict once, by slack', async () => {
    draftReview('request_changes');
    const shownNow = reviewShown(), calls: Call[] = [];
    const r = reviewReceipt({ kind: 'review-submit', event: 'REQUEST_CHANGES', pr: 42 });
    expect(await applyReviewPost(on, 'cloud', r, shownNow, poster(calls))).toEqual({ state: 'applied', outcome: 'posted' });
    expect(posts(calls)).toEqual([expect.objectContaining({ url: 'https://api.github.com/repos/acme/web/pulls/42/reviews', body: expect.objectContaining({ event: 'REQUEST_CHANGES', commit_id: HEAD }) })]);
    expect(latestRound(readReview(REVIEW_KEY)!)).toMatchObject({ state: 'posted', by: 'slack', postedEvent: 'REQUEST_CHANGES' });
    // The same receipt again, and a second tap on the same message, post nothing more.
    expect(await applyReviewPost(on, 'cloud', r, shownNow, poster(calls))).toEqual({ state: 'applied', outcome: 'posted' });
    expect(await applyReviewPost(on, 'cloud', reviewReceipt(r.action, r.stateHash), shownNow, poster(calls))).toEqual({ state: 'refused', outcome: REVIEW_CHANGED });
    expect(posts(calls)).toHaveLength(1);
  });

  it('Approve on an approve draft approves the PR, by slack', async () => {
    draftReview('approve');
    const calls: Call[] = [];
    expect(await applyReviewPost(on, 'cloud', reviewReceipt({ kind: 'review-approve', pr: 42 }), reviewShown(), poster(calls))).toEqual({ state: 'applied', outcome: 'posted' });
    expect(posts(calls).map((c) => c.body!.event)).toEqual(['APPROVE']);
    expect(latestRound(readReview(REVIEW_KEY)!)).toMatchObject({ state: 'posted', by: 'slack', postedEvent: 'APPROVE' });
  });

  it('a PR head that moved past the draft’s head refuses the post and posts nothing', async () => {
    draftReview('request_changes');
    const r = reviewReceipt({ kind: 'review-submit', event: 'REQUEST_CHANGES', pr: 42 });
    // The boat saw the push: the card's state is unchanged, but its head is not the draft's.
    pushAfterDraft();
    const seen: Call[] = [];
    expect(await applyReviewPost(on, 'cloud', r, reviewShown(), poster(seen))).toEqual({ state: 'refused', outcome: REVIEW_CHANGED });
    expect(seen).toEqual([]);
    // The push reached GitHub only: the head check just before the post refuses it.
    draftReview('request_changes');
    expect(readReview(REVIEW_KEY)!.pr.headSha).toBe(HEAD);
    const live: Call[] = [];
    expect(await applyReviewPost(on, 'cloud', reviewReceipt(r.action), reviewShown(), poster(live, 'ccccccc3'))).toEqual({ state: 'refused', outcome: REVIEW_CHANGED });
    expect(posts(live)).toEqual([]);
    expect(latestRound(readReview(REVIEW_KEY)!)).toMatchObject({ state: 'stale' });
  });

  it('a boat with remoteAnswers = false refuses review posts from the wharf', async () => {
    draftReview('approve');
    const calls: Call[] = [];
    for (const action of [{ kind: 'review-submit', event: 'APPROVE', pr: 42 }, { kind: 'review-approve', pr: 42 }] as const) {
      expect(await applyReviewPost(off, 'cloud', reviewReceipt(action), reviewShown(), poster(calls))).toEqual({ state: 'refused', outcome: REVIEWS_HERE_ONLY });
    }
    expect(calls).toEqual([]);
    expect(latestRound(readReview(REVIEW_KEY)!)).toMatchObject({ state: 'drafted' });
  });

  it('a button whose verdict is no longer the draft’s, or a card state that moved, posts nothing', async () => {
    draftReview('request_changes');
    const calls: Call[] = [];
    expect(await applyReviewPost(on, 'cloud', reviewReceipt({ kind: 'review-approve', pr: 42 }), reviewShown(), poster(calls))).toEqual({ state: 'refused', outcome: REVIEW_CHANGED });
    expect(await applyReviewPost(on, 'cloud', reviewReceipt({ kind: 'review-submit', event: 'REQUEST_CHANGES', pr: 42 }, 'an-older-state'), reviewShown(), poster(calls))).toMatchObject({ state: 'refused' });
    expect(calls).toEqual([]);
  });
});

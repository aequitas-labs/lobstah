import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { answerDecision, answeredAt, appendStatus, askDecision, capturePrQuestions, claimNext, enqueue, ensureLayout, listPrQuestions, parsePrRef, prQuestionMarker, readMessageMeta, routePrQuestionReply, sendMessage, standingDecisions, syncDispatchPrQuestions, unhandled } from '../src/index.js';
import type { PrQuestionReply, PrQuestionTransport } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const id = '11111111-1111-4111-8111-111111111111';
const pr = parsePrRef('https://github.com/o/r/pull/42')!;
let askedAt: string;
let comments: PrQuestionReply[];
let reviewComments: PrQuestionReply[];
let transport: PrQuestionTransport;

function reply(over: Partial<PrQuestionReply> = {}): PrQuestionReply {
  return { id: 200, body: '> Which option should I use?\n\nUse option A.', user: { login: 'reviewer', type: 'User' }, created_at: new Date().toISOString(), html_url: `${pr.url}#issuecomment-200`, ...over };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-pr-questions-'));
  process.env.LOBSTAH_HOME = home; ensureLayout();
  askedAt = new Date(Date.now() - 1000).toISOString();
  enqueue({ id, repo: 'r', brief: `Address the feedback at ${pr.url}#discussion_r88`, pr: { url: pr.url } }); claimNext('work');
  appendStatus(id, 'work', 'needs-decision', 'Which option should I use?', askedAt);
  comments = []; reviewComments = [];
  transport = {
    identity: 'lobstah-owner', comments: vi.fn(async () => comments), reviewComments: vi.fn(async () => reviewComments),
    post: vi.fn(async (_pr, body) => {
      const comment = reply({ id: 100, body, user: { login: 'lobstah-owner' }, html_url: `${pr.url}#issuecomment-100` });
      comments.push(comment); return comment;
    }),
    edit: vi.fn(async (_pr, commentId, body) => { comments.find((comment) => comment.id === commentId)!.body = body; }),
  };
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

it('posts a separate question once, carrying the stable hidden marker across repeated polls', async () => {
  await syncDispatchPrQuestions(id, 'work', transport);
  await syncDispatchPrQuestions(id, 'work', transport);
  expect(transport.post).toHaveBeenCalledTimes(1);
  expect(comments[0]?.body).toContain(`<!-- lobstah:question ${id} 1 -->`);
  expect(comments[0]?.body).toContain('Which option should I use?');
  expect(comments[0]?.body.endsWith('<!-- lobstah -->')).toBe(true);
  expect(listPrQuestions()[0]).toMatchObject({ number: 1, commentId: 100, reviewThreadIds: [88] });
});

it('uses the marker to recover a GitHub write whose response was lost', async () => {
  const post = transport.post;
  transport.post = vi.fn(async (ref, body) => { await post(ref, body); throw new Error('lost response'); });
  await expect(syncDispatchPrQuestions(id, 'work', transport)).rejects.toThrow('lost response');
  await syncDispatchPrQuestions(id, 'work', transport);
  expect(transport.post).toHaveBeenCalledTimes(1);
  expect(listPrQuestions()[0]?.commentId).toBe(100);
});

it('serializes concurrent publishers and never posts one question twice', async () => {
  await Promise.all([syncDispatchPrQuestions(id, 'work', transport), syncDispatchPrQuestions(id, 'work', transport)]);
  expect(transport.post).toHaveBeenCalledTimes(1);
});

it('assigns a different question number to a later question and keeps old reply receipts', async () => {
  await syncDispatchPrQuestions(id, 'work', transport);
  appendStatus(id, 'work', 'working', 'Continuing');
  appendStatus(id, 'work', 'needs-decision', 'What about B?');
  const rows = capturePrQuestions(id, 'work');
  expect(rows.map((question) => question.number)).toEqual([1, 2]);
  expect(prQuestionMarker(rows[1]!)).toBe(`<!-- lobstah:question ${id} 2 -->`);
});

it('keeps permission questions out of PR comments', () => {
  const other = 'permission'; enqueue({ id: other, repo: 'r', brief: 'Work', pr: { url: pr.url } }); claimNext('work');
  appendStatus(other, 'work', 'needs-decision', 'Permission required', undefined, undefined, true, true);
  expect(capturePrQuestions(other, 'work')).toEqual([]);
});

it('routes a quote reply as one inbox answer and records it so a feedback poll can skip it forever', async () => {
  await syncDispatchPrQuestions(id, 'work', transport);
  expect(routePrQuestionReply(pr, reply(), transport.identity)).toBe(true);
  expect(routePrQuestionReply(pr, reply(), transport.identity)).toBe(true);
  expect(unhandled(id, 'work')).toHaveLength(1);
  expect(unhandled(id, 'work')[0]?.text).toContain('Use option A');
  expect(readMessageMeta(id, 'work', unhandled(id, 'work')[0]!.file)?.questionAt).toBe(askedAt);
  appendStatus(id, 'work', 'working', 'Working again');
  expect(routePrQuestionReply(pr, reply(), transport.identity)).toBe(true);
  expect(unhandled(id, 'work')).toHaveLength(1);
});

it('accepts an explicit question-comment link and review-thread replies from its origin', async () => {
  await syncDispatchPrQuestions(id, 'work', transport);
  expect(routePrQuestionReply(pr, reply({ body: `${pr.url}#issuecomment-100: use A` }), transport.identity)).toBe(true);
  expect(unhandled(id, 'work')).toHaveLength(1);
  // A second referenced answer is recognized, but cannot replace the first one.
  expect(routePrQuestionReply(pr, reply({ id: 201, body: 'Use B', in_reply_to_id: 88 }), transport.identity, 'review')).toBe(true);
  expect(unhandled(id, 'work')).toHaveLength(1);
});

it.each([{ login: 'automation[bot]', type: 'Bot' }, { login: 'lobstah-owner', type: 'User' }, { login: 'LOBSTAH-OWNER', type: 'User' }])('ignores answers from $login without waking a feedback round', async (user) => {
  await syncDispatchPrQuestions(id, 'work', transport);
  expect(routePrQuestionReply(pr, reply({ user }), transport.identity)).toBe(true);
  expect(unhandled(id, 'work')).toEqual([]);
  expect(answeredAt(id, 'work', askedAt)).toBeUndefined();
});

it('leaves unrelated human comments available to feedback pickup', async () => {
  await syncDispatchPrQuestions(id, 'work', transport);
  expect(routePrQuestionReply(pr, reply({ body: 'Also handle pagination' }), transport.identity)).toBe(false);
  expect(unhandled(id, 'work')).toEqual([]);
});

it('marks the PR question answered after a terminal send and never lets a later PR reply replace it', async () => {
  await syncDispatchPrQuestions(id, 'work', transport);
  sendMessage(id, 'work', 'Use terminal choice', 'terminal');
  const first = answeredAt(id, 'work', askedAt);
  comments.push(reply());
  await syncDispatchPrQuestions(id, 'work', transport);
  expect(unhandled(id, 'work')).toHaveLength(1);
  expect(answeredAt(id, 'work', askedAt)).toBe(first);
  expect(comments[0]?.body).toContain('Answered in lobstah at');
  expect(transport.edit).toHaveBeenCalledTimes(1);
  await syncDispatchPrQuestions(id, 'work', transport);
  expect(transport.edit).toHaveBeenCalledTimes(1);
});

it('lets glass win atomically, delivers its answer immediately, and updates the PR acknowledgement', async () => {
  await syncDispatchPrQuestions(id, 'work', transport);
  const decision = askDecision({ dispatch: id, lane: 'work', title: 'Choose an option', askedBy: 'worker', maxBytes: 1000 }).meta;
  answerDecision({ key: decision.key, text: 'Use glass choice', by: 'glass', maxBytes: 1000 });
  expect(unhandled(id, 'work')).toHaveLength(1);
  expect(unhandled(id, 'work')[0]?.text).toBe('Use glass choice');
  routePrQuestionReply(pr, reply(), transport.identity);
  expect(unhandled(id, 'work')).toHaveLength(1);
  await syncDispatchPrQuestions(id, 'work', transport);
  expect(comments[0]?.body).toContain('Answered in lobstah at');
});

it('lets the PR win, removes the glass card, and rejects a stale glass answer even after work resumes', async () => {
  await syncDispatchPrQuestions(id, 'work', transport);
  const decision = askDecision({ dispatch: id, lane: 'work', title: 'Choose an option', askedBy: 'worker', maxBytes: 1000 }).meta;
  expect(standingDecisions().map((item) => item.key)).toContain(decision.key);
  routePrQuestionReply(pr, reply(), transport.identity);
  expect(standingDecisions().map((item) => item.key)).not.toContain(decision.key);
  appendStatus(id, 'work', 'working', 'Continuing');
  expect(standingDecisions().map((item) => item.key)).not.toContain(decision.key);
  expect(() => answerDecision({ key: decision.key, text: 'Use glass choice', by: 'glass', maxBytes: 1000 })).toThrow('already been answered');
  expect(unhandled(id, 'work')).toHaveLength(1);
});

it('an explicit link to an answered question cannot answer a newer question with identical wording', async () => {
  await syncDispatchPrQuestions(id, 'work', transport);
  sendMessage(id, 'work', 'First answer', 'terminal');
  appendStatus(id, 'work', 'working', 'Continuing');
  const newer = appendStatus(id, 'work', 'needs-decision', 'Which option should I use?');
  capturePrQuestions(id, 'work');
  expect(routePrQuestionReply(pr, reply({ body: `${pr.url}#issuecomment-100\n\n> Which option should I use?\n\nStill use A.` }), transport.identity)).toBe(true);
  expect(unhandled(id, 'work')).toHaveLength(1);
  expect(answeredAt(id, 'work', newer.at)).toBeUndefined();
});

it('does not publish an obsolete question first discovered after work already resumed', async () => {
  appendStatus(id, 'work', 'working', 'The question was resolved');
  await syncDispatchPrQuestions(id, 'work', transport);
  expect(transport.post).not.toHaveBeenCalled();
});

it('does not treat every thread listed in a feedback brief as the question origin', () => {
  const other = '22222222-2222-4222-8222-222222222222';
  enqueue({ id: other, repo: 'r', brief: `${pr.url}#discussion_r88\n${pr.url}#discussion_r89`, pr: { url: pr.url, reviewThreadId: 88 } }); claimNext('work');
  appendStatus(other, 'work', 'needs-decision', 'A different question', askedAt);
  const question = capturePrQuestions(other, 'work')[0]!;
  expect(question.reviewThreadIds).toEqual([88]);
  expect(routePrQuestionReply(pr, reply({ body: 'Unrelated review feedback', in_reply_to_id: 89 }), transport.identity, 'review')).toBe(false);
});

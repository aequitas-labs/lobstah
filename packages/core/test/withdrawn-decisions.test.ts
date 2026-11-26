import { beforeEach, afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendStatus, askDecision, answerDecision, enqueue, ensureLayout, readDecision, readArchivedDecision, readThread, standingDecisions, startHelmThread, threadView, threadSummaries, threadSubscriberNotices, withdrawDecision, sayThread, markThreadResponsesSeen } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const dispatch = 'aaaaaaaa-1111-4000-8000-000000000001';
const asked = new Date('2026-11-25T10:00:00Z');
const finished = new Date('2026-11-25T11:00:00Z');
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-withdrawn-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  enqueue({ id: dispatch, repo: 'web', brief: 'Fix the card' });
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

it.each(['done', 'failed'])('keeps helm questions open and withdraws only unanswered worker cards on %s', (verb) => {
  appendStatus(dispatch, 'work', 'needs-decision', 'Which option?', asked.toISOString());
  const ask = (askedBy: string, lane: 'work' | 'chore' = 'work', id = dispatch) => askDecision({ title: 'Which option?', options: ['Yes'], dispatch: id, lane, askedBy, maxBytes: 100, now: asked }).meta;
  const helm = ask('helm');
  const worker = ask('worker');
  const answered = askDecision({ title: 'Allow this?', options: ['Yes'], dispatch, askedBy: 'worker', permission: { harness: 'any', command: 'echo ok' }, maxBytes: 100, now: asked }).meta;
  const otherLane = ask('worker', 'chore');
  const otherDispatch = ask('worker', 'work', 'other');
  answerDecision({ key: answered.key, option: 'Yes', by: 'glass', maxBytes: 100 });
  appendStatus(dispatch, 'work', verb, 'Finished', finished.toISOString());
  expect(standingDecisions().map(card => card.key)).toContain(helm.key);
  expect(readDecision(worker.key)).toBeUndefined();
  expect(readArchivedDecision(worker.key)?.withdrawal).toEqual({ at: finished.toISOString(), reason: 'its dispatch finished' });
  expect(readDecision(answered.key)).toBeDefined();
  expect(readDecision(otherLane.key)).toBeDefined();
  expect(readDecision(otherDispatch.key)).toBeDefined();
});

it('retains the withdrawn question, time and reason without counting its card or ready notice', () => {
  const thread = startHelmThread({ grounds: 'home', title: 'Navigation', now: asked });
  markThreadResponsesSeen(thread.id, thread.responseSeq!);
  const card = askDecision({ title: 'Which tab?', detailText: 'Choose a tab', options: ['Helm'], thread: thread.id, askedBy: 'helm', maxBytes: 100, now: asked }).meta;
  expect(threadSummaries()[0]?.unreadResponse).toBe(true);
  withdrawDecision(card.key, 'its dispatch finished', finished);
  const retained = threadView(readThread(thread.id)!);
  expect(retained.cards).toEqual([{ key: card.key, title: 'Which tab?', options: ['Helm'], standing: false, withdrawal: { at: finished.toISOString(), reason: 'its dispatch finished' } }]);
  expect(retained.tracked).toMatchObject([{ status: 'withdrawn', state: 'done' }]);
  expect(threadSummaries()[0]).toMatchObject({ cards: [], unreadResponse: false });
  expect(threadSubscriberNotices()).toEqual([]);
  expect(() => answerDecision({ key: card.key, option: 'Helm', by: 'glass', maxBytes: 100 })).toThrow();
});

it('preserves unread helm messages when their following card is withdrawn', () => {
  const thread = startHelmThread({ grounds: 'home', title: 'Navigation', now: asked });
  markThreadResponsesSeen(thread.id, thread.responseSeq!);
  sayThread(thread.id, { text: 'Please read this too' });
  const card = askDecision({ title: 'Which tab?', thread: thread.id, askedBy: 'helm', maxBytes: 100 }).meta;
  withdrawDecision(card.key);
  expect(threadSummaries()[0]?.unreadResponse).toBe(true);
});

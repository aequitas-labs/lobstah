import { beforeEach, afterEach, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureLayout, startHelmThread, startThread, noteThread, readThread, threadView, threadSummaries, askDecision, readDecision, listNotices, listThreads, responseState, linkThreadDispatch, checkThreadForLink, resolveThread } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const at = new Date('2026-11-21T10:00:00Z');
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-helm-threads-')); process.env.LOBSTAH_HOME = home; ensureLayout(); });
afterEach(() => { removeTempDir(home); delete process.env.LOBSTAH_HOME; });
const card = (title: string, thread?: string) => askDecision({ title, ...(thread ? { thread } : {}), options: ['Yes'], askedBy: 'helm', maxBytes: 100 }).meta;

it('starts a helm thread unread for the person, waiting on no one, with its summary as the first message', () => {
  const item = startHelmThread({ grounds: 'home', title: 'Parked traps and ume approvals', detail: 'We discussed this across three cards.', now: at });
  expect(item).toMatchObject({ kind: 'thread', state: 'open', startedBy: 'helm', title: 'Parked traps and ume approvals' });
  expect(item.rounds[0]?.entries).toEqual([{ by: 'helm', text: 'We discussed this across three cards.', attachments: [], at: at.toISOString(), seq: 1 }]);
  expect(responseState(item)).toMatchObject({ unreadResponse: true, responseText: 'We discussed this across three cards.' });
  expect(threadSummaries('home')[0]).toMatchObject({ id: item.id, startedBy: 'helm', unreadResponse: true, waitingForHelm: false });
  // The helm needs no reminder about its own thread.
  expect(listNotices()).toEqual([]);
  const bare = startHelmThread({ grounds: 'home', title: 'No summary yet', now: at });
  expect(bare.rounds[0]?.entries).toEqual([]);
  expect(responseState(bare)).toMatchObject({ unreadResponse: true, responseText: 'No summary yet' });
});

it('links dispatches, PRs and existing cards at the start, and writes nothing for a bad link', () => {
  const existing = card('Keep the trap parked?');
  const item = startHelmThread({ grounds: 'home', title: 'Parked traps', links: [`decision:${existing.key}`, 'dispatched:abc-123', 'pr:https://github.com/o/r/pull/7'], now: at });
  expect(item.rounds[0]?.entries).toMatchObject([{ card: existing.key }, { link: 'dispatched', ref: 'abc-123' }, { link: 'pr', ref: 'https://github.com/o/r/pull/7' }]);
  expect(readDecision(existing.key)?.thread).toBe(item.id);
  expect(threadView(readThread(item.id)!).cards).toMatchObject([{ key: existing.key, standing: true }]);
  expect(() => startHelmThread({ grounds: 'home', title: 'Missing card', links: ['decision:decision:00000000'] })).toThrow('No card');
  expect(() => startHelmThread({ grounds: 'home', title: 'Same card again', links: [`decision:${existing.key}`] })).toThrow('another conversation');
  expect(() => startHelmThread({ grounds: 'home', title: 'Bad kind', links: ['todo:3'] })).toThrow('Choose a dispatch');
  expect(listThreads().map((t) => t.id)).toEqual([item.id]);
});

it('attaches an existing card with man note --link decision:, once, as a reply the person reads', () => {
  const item = startThread({ grounds: 'home', text: 'Where do approvals go?', now: at });
  const asked = card('Approve in ume?');
  const before = readThread(item.id)!.responseSeq ?? 0;
  const linked = noteThread(item.id, { link: `decision:${asked.key.slice('decision:'.length)}` }, at);
  expect(linked.rounds.at(-1)?.entries.at(-1)).toEqual({ card: asked.key });
  expect(linked.responseSeq).toBe(before + 1);
  expect(readDecision(asked.key)?.thread).toBe(item.id);
  const again = noteThread(item.id, { link: `decision:${asked.key}` }, at);
  expect(again.rounds.flatMap((r) => r.entries).filter((e) => 'card' in e)).toHaveLength(1);
  expect(again.responseSeq).toBe(before + 1);
});

it('keeps a replacement card in the replaced card\'s thread, and drops the gone card from the view', () => {
  const item = startHelmThread({ grounds: 'home', title: 'Approvals', now: at });
  const first = card('Approve in ume?', item.id);
  const { meta: second, replaced } = askDecision({ title: 'Approve in the glass instead?', options: ['Yes'], replace: first.key, askedBy: 'helm', maxBytes: 100 });
  expect(replaced).toEqual([first.key]);
  expect(second.thread).toBe(item.id);
  expect(threadView(readThread(item.id)!).cards.map((c) => c.key)).toEqual([second.key]);
  // A card attached with man note keeps its thread through --replace too.
  const loose = card('Loose card');
  noteThread(item.id, { link: `decision:${loose.key}` }, at);
  expect(askDecision({ title: 'Loose card, reworded', replace: loose.key, askedBy: 'helm', maxBytes: 100 }).meta.thread).toBe(item.id);
  // Resolving with a standing card keeps the thread tracking, so its replacement still joins it.
  const done = startHelmThread({ grounds: 'home', title: 'Done', now: at });
  const last = card('Last one?', done.id);
  expect(resolveThread(done.id, 'answered', 'Settled').state).toBe('tracking');
  expect(askDecision({ title: 'Last one, again?', replace: last.key, askedBy: 'helm', maxBytes: 100 }).meta.thread).toBe(done.id);
});

it('checks a thread before work links to it and names the dispatch for its brief', () => {
  const item = startHelmThread({ grounds: 'home', title: 'Approvals', now: at });
  expect(() => checkThreadForLink(item.id, 'other')).toThrow('another grounds');
  expect(() => checkThreadForLink('abcdef01-1234-4000-8000-abcdef012345', 'home')).toThrow('not found');
  expect(checkThreadForLink(item.id, 'home').id).toBe(item.id);
  const before = readThread(item.id)!.responseSeq;
  const linked = linkThreadDispatch(item.id, 'abc-123', '# Fix the approval card\n\nDetails', at);
  expect(linked.rounds.at(-1)?.entries.at(-1)).toMatchObject({ link: 'dispatched', ref: 'abc-123', text: 'Fix the approval card' });
  expect(linked.responseSeq).toBe(before);
  expect(threadView(linked).tracked).toMatchObject([{ kind: 'dispatch', ref: 'abc-123' }]);
});

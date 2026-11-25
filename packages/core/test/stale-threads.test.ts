import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureLayout, THREAD_STALE_MS, noticeStaleThreads, staleThreadNoticeStands, threadQuietSince, startHelmThread, sayThread, postThread, noteThread, resolveThread, listNotices, unseenNotices, askDecision, answerDecision, enqueue, claimNext, appendStatus, addTodo, closeTodo, parsePrRef, prEvidence, upsertPr, noticeWakes, takeHelm, helmOf, readThread } from '../src/index.js';
import type { GhPrView } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const at = new Date('2026-11-25T10:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-stale-threads-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => { vi.useRealTimers(); delete process.env.LOBSTAH_HOME; removeTempDir(home); });

it('notifies at 24 hours, once per quiet spell, and resets after either person or helm activity', () => {
  const item = startHelmThread({ grounds: 'home', title: 'Outreach reshape', now: at });
  expect(noticeStaleThreads('home', at.getTime() + THREAD_STALE_MS - 1)).toEqual([]);
  const [notice] = noticeStaleThreads('home', at.getTime() + THREAD_STALE_MS);
  expect(notice).toMatchObject({ kind: 'thread-stale', refId: item.id, grounds: 'home', stateHash: at.toISOString(), text: 'Outreach reshape · quiet 24.0h' });
  expect(noticeStaleThreads('home', at.getTime() + 2 * THREAD_STALE_MS)).toEqual([]);
  const saidAt = new Date(at.getTime() + 2 * THREAD_STALE_MS + 1000);
  sayThread(item.id, { text: 'I will revisit the approach', now: saidAt });
  expect(noticeStaleThreads('home', saidAt.getTime() + THREAD_STALE_MS - 1)).toEqual([]);
  expect(noticeStaleThreads('home', saidAt.getTime() + THREAD_STALE_MS)).toHaveLength(1);
  const personAt = new Date(saidAt.getTime() + 2 * THREAD_STALE_MS);
  postThread(item.id, { text: 'One more question', via: 'chat', now: personAt });
  expect(noticeStaleThreads('home', personAt.getTime() + THREAD_STALE_MS)).toHaveLength(1);
  expect(listNotices().filter((notice) => notice.kind === 'thread-stale')).toHaveLength(3);
});

it.each(['dispatch', 'failed dispatch', 'card', 'PR', 'closed PR', 'todo'])('keeps a thread quiet while its linked %s is unfinished', (kind) => {
  const item = startHelmThread({ grounds: 'home', title: 'Outreach', now: at });
  if (kind.includes('dispatch')) {
    enqueue({ id: 'work', repo: 'web', brief: 'Outreach reshape' }); claimNext('work');
    if (kind === 'failed dispatch') appendStatus('work', 'work', 'failed', 'Did not land');
    noteThread(item.id, { link: 'dispatched:work' }, at);
  } else if (kind === 'card') askDecision({ title: 'Keep outreach?', thread: item.id, askedBy: 'helm', maxBytes: 100, now: at });
  else if (kind.includes('PR')) {
    const ref = parsePrRef('o/r#3114')!;
    upsertPr(prEvidence(ref, { title: 'Outreach', state: kind === 'closed PR' ? 'CLOSED' : 'OPEN', isDraft: false, headRefOid: 'abc' } as GhPrView, at.toISOString()));
    noteThread(item.id, { link: `pr:${ref.url}` }, at);
  } else addTodo('fleet', 'Check outreach', at.getTime(), { thread: item.id });
  expect(noticeStaleThreads('home', at.getTime() + 2 * THREAD_STALE_MS)).toEqual([]);
});

it('becomes eligible when linked work finishes without a new round', () => {
  const item = startHelmThread({ grounds: 'home', title: 'Outreach', now: at });
  const todo = addTodo('fleet', 'Check outreach', at.getTime(), { thread: item.id });
  const now = at.getTime() + 2 * THREAD_STALE_MS;
  expect(noticeStaleThreads('home', now)).toEqual([]);
  closeTodo('fleet', todo.id, 'done', now);
  expect(noticeStaleThreads('home', now)).toHaveLength(1);
});

it('counts a card answer as person activity', () => {
  const item = startHelmThread({ grounds: 'home', title: 'Outreach', now: at });
  const card = askDecision({ title: 'Keep outreach?', thread: item.id, askedBy: 'helm', maxBytes: 100, now: at }).meta;
  const answeredAt = new Date(at.getTime() + 2 * THREAD_STALE_MS);
  answerDecision({ key: card.key, text: 'Yes', by: 'glass', maxBytes: 100, now: answeredAt });
  expect(threadQuietSince(readThread(item.id)!)).toBe(answeredAt.toISOString());
  expect(noticeStaleThreads('home', answeredAt.getTime() + THREAD_STALE_MS - 1)).toEqual([]);
  expect(noticeStaleThreads('home', answeredAt.getTime() + THREAD_STALE_MS)).toHaveLength(1);
});

it('scopes scans and skips resolved and tracking threads', () => {
  const other = startHelmThread({ grounds: 'other', title: 'Other', now: at });
  const resolved = startHelmThread({ grounds: 'home', title: 'Resolved', now: at });
  resolveThread(resolved.id, 'answered', 'Done', at);
  const tracking = startHelmThread({ grounds: 'home', title: 'Tracking', now: at });
  addTodo('fleet', 'Check', at.getTime(), { thread: tracking.id });
  resolveThread(tracking.id, 'answered', 'Will check', at);
  expect(noticeStaleThreads('home', at.getTime() + 2 * THREAD_STALE_MS)).toEqual([]);
  expect(noticeStaleThreads('other', at.getTime() + 2 * THREAD_STALE_MS)).toMatchObject([{ refId: other.id }]);
});

it.each(['message', 'resolution', 'work'])('discards a pending stale notice after a new %s', (change) => {
  const item = startHelmThread({ grounds: 'home', title: 'Outreach', now: at });
  const now = at.getTime() + 2 * THREAD_STALE_MS;
  vi.setSystemTime(now);
  const [notice] = noticeStaleThreads('home');
  expect(staleThreadNoticeStands(notice!)).toBe(true);
  if (change === 'message') sayThread(item.id, { text: 'The plan changed' });
  else if (change === 'resolution') resolveThread(item.id, 'answered', 'Settled');
  else addTodo('fleet', 'Follow up', now, { thread: item.id });
  expect(staleThreadNoticeStands(notice!)).toBe(false);
  expect(unseenNotices(false).filter((notice) => notice.kind === 'thread-stale')).toEqual([]);
});

it('keeps an undelivered stale notice actionable across a helm sign-on', () => {
  const item = startHelmThread({ grounds: 'home', title: 'Outreach', now: at });
  vi.setSystemTime(at.getTime() + 2 * THREAD_STALE_MS);
  const [notice] = noticeStaleThreads('home');
  vi.setSystemTime(Date.now() + 1000);
  takeHelm({ sessionId: 'new-helm', grounds: { name: 'home', repos: [] }, ttlMs: 60_000 });
  expect(noticeWakes(helmOf('new-helm'))?.(notice!)).toBe(true);
  expect(notice!.refId).toBe(item.id);
});

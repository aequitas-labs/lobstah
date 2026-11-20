import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { answerDecision, askDecision } from '../src/decisions.js';
import { prEvidence, parsePrRef, type GhPrView } from '../src/pr.js';
import { upsertPr } from '../src/prs.js';
import { enqueue, claimNext } from '../src/queue.js';
import { ensureLayout } from '../src/paths.js';
import { appendStatus } from '../src/status.js';
import { addTodo, closeTodo } from '../src/todos.js';
import { noteThread, postThread, readThread, reopenThread, resolveThread, sayThread, startThread, threadSummaries, threadView, trackThreads, triageThread } from '../src/threads.js';
import { threadTrackedItems } from '../src/thread-tracking.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const at = new Date('2026-11-19T10:00:00Z');
const later = (minutes: number) => new Date(at.getTime() + minutes * 60_000);
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-tracking-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});
const thread = () => {
  const item = startThread({ grounds: 'home', text: 'Fix the flaky deck test', now: at });
  triageThread(item.id, 'thread', at);
  return item.id;
};
const dispatch = (id: string) => {
  enqueue({ id, repo: 'r', brief: 'Fix the flaky deck test\n\nMore detail' });
  claimNext('work');
  return id;
};
const pr = (number: number, state: string) => {
  const ref = parsePrRef(`o/r#${number}`)!;
  upsertPr(prEvidence(ref, { isDraft: false, headRefOid: 'abc', state, title: 'Deflake the deck test' } as GhPrView, new Date().toISOString()));
  return `https://github.com/o/r/pull/${number}`;
};
const systemLines = (id: string) => readThread(id)!.rounds.flatMap((round) => round.entries.flatMap((entry) => ('event' in entry && entry.event === 'tracked' ? [entry.text] : [])));

describe('tracking threads', () => {
  it('resolves outright when nothing it links to is unfinished', () => {
    const id = thread();
    expect(resolveThread(id, 'answered', 'Answered in chat', later(1)).state).toBe('resolved');
  });

  it('tracks a dispatched outcome until the dispatch is done, then resolves with one system line', () => {
    const id = thread();
    dispatch('d1');
    const resolved = resolveThread(id, 'dispatched:d1', 'Dispatched the fix', later(1));
    expect(resolved.state).toBe('tracking');
    expect(threadView(resolved).tracked).toMatchObject([{ kind: 'dispatch', ref: 'd1', title: 'Fix the flaky deck test', state: 'open', status: 'queued', href: '#dispatch/d1' }]);
    expect(threadSummaries('home')).toMatchObject([{ id, state: 'tracking', waitingForHelm: false }]);
    appendStatus('d1', 'work', 'working', 'on it');
    expect(trackThreads('home', later(2).getTime())).toEqual([]);
    expect(readThread(id)?.state).toBe('tracking');
    appendStatus('d1', 'work', 'done', 'PR up');
    const [closed] = trackThreads('home', later(3).getTime());
    expect(closed).toMatchObject({ id, state: 'resolved', outcome: { kind: 'dispatched' } });
    expect(systemLines(id)).toEqual(['Dispatch Fix the flaky deck test finished']);
    expect(trackThreads('home', later(4).getTime())).toEqual([]);
  });

  it('returns to the person, unread, when a linked dispatch stalls', () => {
    const id = thread();
    dispatch('d2');
    noteThread(id, { link: 'dispatched:work:d2', text: 'Dispatched' }, later(1));
    const shown = resolveThread(id, 'answered', 'Handed off', later(2));
    expect(shown.state).toBe('tracking');
    // Resolving into tracking is quiet: nothing for the person to read yet.
    expect(threadSummaries('home', later(2).getTime())[0]).toMatchObject({ state: 'tracking', unreadResponse: false });
    appendStatus('d2', 'work', 'blocked', 'needs a token');
    const [back] = trackThreads('home', later(3).getTime());
    expect(back).toMatchObject({ state: 'open', responseText: 'Dispatch Fix the flaky deck test is blocked' });
    expect(back!.responseSeq).toBe((shown.responseSeq ?? 0) + 1);
    expect(threadSummaries('home')[0]).toMatchObject({ state: 'open', unreadResponse: true });
  });

  it('tracks cards and PRs: a merged PR and an answered card finish it, a PR closed unmerged stalls it', () => {
    const id = thread();
    const { meta } = askDecision({ title: 'Ship the fix?', thread: id, options: ['Yes'], askedBy: 'helm', maxBytes: 100 });
    const url = pr(7, 'OPEN');
    noteThread(id, { link: `pr:${url}`, text: 'The fix' }, later(1));
    expect(resolveThread(id, 'answered', 'Waiting on review', later(2)).state).toBe('tracking');
    expect(threadView(readThread(id)!).tracked).toMatchObject([
      { kind: 'card', title: 'Ship the fix?', state: 'open', status: 'waiting for you' },
      { kind: 'pr', ref: 'pr:o/r#7', title: 'Deflake the deck test', state: 'open', status: 'open', href: url },
    ]);
    answerDecision({ key: meta.key, option: 'Yes', by: 'glass', maxBytes: 100 });
    expect(trackThreads('home', later(3).getTime())).toEqual([]);
    pr(7, 'MERGED');
    expect(trackThreads('home', later(4).getTime())[0]).toMatchObject({ state: 'resolved' });
    expect(systemLines(id)).toEqual(['All linked work finished']);

    const other = thread();
    noteThread(other, { link: `pr:${pr(8, 'OPEN')}` }, later(5));
    resolveThread(other, 'answered', 'Waiting on review', later(6));
    pr(8, 'CLOSED');
    expect(trackThreads('home', later(7).getTime())[0]).toMatchObject({ id: other, state: 'open', responseText: 'PR Deflake the deck test is closed without merging' });
  });

  it('tracks todos tied to the thread: closing them finishes it, a stale one hands it back', () => {
    const id = thread();
    const todo = addTodo('fleet', 'Check the deck test tomorrow', at.getTime(), { thread: id });
    expect(resolveThread(id, 'answered', 'Will check', later(1)).state).toBe('tracking');
    expect(threadTrackedItems(readThread(id)!, { now: later(2).getTime() })).toMatchObject([{ kind: 'todo', ref: String(todo.id), state: 'open' }]);
    closeTodo('fleet', todo.id, 'done', later(3).getTime());
    expect(trackThreads('home', later(4).getTime())[0]).toMatchObject({ state: 'resolved' });

    const stale = thread();
    addTodo('fleet', 'Follow up with design', at.getTime(), { thread: stale });
    resolveThread(stale, 'answered', 'Will follow up', later(1));
    const fourDays = at.getTime() + 4 * 86400_000;
    expect(trackThreads('home', fourDays)[0]).toMatchObject({ id: stale, state: 'open', responseText: 'Todo Follow up with design is stale' });
  });

  it('lets the helm keep talking while tracking, and the person bring it back by writing', () => {
    const id = thread();
    dispatch('d3');
    resolveThread(id, 'dispatched:d3', 'Dispatched', later(1));
    expect(sayThread(id, { text: 'The trap picked it up', now: later(2) }).state).toBe('tracking');
    expect(postThread(id, { text: 'Can you also check the phone?', now: later(3) }).state).toBe('open');
    expect(reopenThread(id, later(4)).state).toBe('open');
  });
});

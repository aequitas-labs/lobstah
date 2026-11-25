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
import { archiveRecords } from '../src/record-archive.js';
import { laneDirs } from '../src/paths.js';
import { threadTrackedItems } from '../src/thread-tracking.js';
import { removeTempDir } from '../../../test/temp-dir.js';
import { readStatusLog } from '../src/status.js';

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
  it.each(['dispatch', 'PR', 'card'])('supersedes failed work and tracks its replacement %s until it finishes', (kind) => {
    const id = thread();
    dispatch('old');
    resolveThread(id, 'dispatched:old', 'Dispatched the reshape', later(1));
    appendStatus('old', 'work', 'failed', 'Outreach reshape did not land');
    let replacement: string;
    let finish: () => void;
    if (kind === 'dispatch') {
      dispatch('new');
      replacement = 'dispatched:work:new';
      finish = () => { appendStatus('new', 'work', 'done', 'Replacement landed'); };
    } else if (kind === 'PR') {
      replacement = `pr:${pr(3114, 'OPEN')}`;
      finish = () => { pr(3114, 'MERGED'); };
    } else {
      const card = askDecision({ title: 'Review the replacement?', askedBy: 'helm', maxBytes: 100 }).meta;
      replacement = card.key;
      finish = () => { answerDecision({ key: card.key, text: 'Approved', by: 'glass', maxBytes: 100 }); };
    }
    const resolved = resolveThread(id, 'answered', 'Replaced the failed reshape', later(2), replacement);
    expect(resolved.state).toBe('tracking');
    expect(resolved.supersessions).toMatchObject([{ dispatch: 'old', replacement }]);
    expect(threadTrackedItems(resolved)).toMatchObject([
      { kind: 'dispatch', ref: 'old', state: 'done', status: 'superseded' },
      { kind: kind === 'PR' ? 'pr' : kind, state: 'open' },
    ]);
    expect(readStatusLog('old', 'work').at(-1)?.verb).toBe('failed');
    expect(trackThreads('home', later(3).getTime())).toEqual([]);
    finish();
    expect(trackThreads('home', later(4).getTime())).toMatchObject([{ id, state: 'resolved' }]);
    expect(trackThreads('home', later(5).getTime())).toEqual([]);
  });

  it('can resolve immediately against a merged replacement and retains other unfinished work', () => {
    const id = thread();
    dispatch('old'); appendStatus('old', 'work', 'failed', 'Did not land');
    noteThread(id, { link: 'dispatched:old' }, later(1));
    const replacement = `pr:${pr(3114, 'MERGED')}`;
    expect(resolveThread(id, 'answered', 'PR replaced the reshape', later(2), replacement).state).toBe('resolved');
    expect(trackThreads('home', later(3).getTime())).toEqual([]);

    const other = thread();
    dispatch('another-old'); appendStatus('another-old', 'work', 'failed', 'Did not land');
    noteThread(other, { link: 'dispatched:another-old' }, later(1));
    const todo = addTodo('fleet', 'Check the rollout', later(1).getTime(), { thread: other });
    expect(resolveThread(other, 'answered', 'Replaced; rollout still pending', later(2), replacement).state).toBe('tracking');
    closeTodo('fleet', todo.id, 'done');
    expect(trackThreads('home', later(3).getTime())).toMatchObject([{ id: other, state: 'resolved' }]);
  });

  it('hands the thread back if the replacement itself stalls', () => {
    const id = thread();
    dispatch('old'); appendStatus('old', 'work', 'failed', 'Failed');
    noteThread(id, { link: 'dispatched:old' }, later(1));
    resolveThread(id, 'answered', 'Replacement PR', later(2), `pr:${pr(3114, 'OPEN')}`);
    pr(3114, 'CLOSED');
    expect(trackThreads('home', later(3).getTime())).toMatchObject([{ id, state: 'open', responseText: 'PR Deflake the deck test is closed without merging' }]);
  });

  it.each(['dispatched:old', 'dispatched:missing', 'report:some-report', 'planned:https://example.com/plan', 'decision:missing'])('refuses replacement %s without changing the thread', (replacement) => {
    const id = thread();
    dispatch('old'); appendStatus('old', 'work', 'failed', 'Failed');
    noteThread(id, { link: 'dispatched:old' }, later(1));
    const before = readThread(id);
    expect(() => resolveThread(id, 'answered', 'Replacement', later(2), replacement)).toThrow();
    expect(readThread(id)).toEqual(before);
  });

  it('replaces only failed dispatches and requires a failure to replace', () => {
    const id = thread();
    dispatch('blocked'); appendStatus('blocked', 'work', 'blocked', 'Needs a token');
    noteThread(id, { link: 'dispatched:blocked' }, later(1));
    expect(() => resolveThread(id, 'answered', 'Replacement', later(2), `pr:${pr(3114, 'MERGED')}`)).toThrow('no failed dispatch');
    dispatch('failed'); appendStatus('failed', 'work', 'failed', 'Failed');
    noteThread(id, { link: 'dispatched:failed' }, later(1));
    const resolved = resolveThread(id, 'answered', 'Replaced failed work only', later(2), `pr:${pr(3114, 'MERGED')}`);
    expect(resolved.supersessions).toMatchObject([{ dispatch: 'failed' }]);
    expect(trackThreads('home', later(3).getTime())).toMatchObject([{ id, state: 'open', responseText: 'Dispatch Fix the flaky deck test is blocked' }]);
  });

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

it('names removed and archived dispatches and cards without bare ids or dead dispatch links', () => {
  const id = thread();
  noteThread(id, { link: 'dispatched:gone', text: 'gone' });
  const { meta } = askDecision({ title: 'Review this', thread: id, options: ['Yes'], askedBy: 'helm', maxBytes: 100 });
  const dir = path.join(home, 'decisions', meta.key.slice('decision:'.length));
  archiveRecords([meta.key], [dir]);
  fs.rmSync(dir, { recursive: true });
  const tracked = threadTrackedItems(readThread(id)!);
  expect(tracked).toMatchObject([
    { kind: 'dispatch', title: 'Dispatch', status: 'removed', state: 'done' },
    { kind: 'card', title: 'Card', status: 'archived', state: 'done' },
  ]);
  expect(tracked[0]!.href).toBeUndefined();
  const record = path.join(laneDirs('work').done, 'gone');
  fs.mkdirSync(record);
  fs.writeFileSync(path.join(record, 'descriptor.json'), '{}');
  archiveRecords(['work:gone'], [record]);
  fs.rmSync(record, { recursive: true });
  expect(threadTrackedItems(readThread(id)!)[0]).toMatchObject({ title: 'Dispatch', status: 'archived' });
});

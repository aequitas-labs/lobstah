import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureLayout, startThread, postThread, sayThread, markThreadResponsesSeen, threadSubscriberNotices, readThread, listThreads, triageThread, noteThread, resolveThread, reopenThread, threadView, threadSummaries, remindThreads, expireIdleThreads, resolveThreadFile, askDecision, answerDecision, readDecisionAnswer, listRequests, listNotices, THREAD_IDLE_MS } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';
let home: string;
const at = new Date('2026-11-19T10:00:00Z');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-threads-')); process.env.LOBSTAH_HOME = home; ensureLayout(); });
afterEach(() => { removeTempDir(home); delete process.env.LOBSTAH_HOME; });
const start = () => startThread({ grounds: 'home', text: 'Can we rethink the deck?', now: at });
describe('helm conversations', () => {
  it('starts untriaged, wakes once with the message, and retains identity through triage and notes', () => {
    const item = start();
    expect(item.kind).toBe('untriaged');
    expect(listNotices()).toMatchObject([{ kind: 'thread', refId: item.id, grounds: 'home', text: expect.stringContaining(item.text) }]);
    expect(triageThread(item.id, 'thread', at).id).toBe(item.id);
    noteThread(item.id, { decided: ['Keep reviews'], open: ['Where does Helm go?'] }, at);
    expect(threadSummaries('home')[0]).toMatchObject({ kind: 'thread', openLine: 'Where does Helm go?', waitingForHelm: false });
    postThread(item.id, { text: 'Use the middle tab', now: at });
    expect(threadSummaries('home')[0]?.waitingForHelm).toBe(true);
    noteThread(item.id, { decided: ['Keep reviews', 'Helm in the middle'], open: [] }, at);
    expect(readThread(item.id)?.notes).toEqual({ decided: ['Keep reviews', 'Helm in the middle'], open: [] });
    expect(listThreads('other')).toEqual([]);
    expect(readThread(item.id, 'other')).toBeUndefined();
  });
  it('joins cards and answers by reference without copying answers into rounds', () => {
    const item = start();
    const { meta } = askDecision({ title: 'Which tab?', thread: item.id, options: ['Helm'], askedBy: 'helm', maxBytes: 100 });
    expect(meta.grounds).toBe('home');
    expect(threadView(readThread(item.id)!).cards).toMatchObject([{ key: meta.key, standing: true }]);
    answerDecision({ key: meta.key, option: 'Helm', text: 'Middle tab', by: 'glass', maxBytes: 100 });
    expect(threadView(readThread(item.id)!).cards).toMatchObject([{ standing: false, answer: { option: 'Helm', text: 'Middle tab' } }]);
    expect(listRequests()).toMatchObject([{ payload: { thread: item.id, key: meta.key } }]);
    expect(readThread(item.id)?.rounds.at(-1)?.entries.at(-1)).toEqual({ card: meta.key });
    expect(() => askDecision({ title: 'Wrong grounds', thread: item.id, grounds: 'other', askedBy: 'helm', maxBytes: 100 })).toThrow('open conversation');
  });
  it('requires a linked outcome and note, closes, reopens, and retains chat rounds as chat', () => {
    const item = startThread({ grounds: 'home', title: 'Navigation', text: 'Chris and helm discussed the deck', via: 'chat', now: at });
    expect(listNotices()).toEqual([]);
    expect(item.kind).toBe('thread');
    expect(() => resolveThread(item.id, 'planned:http://example.test', 'Plan')).toThrow('HTTPS');
    expect(() => resolveThread(item.id, 'dispatched', 'Work')).toThrow('dispatch id');
    expect(() => resolveThread(item.id, 'answered', '')).toThrow('outcome note');
    noteThread(item.id, { link: 'planned:https://app.ume.so/a/test', text: 'Review the plan' }, at);
    resolveThread(item.id, 'planned:https://app.ume.so/a/test', 'Navigation plan ready', at);
    expect(() => postThread(item.id, { text: 'One more' })).toThrow('Reopen');
    expect(reopenThread(item.id, at)).toMatchObject({ state: 'open', outcome: undefined });
    expect(postThread(item.id, { text: 'Another exchange', via: 'chat', now: at }).rounds.at(-1)?.entries[0]).toMatchObject({ via: 'chat' });
  });
  it('validates attachments before writing and serves only listed basenames', () => {
    expect(() => startThread({ grounds: '../outside', text: 'No' })).toThrow('grounds');
    expect(() => startThread({ grounds: 'home', text: 'No', uploads: [{ name: '../shot.png', data: png }] })).toThrow('valid name');
    expect(() => startThread({ grounds: 'home', text: 'No', uploads: [{ name: 'shot.png', data: png }], maxBytes: 1 })).toThrow('too large');
    expect(() => startThread({ grounds: 'home', text: 'No', uploads: [{ name: 'shot.png', data: Buffer.from('bad') }] })).toThrow();
    expect(listThreads()).toEqual([]);
    const item = startThread({ grounds: 'home', text: 'Look at this', uploads: [{ name: 'shot.png', data: png }] });
    postThread(item.id, { text: 'Again', uploads: [{ name: 'shot.png', data: png }] });
    expect(fs.readFileSync(resolveThreadFile(item.id, 'shot-2.png')!)).toEqual(png);
    expect(resolveThreadFile(item.id, '../shot.png')).toBeUndefined();
    expect(resolveThreadFile(item.id, 'missing.png')).toBeUndefined();
    const summary = threadSummaries()[0]!;
    expect(summary).not.toHaveProperty('rounds'); expect(summary).not.toHaveProperty('attachments'); expect(summary).not.toHaveProperty('text');
    const file = path.join(home, 'threads', 'home', item.id + '.json');
    const before = fs.statSync(file).mtimeMs;
    threadSummaries(); threadView(readThread(item.id)!);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });
  it('repeats unanswered reminders on cadence and stops after a helm response', () => {
    const item = start();
    remindThreads('home', 1000, at.getTime() + 999);
    expect(listNotices()).toHaveLength(1);
    remindThreads('home', 1000, at.getTime() + 1000);
    expect(listNotices()).toHaveLength(2);
    triageThread(item.id, 'bait', new Date(at.getTime() + 1001));
    remindThreads('home', 1000, at.getTime() + 5000);
    expect(listNotices()).toHaveLength(2);
  });
  it('expires idle discussions with no standing card, keeps bait and questions, and allows reopening', () => {
    const idle = start(); triageThread(idle.id, 'thread', at);
    const question = start(); triageThread(question.id, 'thread', at);
    askDecision({ title: 'Still needed?', thread: question.id, askedBy: 'helm', maxBytes: 100 });
    const bait = start(); triageThread(bait.id, 'bait', at);
    expireIdleThreads('home', at.getTime() + THREAD_IDLE_MS);
    expect(readThread(idle.id)?.outcome?.kind).toBe('dropped');
    expect(readThread(question.id)?.state).toBe('open'); expect(readThread(bait.id)?.state).toBe('open');
    expect(reopenThread(idle.id).state).toBe('open');
  });
  it('bounds each message and stops extending a conversation at 100 rounds', () => {
    expect(() => startThread({ grounds: 'home', text: 'x'.repeat(20001) })).toThrow('20000');
    const item = startThread({ grounds: 'home', text: 'One', via: 'chat' });
    for (let n = 1; n < 100; n++) postThread(item.id, { text: 'Round ' + n, via: 'chat' });
    expect(() => postThread(item.id, { text: 'Too many', via: 'chat' })).toThrow('report or plan');
    expect(readThread(item.id)?.rounds).toHaveLength(100);
  });
});

describe('unread helm responses', () => {
  it('coalesces durable notices and preserves responses newer than the seen cursor', async () => {
    const { markThreadResponsesSeen, dismissThreadNotice, threadSubscriberNotices } = await import('../src/threads.js');
    const item = start();
    triageThread(item.id, 'thread', at);
    noteThread(item.id, {decided:['Keep Reviews']}, at);
    const {meta} = askDecision({title:'Use Helm?',thread:item.id,askedBy:'helm',maxBytes:100});
    const seq = readThread(item.id)!.responseSeq!;
    expect(threadSubscriberNotices()).toMatchObject([{thread:item.id,person:'owner',seq,href:`#thread/${item.id}`}]);
    expect(threadSubscriberNotices()).toHaveLength(1);
    markThreadResponsesSeen(item.id, seq - 1);
    expect(threadSummaries()[0]).toMatchObject({responseSeq:seq,seenThrough:seq-1,unreadResponse:true});
    expect(threadSubscriberNotices()[0]?.seq).toBe(seq);
    dismissThreadNotice(item.id, seq);
    expect(threadSubscriberNotices()).toEqual([]);
    expect(threadSummaries()[0]?.unreadResponse).toBe(true);
    expect(readDecisionAnswer(meta.key)).toBeUndefined();
    noteThread(item.id,{open:['One more choice']},at);
    expect(threadSubscriberNotices()[0]?.seq).toBe(seq+1);
    markThreadResponsesSeen(item.id, seq);
    expect(threadSummaries()[0]?.unreadResponse).toBe(true);
    markThreadResponsesSeen(item.id, seq+1);
    expect(threadSubscriberNotices()).toEqual([]);
    expect(threadSummaries()[0]?.unreadResponse).toBe(false);
    expect(threadView(readThread(item.id)!).cards[0]?.standing).toBe(true);
    expect(threadSubscriberNotices('another-person')).toHaveLength(1);
    expect(() => markThreadResponsesSeen(item.id, seq+2)).toThrow('shown');
  });
  it('keeps a resolved conversation beyond a day until its response is read', async () => {
    const {markThreadResponsesSeen, threadSubscriberNotices} = await import('../src/threads.js');
    const old = new Date(Date.now()-3*86400_000);
    const item = startThread({grounds:'home',text:'An old exchange',via:'chat',now:old});
    resolveThread(item.id,'answered','The notes have the answer',old);
    expect(threadSummaries()).toHaveLength(1);
    expect(threadSubscriberNotices()).toHaveLength(1);
    markThreadResponsesSeen(item.id,1);
    expect(threadSummaries()).toEqual([]);
    expect(readThread(item.id)?.outcome?.note).toBe('The notes have the answer');
  });
});

describe('chat with the helm', () => {
  const later = (minutes: number) => new Date(at.getTime() + minutes * 60_000);
  it('keeps the person and the helm in one timeline, in order, each with its time', () => {
    const item = start();
    triageThread(item.id, 'thread', later(1));
    sayThread(item.id, { text: 'Which part of the deck?', now: later(2) });
    noteThread(item.id, { decided: ['Rethink the deck'], open: ['Which part'] }, later(3));
    postThread(item.id, { text: 'The decisions row', now: later(4) });
    sayThread(item.id, { text: 'I will sketch two options', uploads: [{ name: 'sketch.png', data: png }], now: later(5) });
    const thread = readThread(item.id)!;
    expect(thread.rounds.map((round) => round.entries.map((entry) => 'by' in entry ? `${entry.by}:${entry.text}` : 'event' in entry ? `event:${entry.kind}` : 'other'))).toEqual([
      ['person:Can we rethink the deck?', 'event:thread', 'helm:Which part of the deck?'],
      ['person:The decisions row', 'helm:I will sketch two options'],
    ]);
    const times = thread.rounds.flatMap((round) => round.entries.map((entry) => ('at' in entry ? entry.at : undefined)));
    expect(times).toEqual([at, later(1), later(2), later(4), later(5)].map((d) => d.toISOString()));
    expect(thread.notesAt).toBe(later(3).toISOString());
    const said = thread.rounds[1]!.entries[1]!;
    expect(said).toMatchObject({ by: 'helm', attachments: [{ name: 'sketch.png' }], seq: thread.responseSeq });
    expect(fs.readFileSync(resolveThreadFile(item.id, 'sketch.png')!)).toEqual(png);
  });
  it('marks the conversation unread for the person and stops waiting for the helm', () => {
    const item = start();
    expect(threadSummaries('home')[0]).toMatchObject({ waitingForHelm: true, unreadResponse: false });
    const said = sayThread(item.id, { text: 'On it', now: later(1) });
    expect(threadSummaries('home')[0]).toMatchObject({ waitingForHelm: false, unreadResponse: true, responseText: 'On it', responseSeq: said.responseSeq });
    expect(threadSubscriberNotices()).toMatchObject([{ thread: item.id, seq: said.responseSeq, text: 'On it' }]);
    markThreadResponsesSeen(item.id, said.responseSeq);
    expect(threadSummaries('home')[0]?.unreadResponse).toBe(false);
  });
  it("wakes the helm with the person's next message, not with its own words", () => {
    const item = start();
    sayThread(item.id, { text: 'Helm words', now: later(1) });
    const before = listNotices().length;
    remindThreads('home', 900_000, later(2).getTime());
    expect(listNotices()).toHaveLength(before);
    postThread(item.id, { text: 'Person reply', now: later(3) });
    const wake = listNotices().filter((notice) => notice.kind === 'thread').at(-1)!;
    expect(wake.text).toContain('Person reply');
    expect(wake.text).not.toContain('Helm words');
  });
  it('refuses empty or closed messages', () => {
    const item = start();
    expect(() => sayThread(item.id, { text: '  ' })).toThrow('Enter message');
    resolveThread(item.id, 'answered', 'Done', later(1));
    expect(() => sayThread(item.id, { text: 'Late' })).toThrow('Reopen');
  });
});

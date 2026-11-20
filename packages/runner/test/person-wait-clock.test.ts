import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { answerDecision, askDecision, appendStatus, claimNext, enqueue, ensureLayout, parsePrRef, routePrQuestionReply, sendMessage, standingDecisions, syncDispatchPrQuestions, unhandled, workClockWaiting } from '@lobstah/core';
import type { PrQuestionTransport } from '@lobstah/core';
import { attentionNow, captureWaitBaseline, freshWakeEvents } from '../../supervisor/src/notify.js';
import { startWallClock } from '../src/wallclock.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-person-clock-'));
  process.env.LOBSTAH_HOME = home; ensureLayout();
  vi.useFakeTimers({ now: Date.parse('2026-11-19T12:00:00Z') });
  enqueue({ id: 'clock', repo: 'r', brief: 'Work' }); claimNext('work');
  appendStatus('clock', 'work', 'working');
});
afterEach(() => { vi.useRealTimers(); delete process.env.LOBSTAH_HOME; removeTempDir(home); });

it.each(['needs-decision', 'blocked'] as const)('stops both budget windows during %s and resumes immediately on an answer', (verb) => {
  let expired = 0;
  const clock = startWallClock({ limitMs: 10_000, maxMs: 20_000, tickMs: 1000, paused: () => workClockWaiting('clock', 'work'), onExpire: () => { expired++; } });
  vi.advanceTimersByTime(5000);
  appendStatus('clock', 'work', verb, 'Which option?');
  vi.advanceTimersByTime(60_000);
  expect(clock.elapsed()).toBe(5000);
  expect(clock.window()).toBe(10_000);
  expect(expired).toBe(0);
  sendMessage('clock', 'work', 'Use A', 'terminal');
  vi.advanceTimersByTime(5000);
  expect(clock.elapsed()).toBe(10_000);
  expect(expired).toBe(1);
  clock.stop();
});

it.each(['pr', 'send', 'glass'] as const)('a carded headless question pauses its clock, posts once, wakes once and resumes on %s', async (surface) => {
  const pr = parsePrRef('https://github.com/o/r/pull/42')!;
  fs.writeFileSync(path.join(home, 'active', 'clock', 'runner.json'), JSON.stringify({ pid: 999001, startedAt: new Date().toISOString() }));
  let expired = 0;
  const clock = startWallClock({ limitMs: 10_000, maxMs: 20_000, tickMs: 1000, paused: () => workClockWaiting('clock', 'work'), onExpire: () => { expired++; } });
  vi.advanceTimersByTime(5000);
  const baseline = captureWaitBaseline();
  appendStatus('clock', 'work', 'needs-decision', 'Which option?');
  const card = askDecision({ dispatch: 'clock', title: 'Choose an option', askedBy: 'helm', maxBytes: 1000 }).meta;
  const posted = { id: 100, body: '', user: { login: 'lobstah-owner' }, created_at: new Date().toISOString(), html_url: `${pr.url}#issuecomment-100` };
  const transport: PrQuestionTransport = {
    identity: 'lobstah-owner', comments: vi.fn(async () => [posted]), reviewComments: vi.fn(async () => []),
    post: vi.fn(async (_ref, body) => { posted.body = body; return posted; }), edit: vi.fn(async () => {}),
  };
  await syncDispatchPrQuestions('clock', 'work', transport, pr);
  await syncDispatchPrQuestions('clock', 'work', transport, pr);
  expect(transport.post).toHaveBeenCalledTimes(1);
  expect(posted.body).toContain('Which option?');
  expect(posted.body).toContain('<!-- lobstah:question clock 1 -->');
  expect(freshWakeEvents(baseline)).toHaveLength(1);
  vi.advanceTimersByTime(60_000);
  expect(attentionNow(true, 1000)).toEqual([]);
  expect(standingDecisions().map(item => item.key)).toContain(card.key);
  expect(clock.elapsed()).toBe(5000);
  expect(clock.window()).toBe(10_000);
  expect(expired).toBe(0);
  if (surface === 'send') sendMessage('clock', 'work', 'Use A', 'terminal');
  else if (surface === 'glass') answerDecision({ key: card.key, text: 'Use A', by: 'glass', maxBytes: 1000 });
  else expect(routePrQuestionReply(pr, { ...posted, id: 200, body: '> Which option?\n\nUse A', user: { login: 'reviewer', type: 'User' } }, transport.identity)).toBe(true);
  expect(unhandled('clock', 'work')).toHaveLength(1);
  expect(workClockWaiting('clock', 'work')).toBe(false);
  expect(standingDecisions().map(item => item.key)).not.toContain(card.key);
  vi.advanceTimersByTime(5000);
  expect(clock.elapsed()).toBe(10_000);
  expect(expired).toBe(1);
  clock.stop();
});

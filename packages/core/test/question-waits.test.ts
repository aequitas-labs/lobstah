import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, claimNext, enqueue, ensureLayout, isParked, loadConfig, parkQuestion, parkedDispatches, personWaiting, questionPark, readStatusLog, readTrap, reconcileTrapQuestions, sendMessage, slotUsage, workClockWaiting } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const now = Date.parse('2026-11-19T12:00:00Z');
const id = 'person-wait';
const askedAt = new Date(now - 86_400_000).toISOString();
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-question-wait-'));
  process.env.LOBSTAH_HOME = home; ensureLayout();
  enqueue({ id, repo: 'r', brief: 'Do the work' }); claimNext('work');
});
afterEach(() => { vi.useRealTimers(); delete process.env.LOBSTAH_HOME; removeTempDir(home); });

for (const verb of ['needs-decision', 'blocked'] as const) {
  it(`${verb} stops the work clock until an answer arrives`, () => {
    appendStatus(id, 'work', verb, 'Which option?', askedAt);
    expect(personWaiting(id, 'work')).toBe(true);
    expect(workClockWaiting(id, 'work')).toBe(true);
    sendMessage(id, 'work', 'Use option A', 'terminal');
    expect(workClockWaiting(id, 'work')).toBe(false);
  });
}

it('preserves external pause semantics', () => {
  appendStatus(id, 'work', 'paused', 'Deployment', undefined, { waitingOn: 'deploy' });
  sendMessage(id, 'work', 'A note', 'terminal');
  expect(workClockWaiting(id, 'work')).toBe(true);
});

it('keeps separate answer receipts for two questions reported in one millisecond', () => {
  vi.useFakeTimers({ now });
  const first = appendStatus(id, 'work', 'needs-decision', 'First question');
  sendMessage(id, 'work', 'First answer', 'terminal');
  appendStatus(id, 'work', 'working', 'Continuing');
  const second = appendStatus(id, 'work', 'needs-decision', 'Second question');
  expect(Date.parse(second.at)).toBeGreaterThan(Date.parse(first.at));
  expect(workClockWaiting(id, 'work')).toBe(true);
});

it('defaults the question window to 24h and rejects invalid limits', () => {
  expect(loadConfig().limits.questionWaitSecs).toBe(86400);
  for (const value of ['-1', '"a day"', 'true']) {
    fs.writeFileSync(path.join(home, 'config.toml'), `[limits]\nquestionWaitSecs = ${value}\n`);
    expect(() => loadConfig()).toThrow('questionWaitSecs');
  }
});

it('parks only after the question deadline, retaining the question and freeing the headless slot', () => {
  fs.writeFileSync(path.join(home, 'active', id, 'runner.json'), JSON.stringify({ pid: 999001, startedAt: new Date(now - 2 * 86_400_000).toISOString() }));
  appendStatus(id, 'work', 'needs-decision', 'Which option?', askedAt);
  expect(parkQuestion(id, 'work', 86400, now - 1)).toBeUndefined();
  expect(slotUsage('work').headless).toBe(1);
  expect(parkQuestion(id, 'work', 86400, now)?.note).toMatch(/parked: no answer in/);
  expect(isParked(id, 'work')).toBe(true);
  expect(slotUsage('work')).toEqual({ headless: 0, traps: 0, parked: 1 });
  expect(readStatusLog(id, 'work').at(-1)?.verb).toBe('needs-decision');
  expect(parkedDispatches(now)[0]).toMatchObject({ id, waiting: { on: 'person' }, note: expect.stringContaining('no answer') });
  sendMessage(id, 'work', 'Use A', 'glass');
  expect(isParked(id, 'work')).toBe(true); // slot stays free until the runner actually starts
  fs.writeFileSync(path.join(home, 'active', id, 'runner.json'), JSON.stringify({ pid: 999002, startedAt: new Date(now + 1).toISOString() }));
  expect(isParked(id, 'work')).toBe(false);
});

it('does not park an answered question, or reuse a previous question park for a new report', () => {
  appendStatus(id, 'work', 'blocked', 'Which option?', askedAt);
  sendMessage(id, 'work', 'Use A', 'terminal');
  expect(parkQuestion(id, 'work', 0, now)).toBeUndefined();
  appendStatus(id, 'work', 'needs-decision', 'Another question', new Date(now).toISOString());
  parkQuestion(id, 'work', 0, now);
  appendStatus(id, 'work', 'working', 'Continuing');
  expect(questionPark(id, 'work')).toBeUndefined();
});

it('releases a trap claim on timeout, then reacquires it on a late answer when the trap is free', () => {
  const trap = { trapId: 'test-trap', name: 'test-gull', sessionId: 'same-session', worktree: path.join(home, 'worktrees/test'), harness: 'codex', claimed: id };
  fs.writeFileSync(path.join(home, 'soaking/test-trap.json'), JSON.stringify(trap));
  fs.writeFileSync(path.join(home, 'active', id, 'claim.json'), JSON.stringify({ by: 'wt:test-trap', sessionId: trap.sessionId }));
  appendStatus(id, 'work', 'needs-decision', 'Which option?', askedAt);
  reconcileTrapQuestions(now, 86400);
  expect(readTrap(trap.trapId)?.claimed).toBeUndefined();
  expect(slotUsage('work')).toEqual({ headless: 0, traps: 0, parked: 1 });
  sendMessage(id, 'work', 'Use B', 'github:reviewer');
  reconcileTrapQuestions(now + 1000, 86400);
  expect(readTrap(trap.trapId)?.claimed).toBe(id);
  expect(readTrap(trap.trapId)?.sessionId).toBe('same-session');
  expect(readStatusLog(id, 'work').at(-1)?.verb).toBe('working');
  expect(slotUsage('work')).toEqual({ headless: 0, traps: 1, parked: 0 });
});

it('preserves an answered parked catch for an absent trap by queuing it back to the same address', () => {
  fs.writeFileSync(path.join(home, 'active', id, 'claim.json'), JSON.stringify({ by: 'wt:absent-trap', sessionId: 'same-session' }));
  appendStatus(id, 'work', 'needs-decision', 'Which option?', askedAt);
  parkQuestion(id, 'work', 86400, now);
  sendMessage(id, 'work', 'Use A', 'terminal');
  reconcileTrapQuestions(now + 1000, 86400);
  const queued = JSON.parse(fs.readFileSync(path.join(home, 'queue', `${id}.json`), 'utf8'));
  expect(queued).toMatchObject({ id, for: 'wt:absent-trap', sessionMode: 'continue', parkContext: expect.stringContaining('parked question was answered') });
  expect(fs.existsSync(path.join(home, 'active', id))).toBe(false);
});

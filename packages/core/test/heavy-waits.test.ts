import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acknowledge,
  appendStatus,
  checkHeavyLine,
  claimBait,
  enqueue,
  ensureLayout,
  heavyDaemonPass,
  heavyDir,
  joinHeavyLine,
  releaseHeavyTicket,
  signOnTrap,
  unhandled,
  wakeHeavyWaits,
} from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const prior = process.env.LOBSTAH_HOME;
const dispatch = 'heavy-wait-work';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-heavy-wakes-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  const worktree = path.join(home, 'worktree');
  fs.mkdirSync(worktree);
  const signed = signOnTrap({ worktree, cwd: worktree, repo: 'r', harness: 'codex', sessionId: 'heavy-wait-session', ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('could not sign on');
  enqueue({ id: dispatch, repo: 'r', brief: 'Check the release' });
  claimBait(signed.ok);
});
afterEach(() => {
  if (prior === undefined) delete process.env.LOBSTAH_HOME;
  else process.env.LOBSTAH_HOME = prior;
  removeTempDir(home);
});

describe('a trap paused on heavy', () => {
  it.each([0, 7])('gets a completion wake with exit %i and retained output, once across retries', (exit) => {
    const now = Date.now();
    const log = path.join(home, 'output.log');
    fs.writeFileSync(log, 'release check output\n');
    const ticket = joinHeavyLine({ pid: process.pid, command: 'release check', dispatch, lane: 'work', log }, now);
    checkHeavyLine(ticket.seq, now);
    appendStatus(dispatch, 'work', 'paused', 'Check running', new Date(now).toISOString(), { waitingOn: 'heavy' });
    expect(unhandled(dispatch, 'work')).toEqual([]);
    releaseHeavyTicket(ticket.seq, exit, now + 100);
    const [message] = unhandled(dispatch, 'work');
    expect(message!.text).toContain(`exited ${exit}`);
    expect(message!.text).toContain(`log: ${log}`);
    expect(message!.text).toContain('release check output');
    heavyDaemonPass(now + 200);
    expect(unhandled(dispatch, 'work')).toHaveLength(1);
    acknowledge(dispatch, 'work', message!.file);
    wakeHeavyWaits(now + 300);
    expect(unhandled(dispatch, 'work')).toEqual([]);
  });

  it('wakes immediately when no queued or running job exists, once per pause', () => {
    const now = Date.now();
    appendStatus(dispatch, 'work', 'paused', 'Push in line', new Date(now).toISOString(), { waitingOn: 'heavy' });
    expect(unhandled(dispatch, 'work').map((message) => message.text)).toEqual([expect.stringContaining('no heavy job found')]);
    wakeHeavyWaits();
    expect(unhandled(dispatch, 'work')).toHaveLength(1);
    appendStatus(dispatch, 'work', 'paused', 'Try again', new Date(now + 1).toISOString(), { waitingOn: 'heavy' });
    expect(unhandled(dispatch, 'work')).toHaveLength(2);
  });

  it('repairs a missed holder post on the next daemon pass', () => {
    const now = Date.now();
    const ticket = joinHeavyLine({ pid: process.pid, command: 'release check', dispatch, lane: 'work' }, now);
    checkHeavyLine(ticket.seq, now);
    appendStatus(dispatch, 'work', 'paused', 'Check running', new Date(now).toISOString(), { waitingOn: 'heavy' });
    fs.appendFileSync(
      path.join(heavyDir(), 'history.jsonl'),
      `${JSON.stringify({ ...ticket, endedAt: new Date(now + 100).toISOString(), exit: 9 })}\n`,
    );
    fs.rmSync(path.join(heavyDir(), 'line', `${String(ticket.seq).padStart(10, '0')}.json`));
    expect(unhandled(dispatch, 'work')).toEqual([]);
    heavyDaemonPass(now + 200);
    expect(unhandled(dispatch, 'work').map((message) => message.text)).toEqual([expect.stringContaining('exited 9')]);
  });

  it('resolves a pause recorded just after completion, including a later pause after handling that result', () => {
    const now = Date.now();
    const ticket = joinHeavyLine({ pid: process.pid, command: 'quick check', dispatch, lane: 'work' }, now - 2000);
    checkHeavyLine(ticket.seq, now - 1500);
    releaseHeavyTicket(ticket.seq, 0, now - 500);
    appendStatus(dispatch, 'work', 'paused', 'Just finished', new Date(now).toISOString(), { waitingOn: 'heavy' });
    const [message] = unhandled(dispatch, 'work');
    expect(message!.text).toContain('exited 0');
    acknowledge(dispatch, 'work', message!.file);
    appendStatus(dispatch, 'work', 'paused', 'Wait again', new Date(now + 1).toISOString(), { waitingOn: 'heavy' });
    expect(unhandled(dispatch, 'work')).toHaveLength(1);
  });
});

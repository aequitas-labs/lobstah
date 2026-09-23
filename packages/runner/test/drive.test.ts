import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendStatus,
  claimNext,
  enqueue,
  ensureLayout,
  eventsPath,
  laneDirs,
  lastEventAt,
  readStatusLog,
  requestCancel,
  sendMessage,
} from '@lobstah/core';
import { AsyncQueue } from '@lobstah/adapters';
import type { AdapterRun } from '@lobstah/adapters';
import type { NormalizedEvent } from '@lobstah/core';
import { drive, settle } from '../src/drive.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-runner-test-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function claimed(id: string): void {
  enqueue({ id, repo: 'r', brief: 'do the thing' });
  claimNext('work');
  appendStatus(id, 'work', 'working');
}

/**
 * A harness stand-in: each turn runs `turns[n]` (which may report status),
 * then emits turn-end and waits for input like the real adapters' InputGate.
 */
function fakeRun(turns: Array<() => void>) {
  const events = new AsyncQueue<NormalizedEvent>();
  const sent: string[] = [];
  let ended = false;
  let killed = false;
  let turn = 0;
  let resolveDone!: (v: { sessionId?: string; error?: string }) => void;
  const done = new Promise<{ sessionId?: string; error?: string }>((r) => (resolveDone = r));
  const finish = () => {
    events.close();
    resolveDone({ sessionId: 'sess' });
  };
  const runTurn = () => {
    turns[turn++]?.();
    events.push({ at: new Date().toISOString(), type: 'turn-end', data: {} });
  };
  const run: AdapterRun = {
    events,
    send: (text) => {
      sent.push(text);
      setTimeout(runTurn, 0);
    },
    end: () => {
      ended = true;
      finish();
    },
    kill: () => {
      killed = true;
      finish();
    },
    done,
  };
  setTimeout(runTurn, 0);
  return { run, sent, state: () => ({ ended, killed, turn }) };
}

const inboxDir = (id: string) => path.join(laneDirs('work').inbox, id);

const verbs = (id: string) => readStatusLog(id, 'work').map((e) => e.verb);

describe('drive — a headless worker waiting on a question stays alive', () => {
  it('needs-decision at turn end is not finalized; the answer is delivered and a later done finalizes', async () => {
    claimed('w1');
    const f = fakeRun([
      () => appendStatus('w1', 'work', 'needs-decision', 'proceed?'),
      () => appendStatus('w1', 'work', 'done', 'proceeded'),
    ]);
    const driving = drive(f.run, { id: 'w1', lane: 'work', pollMs: 10 });

    await sleep(100);
    expect(f.state().ended).toBe(false);
    expect(f.state().killed).toBe(false);
    expect(verbs('w1').at(-1)).toBe('needs-decision');

    sendMessage('w1', 'work', 'proceed and report done');
    const { cancelled } = await driving;
    expect(cancelled).toBe(false);
    expect(f.sent).toEqual(['proceed and report done']);
    expect(fs.existsSync(path.join(inboxDir('w1'), 'handled', '001.msg'))).toBe(true);
    expect(fs.existsSync(path.join(inboxDir('w1'), '001.msg'))).toBe(false);
    expect(f.state().ended).toBe(true);

    settle('w1', 'work', { cancelled, wallClockHit: false });
    const log = readStatusLog('w1', 'work');
    expect(log.map((e) => e.verb)).toEqual(['working', 'needs-decision', 'working', 'done']);
    expect(log.at(-1)?.note).toBe('proceeded');
  });

  it.each(['blocked', 'paused'] as const)('%s also holds the run open', async (verb) => {
    claimed('w2');
    const f = fakeRun([() => appendStatus('w2', 'work', verb)]);
    const driving = drive(f.run, { id: 'w2', lane: 'work', pollMs: 10 });
    await sleep(80);
    expect(f.state().ended).toBe(false);
    f.run.kill();
    await driving;
  });

  it('a cancel during the wait finalizes as failed with the cancel note', async () => {
    claimed('w3');
    const f = fakeRun([() => appendStatus('w3', 'work', 'needs-decision', 'proceed?')]);
    const driving = drive(f.run, { id: 'w3', lane: 'work', pollMs: 10 });
    await sleep(50);
    requestCancel('w3', 'work');
    const { cancelled } = await driving;
    expect(cancelled).toBe(true);
    expect(f.state().killed).toBe(true);
    settle('w3', 'work', { cancelled, wallClockHit: false });
    const last = readStatusLog('w3', 'work').at(-1);
    expect(last?.verb).toBe('failed');
    expect(last?.note).toBe('cancelled by operator');
  });

  it('the wall clock ends a wait', async () => {
    claimed('w4');
    let stopped = false;
    const f = fakeRun([() => appendStatus('w4', 'work', 'needs-decision', 'proceed?')]);
    const driving = drive(f.run, { id: 'w4', lane: 'work', pollMs: 10, stopped: () => stopped });
    await sleep(50);
    stopped = true;
    f.run.kill(); // what the runner's wall timer does
    await driving;
    settle('w4', 'work', { cancelled: false, wallClockHit: true });
    expect(readStatusLog('w4', 'work').at(-1)?.note).toBe('wall-clock limit exceeded');
  });

  it('a turn ending on working with an empty inbox still ends and stamps done', async () => {
    claimed('w5');
    const f = fakeRun([() => {}]);
    const { cancelled } = await drive(f.run, { id: 'w5', lane: 'work', pollMs: 10 });
    expect(f.state().ended).toBe(true);
    settle('w5', 'work', { cancelled, wallClockHit: false });
    expect(verbs('w5')).toEqual(['working', 'done']);
  });

  it('an answered question whose next turn ends without a report stamps done instead of waiting again', async () => {
    claimed('w6');
    const f = fakeRun([() => appendStatus('w6', 'work', 'needs-decision', 'proceed?'), () => {}]);
    const driving = drive(f.run, { id: 'w6', lane: 'work', pollMs: 10 });
    await sleep(30);
    sendMessage('w6', 'work', 'yes');
    await driving;
    expect(f.state().ended).toBe(true);
    settle('w6', 'work', { cancelled: false, wallClockHit: false });
    expect(verbs('w6').at(-1)).toBe('done');
  });

  it('the wait heartbeats the event stream the wedge detector reads', async () => {
    claimed('w7');
    const f = fakeRun([() => appendStatus('w7', 'work', 'needs-decision', 'proceed?')]);
    const driving = drive(f.run, { id: 'w7', lane: 'work', pollMs: 10 });
    await sleep(50);
    // Age the stream as if the wait had been silent for an hour.
    const before = lastEventAt('w7', 'work')!;
    const stale = new Date(Date.now() - 3_600_000);
    fs.utimesSync(eventsPath('w7', 'work'), stale, stale);
    await sleep(50);
    const after = lastEventAt('w7', 'work')!;
    expect(after).toBeGreaterThan(stale.getTime() + 3_500_000);
    expect(after).toBeGreaterThanOrEqual(before - 1000);
    f.run.kill();
    await driving;
  });
});

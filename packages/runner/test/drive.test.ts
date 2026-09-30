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
import { drive, settle, unreportedNudge } from '../src/drive.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-runner-test-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function claimed(id: string): void {
  enqueue({ id, repo: 'r', brief: 'do the thing' });
  claimNext('work');
  appendStatus(id, 'work', 'working');
}

interface TurnApi {
  /** Report live background work, as the Claude adapter does from background_tasks_changed. */
  bg(live: number): void;
  /** End this turn with a result subtype, e.g. an error the harness cannot continue from. */
  endWith(subtype: string): void;
}

/**
 * A harness stand-in: each turn runs `turns[n]` (which may report status),
 * then emits turn-end and waits for input like the real adapters' InputGate.
 * `wake()` starts the next turn with no message, as the harness does when
 * background work settles.
 */
function fakeRun(turns: Array<(api: TurnApi) => void>) {
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
  const bg = (live: number) => events.push({ at: new Date().toISOString(), type: 'background', data: { live } });
  const runTurn = () => {
    let data: Record<string, unknown> = {};
    turns[turn++]?.({ bg, endWith: (subtype) => (data = { subtype }) });
    events.push({ at: new Date().toISOString(), type: 'turn-end', data });
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
  return { run, sent, bg, wake: runTurn, state: () => ({ ended, killed, turn }) };
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

  it('blocked also holds the run open', async () => {
    claimed('w2');
    const f = fakeRun([() => appendStatus('w2', 'work', 'blocked')]);
    const driving = drive(f.run, { id: 'w2', lane: 'work', pollMs: 10 });
    await sleep(80);
    expect(f.state().ended).toBe(false);
    f.run.kill();
    await driving;
  });

  it('paused parks the run: the session ends at turn end, no verb is added, and the result says parked', async () => {
    claimed('w2p');
    let parkedCalls = 0;
    const f = fakeRun([() => appendStatus('w2p', 'work', 'paused', 'waiting on review', undefined, { waitingOn: 'review' })]);
    const result = await drive(f.run, { id: 'w2p', lane: 'work', pollMs: 10, onPark: () => parkedCalls++ });
    expect(result).toMatchObject({ parked: true, final: false, cancelled: false });
    expect(f.state().ended).toBe(true);
    expect(f.state().killed).toBe(false);
    expect(parkedCalls).toBe(1);
    expect(verbs('w2p')).toEqual(['working', 'paused']);
    const events = fs.readFileSync(eventsPath('w2p', 'work'), 'utf8');
    expect(events).toContain('"parked":"paused"');
    expect(events).toContain('"on":"review"');
  });

  it('a message already queued at a paused turn end is delivered instead of parking', async () => {
    claimed('w2m');
    const f = fakeRun([
      () => {
        appendStatus('w2m', 'work', 'paused');
        sendMessage('w2m', 'work', 'the review is in');
      },
      () => appendStatus('w2m', 'work', 'done', 'finished'),
    ]);
    const result = await drive(f.run, { id: 'w2m', lane: 'work', pollMs: 10 });
    expect(result.parked).toBeUndefined();
    expect(result.final).toBe(true);
    expect(f.sent).toEqual(['the review is in']);
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
    settle('w4', 'work', { cancelled: false, wallClockHit: true,
      budgetNote: 'checkpoint committed (2 files); lobstah/w4@abc123; draft PR https://github.com/example/repo/pull/7' });
    expect(readStatusLog('w4', 'work').at(-1)?.note).toBe(
      'budget: out of time; checkpoint committed (2 files); lobstah/w4@abc123; draft PR https://github.com/example/repo/pull/7; send continue to resume');
  });

  it('an answered question whose next turn ends without a report is asked to report, not waited on again', async () => {
    claimed('w6');
    const f = fakeRun([
      () => appendStatus('w6', 'work', 'needs-decision', 'proceed?'),
      () => {},
      () => appendStatus('w6', 'work', 'done', 'proceeded'),
    ]);
    const driving = drive(f.run, { id: 'w6', lane: 'work', pollMs: 10 });
    await sleep(30);
    sendMessage('w6', 'work', 'yes');
    await driving;
    expect(f.sent).toEqual(['yes', unreportedNudge('w6')]);
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

describe("drive — only the worker's report finishes a dispatch", () => {
  it('a quiet turn is asked once to report; a done after that finishes', async () => {
    claimed('q1');
    const f = fakeRun([() => {}, () => appendStatus('q1', 'work', 'done', 'finished')]);
    const { cancelled } = await drive(f.run, { id: 'q1', lane: 'work', pollMs: 10 });
    expect(f.sent).toEqual([unreportedNudge('q1')]);
    expect(f.state().ended).toBe(true);
    settle('q1', 'work', { cancelled, wallClockHit: false });
    expect(verbs('q1')).toEqual(['working', 'done']);
  });

  it('silence after being asked fails the run — it is never stamped done', async () => {
    claimed('q2');
    const f = fakeRun([() => {}, () => {}]);
    const { cancelled } = await drive(f.run, { id: 'q2', lane: 'work', pollMs: 10 });
    expect(f.sent).toEqual([unreportedNudge('q2')]);
    expect(f.state().ended).toBe(true);
    settle('q2', 'work', { cancelled, wallClockHit: false });
    const last = readStatusLog('q2', 'work').at(-1);
    expect(last?.verb).toBe('failed');
    expect(last?.note).toBe('ended without reporting a result, after being asked to');
  });

  it('a quiet turn with live background work is held open, and the woken worker finishes', async () => {
    // BAS-1056: the push ran past the tool timeout into the background, the
    // worker ended its turn to wait, and ending the session killed the push.
    claimed('q3');
    const f = fakeRun([(api) => api.bg(1), () => appendStatus('q3', 'work', 'done', 'PR opened')]);
    const driving = drive(f.run, { id: 'q3', lane: 'work', pollMs: 10, backgroundWaitMs: 60_000 });
    await sleep(80);
    expect(f.state().ended).toBe(false);
    expect(f.sent).toEqual([]); // held, not nudged
    f.bg(0);
    f.wake(); // the push settled; the harness wakes the worker
    await driving;
    expect(f.state().ended).toBe(true);
    settle('q3', 'work', { cancelled: false, wallClockHit: false });
    expect(verbs('q3')).toEqual(['working', 'done']);
  });

  it('background work that never settles is bounded by the window', async () => {
    claimed('q4'); // a dev server left running
    const f = fakeRun([(api) => api.bg(1), () => {}]);
    await drive(f.run, { id: 'q4', lane: 'work', pollMs: 10, backgroundWaitMs: 50 });
    expect(f.sent).toEqual([unreportedNudge('q4')]);
    expect(verbs('q4').at(-1)).toBe('failed');
  });

  it('settled work that does not wake the worker gets a short grace, not the whole window', async () => {
    claimed('q5');
    const f = fakeRun([(api) => api.bg(1), () => appendStatus('q5', 'work', 'done')]);
    const driving = drive(f.run, { id: 'q5', lane: 'work', pollMs: 10, backgroundWaitMs: 60_000, settleGraceMs: 50 });
    await sleep(30);
    f.bg(0); // settled, but no wake follows
    await driving;
    expect(f.sent).toEqual([unreportedNudge('q5')]);
    expect(verbs('q5').at(-1)).toBe('done');
  });

  it('the background hold heartbeats the event stream the wedge detector reads', async () => {
    claimed('q6');
    const f = fakeRun([(api) => api.bg(1)]);
    const driving = drive(f.run, { id: 'q6', lane: 'work', pollMs: 10, backgroundWaitMs: 60_000 });
    await sleep(50);
    const stale = new Date(Date.now() - 3_600_000);
    fs.utimesSync(eventsPath('q6', 'work'), stale, stale);
    await sleep(50);
    expect(lastEventAt('q6', 'work')!).toBeGreaterThan(stale.getTime() + 3_500_000);
    f.run.kill();
    await driving;
  });

  it('a cancel during the background hold ends the run as cancelled', async () => {
    claimed('q7');
    const f = fakeRun([(api) => api.bg(1)]);
    const driving = drive(f.run, { id: 'q7', lane: 'work', pollMs: 10, backgroundWaitMs: 60_000 });
    await sleep(40);
    requestCancel('q7', 'work');
    const { cancelled } = await driving;
    expect(cancelled).toBe(true);
    expect(f.state().killed).toBe(true);
  });

  it('a turn the harness ended in error is ended, not nudged', async () => {
    // A refused resume: an error result before any work. The runner's cold
    // fallback needs this session to end, and the harness cannot take a turn.
    claimed('q9');
    const f = fakeRun([(api) => api.endWith('error_during_execution')]);
    await drive(f.run, { id: 'q9', lane: 'work', pollMs: 10 });
    expect(f.state().ended).toBe(true);
    expect(f.sent).toEqual([]);
    settle('q9', 'work', { cancelled: false, wallClockHit: false, error: 'No conversation found' });
    expect(verbs('q9').at(-1)).toBe('failed');
  });

  it('a run that stops on its own without a report settles as failed', () => {
    claimed('q8');
    settle('q8', 'work', { cancelled: false, wallClockHit: false });
    const last = readStatusLog('q8', 'work').at(-1);
    expect(last?.verb).toBe('failed');
    expect(last?.note).toBe('stopped without reporting a result');
  });
});

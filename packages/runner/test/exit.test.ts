import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendStatus,
  claimNext,
  enqueue,
  ensureLayout,
  laneDirs,
  readEvidence,
  readStatusLog,
  readWorktreeLock,
  requestCancel,
} from '@lobstah/core';
import type { NormalizedEvent } from '@lobstah/core';
import { AsyncQueue } from '@lobstah/adapters';
import type { Adapter, AdapterRun, AdapterStartOpts } from '@lobstah/adapters';
import { worktreePath } from '@lobstah/worktree';
import { main } from '../src/run.js';
import type { RunnerDeps } from '../src/run.js';
import { drive, settle } from '../src/drive.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-exit-test-'));
  process.env.LOBSTAH_HOME = home;
  delete process.env.LOBSTAH_RESUME;
  delete process.env.LOBSTAH_NUDGE;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at = () => new Date().toISOString();
const verbs = (id: string) => readStatusLog(id, 'work').map((e) => e.verb);

function config(limits: string): void {
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    `[repos.r]\npath = ${JSON.stringify(path.join(home, 'repo'))}\ntrunk = "main"\n\n` +
      `[limits]\npushEarly = false\ndraftPr = false\ncheckpointOnStop = false\n${limits}\n`,
  );
}

interface FakeOpts {
  /** What the worker does in its one turn, before the turn ends. */
  turn?: (id: string) => void;
  /** Close the stream when the session is ended (a harness that exits normally). */
  closeOnEnd?: boolean;
  /** Close the stream when killed. A real harness may not. */
  closeOnKill?: boolean;
  /** Resolve `done` with this error when the stream closes. */
  error?: string;
  /** Never emit turn-end: the turn runs until something stops it. */
  endlessTurn?: boolean;
  /** Report before `start` returns, so no clock tick can come first. */
  reportAtStart?: (id: string) => void;
}

/**
 * A harness stand-in with one turn. Its stream closes only as configured:
 * the default never closes after `end()`, like the harness on 2026-09-29.
 */
function fakeHarness(o: FakeOpts = {}) {
  const calls = { end: 0, kill: 0 };
  let run: AdapterRun | undefined;
  const adapter: Adapter = {
    name: 'claude',
    async start(s: AdapterStartOpts): Promise<AdapterRun> {
      const events = new AsyncQueue<NormalizedEvent>();
      let resolveDone!: (v: { sessionId?: string; error?: string }) => void;
      const done = new Promise<{ sessionId?: string; error?: string }>((r) => (resolveDone = r));
      o.reportAtStart?.(s.id);
      const close = () => {
        events.close();
        resolveDone({ sessionId: 'sess', ...(o.error ? { error: o.error } : {}) });
      };
      setTimeout(() => {
        events.push({ at: at(), type: 'session', data: { sessionId: 'sess' } });
        events.push({ at: at(), type: 'tool-start', data: { name: 'Bash' } });
        o.turn?.(s.id);
        if (!o.endlessTurn) events.push({ at: at(), type: 'turn-end', data: { subtype: 'success' } });
      }, 0);
      run = {
        events,
        send: () => {},
        end: () => {
          calls.end++;
          if (o.closeOnEnd) close();
        },
        kill: () => {
          calls.kill++;
          if (o.closeOnKill) close();
        },
        done,
      };
      return run;
    },
  };
  return { adapter, calls };
}

function deps(adapter: Adapter, reaps: { n: number }): Partial<RunnerDeps> {
  return {
    loadAdapter: () => adapter,
    allocate: async (_repo, id) => {
      // A git dir, so the runner takes a real worktree lock.
      fs.mkdirSync(path.join(worktreePath(id), '.git'), { recursive: true });
      return worktreePath(id);
    },
    collectEvidence: async () => ({ branch: 'lobstah/x', commits: [] }),
    reap: async () => {
      reaps.n++;
      return 0;
    },
  };
}

async function runDispatch(id: string, d: Partial<RunnerDeps>): Promise<number> {
  enqueue({ id, repo: 'r', brief: 'do the thing' });
  expect(claimNext('work')).toBe(id);
  const t0 = Date.now();
  await main(path.join(laneDirs('work').active, id), 'work', d);
  return Date.now() - t0;
}

const reportDone = (id: string) => appendStatus(id, 'work', 'done', 'finished');

describe('a runner exits after done', () => {
  it('a stream that never closes after end(): the runner exits within the grace, kills once, done stays', async () => {
    config('exitGraceSecs = 0.3');
    const h = fakeHarness({ turn: reportDone });
    const reaps = { n: 0 };
    const ms = await runDispatch('e1', deps(h.adapter, reaps));

    expect(ms).toBeLessThan(0.3 * 1000 + 2000 + 3000);
    expect(h.calls.end).toBe(1);
    expect(h.calls.kill).toBe(1);
    expect(reaps.n).toBeGreaterThanOrEqual(1);
    expect(verbs('e1').at(-1)).toBe('done');
    expect(verbs('e1').filter((v) => v === 'failed')).toEqual([]);
    const stopped = readEvidence('e1', 'work').harnessStopped;
    expect(stopped?.reason).toBe('exit-grace');
    // The active record is completed and the worktree lock released on the kill path.
    expect(fs.existsSync(path.join(laneDirs('work').active, 'e1'))).toBe(false);
    expect(fs.existsSync(path.join(laneDirs('work').done, 'e1'))).toBe(true);
    expect(readWorktreeLock(worktreePath('e1'))).toBeUndefined();
  }, 15_000);

  it('a harness that closes normally after done is not killed', async () => {
    config('exitGraceSecs = 5');
    const h = fakeHarness({ turn: reportDone, closeOnEnd: true });
    const reaps = { n: 0 };
    const ms = await runDispatch('e2', deps(h.adapter, reaps));

    expect(ms).toBeLessThan(5000);
    expect(h.calls.kill).toBe(0);
    expect(verbs('e2').at(-1)).toBe('done');
    expect(readEvidence('e2', 'work').harnessStopped).toBeUndefined();
    // Leftover work is still stopped on the way out.
    expect(reaps.n).toBe(1);
    expect(readWorktreeLock(worktreePath('e2'))).toBeUndefined();
  });

  it('the wall clock does not turn done into failed', async () => {
    // The clock would expire long before the grace ends; done stops it.
    config('wallClockSecs = 0.1\nmaxWallClockSecs = 0.1\nexitGraceSecs = 1');
    const h = fakeHarness({ reportAtStart: reportDone });
    await runDispatch('e3', deps(h.adapter, { n: 0 }));

    expect(h.calls.kill).toBe(1);
    expect(verbs('e3')).toEqual(['working', 'done']);
  }, 15_000);

  it('an adapter error after done does not turn done into failed', async () => {
    config('exitGraceSecs = 5');
    const h = fakeHarness({ turn: reportDone, closeOnEnd: true, error: 'claude exited 1 — boom' });
    await runDispatch('e4', deps(h.adapter, { n: 0 }));

    expect(verbs('e4')).toEqual(['working', 'done']);
  });

  it('a run with no final report and a wall clock hit fails out of time, as before', async () => {
    config('wallClockSecs = 0.2\nmaxWallClockSecs = 0.2');
    const h = fakeHarness({ endlessTurn: true, closeOnKill: true });
    const reaps = { n: 0 };
    await runDispatch('e5', deps(h.adapter, reaps));

    const last = readStatusLog('e5', 'work').at(-1);
    expect(last?.verb).toBe('failed');
    expect(last?.note).toMatch(/^budget: out of time/);
    expect(h.calls.kill).toBe(1);
    // Nothing is reaped for a run that did not finish.
    expect(reaps.n).toBe(0);
    expect(readWorktreeLock(worktreePath('e5'))).toBeUndefined();
  });
});

describe('drive after a final report', () => {
  function claimed(id: string): void {
    enqueue({ id, repo: 'r', brief: 'do the thing' });
    claimNext('work');
    appendStatus(id, 'work', 'working');
  }

  function openStream(onTurn: () => void) {
    const events = new AsyncQueue<NormalizedEvent>();
    const calls = { end: 0, kill: 0 };
    const run: AdapterRun = {
      events,
      send: () => {},
      end: () => calls.end++,
      kill: () => calls.kill++,
      done: new Promise(() => {}),
    };
    setTimeout(() => {
      onTurn();
      events.push({ at: at(), type: 'turn-end', data: { subtype: 'success' } });
    }, 0);
    return { run, calls };
  }

  it('a cancel after done stops the harness at once and done stays', async () => {
    claimed('d1');
    const f = openStream(() => reportDone('d1'));
    const t0 = Date.now();
    const driving = drive(f.run, { id: 'd1', lane: 'work', pollMs: 10, exitGraceMs: 60_000 });
    await sleep(50);
    requestCancel('d1', 'work');
    const r = await driving;

    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.final).toBe(true);
    expect(r.cancelled).toBe(false);
    expect(r.stopped?.reason).toBe('cancel');
    expect(f.calls.kill).toBe(1);
    settle('d1', 'work', { cancelled: true, wallClockHit: false });
    expect(verbs('d1')).toEqual(['working', 'done']);
  });

  it('the final report calls onFinal once', async () => {
    claimed('d2');
    const f = openStream(() => reportDone('d2'));
    let finals = 0;
    const r = await drive(f.run, { id: 'd2', lane: 'work', pollMs: 10, exitGraceMs: 50, onFinal: () => finals++ });
    expect(finals).toBe(1);
    expect(r.stopped?.reason).toBe('exit-grace');
    expect(f.calls.end).toBe(1);
    expect(f.calls.kill).toBe(1);
  });
});

describe('settle — the worker’s done or failed is final', () => {
  function reported(id: string, verb: 'done' | 'failed'): void {
    enqueue({ id, repo: 'r', brief: 'do the thing' });
    claimNext('work');
    appendStatus(id, 'work', 'working');
    appendStatus(id, 'work', verb, 'reported');
  }

  it.each([
    ['wall clock', { cancelled: false, wallClockHit: true, budgetNote: 'no working-tree changes' }],
    ['adapter error', { cancelled: false, wallClockHit: false, error: 'claude exited 143' }],
    ['cancel', { cancelled: true, wallClockHit: false }],
  ] as const)('a %s after done adds no verb', (_what, input) => {
    reported('s1', 'done');
    settle('s1', 'work', input);
    expect(verbs('s1')).toEqual(['working', 'done']);
  });

  it('a wall clock after the worker’s own failed adds no verb', () => {
    reported('s2', 'failed');
    settle('s2', 'work', { cancelled: false, wallClockHit: true });
    expect(verbs('s2')).toEqual(['working', 'failed']);
  });

  it('without a final report, a wall clock still fails the run out of time', () => {
    enqueue({ id: 's3', repo: 'r', brief: 'do the thing' });
    claimNext('work');
    appendStatus('s3', 'work', 'working');
    settle('s3', 'work', { cancelled: false, wallClockHit: true });
    const last = readStatusLog('s3', 'work').at(-1);
    expect(last?.verb).toBe('failed');
    expect(last?.note).toMatch(/^budget: out of time/);
  });
});

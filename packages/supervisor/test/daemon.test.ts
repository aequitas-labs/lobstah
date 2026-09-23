import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendEvent,
  appendStatus,
  claimNext,
  enqueue,
  ensureLayout,
  eventsPath,
  laneDirs,
  readStatusLog,
  requestCancel,
  touchEvents,
} from '@lobstah/core';
import { reconcileOne } from '../src/daemon.js';
import type { ActiveState } from '../src/daemon.js';
import { DEFAULT_LIMITS, DEFAULT_SOAK } from '@lobstah/core';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-test-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

const cfg = { repos: {}, harness: {}, limits: DEFAULT_LIMITS, soak: DEFAULT_SOAK };

/** A pid that cannot exist — well above every OS's pid ceiling. */
const DEAD_PID = 2 ** 30;

function claimed(id: string): ActiveState {
  enqueue({ id, repo: 'r', brief: 'do the thing' });
  claimNext('work');
  return { id, lane: 'work', dir: path.join(laneDirs('work').active, id) };
}

describe('reconcileOne — cancellation never enters the restart ladder', () => {
  it('cancel with a dead runner finalizes as failed instead of respawning', () => {
    const st = claimed('c1');
    appendStatus('c1', 'work', 'working', 'attempt 1');
    fs.writeFileSync(
      path.join(st.dir, 'runner.json'),
      JSON.stringify({ pid: DEAD_PID, startedAt: new Date().toISOString(), attempts: 1 }),
    );
    st.runner = { pid: DEAD_PID, startedAt: new Date().toISOString(), attempts: 1 };
    requestCancel('c1', 'work');

    reconcileOne(st, cfg, () => {});

    expect(fs.existsSync(st.dir)).toBe(false);
    expect(fs.existsSync(path.join(laneDirs('work').done, 'c1'))).toBe(true);
    const last = readStatusLog('c1', 'work').at(-1);
    expect(last?.verb).toBe('failed');
    expect(last?.note).toMatch(/cancelled/);
  });

  it('cancel before any runner spawned finalizes without spawning', () => {
    const st = claimed('c2');
    requestCancel('c2', 'work');

    reconcileOne(st, cfg, () => {});

    expect(fs.existsSync(st.dir)).toBe(false);
    expect(fs.existsSync(path.join(laneDirs('work').done, 'c2'))).toBe(true);
    expect(readStatusLog('c2', 'work').at(-1)?.verb).toBe('failed');
  });

  it('cancel on an already-terminal dispatch finalizes without rewriting the verb', () => {
    const st = claimed('c3');
    appendStatus('c3', 'work', 'done', 'finished before the cancel landed');
    requestCancel('c3', 'work');

    reconcileOne(st, cfg, () => {});

    expect(fs.existsSync(path.join(laneDirs('work').done, 'c3'))).toBe(true);
    expect(readStatusLog('c3', 'work').at(-1)?.verb).toBe('done');
  });
});

describe('reconcileOne — session-claimed catches are not the daemon\'s children', () => {
  function sessionClaimed(id: string): ActiveState {
    const st = claimed(id);
    fs.writeFileSync(
      path.join(st.dir, 'claim.json'),
      JSON.stringify({ by: 'session:sess-1', harness: 'claude', worktree: '/wt', at: new Date().toISOString() }),
    );
    return st;
  }

  it('never spawns a runner for a session-claimed dispatch', () => {
    const st = sessionClaimed('sc1');
    reconcileOne(st, cfg, () => {});
    expect(fs.existsSync(path.join(st.dir, 'runner.json'))).toBe(false);
    expect(fs.existsSync(st.dir)).toBe(true); // still active, untouched
  });

  it('finalizes a session-claimed dispatch once its verb is terminal', () => {
    const st = sessionClaimed('sc2');
    appendStatus('sc2', 'work', 'done', 'the session finished it');
    reconcileOne(st, cfg, () => {});
    expect(fs.existsSync(path.join(laneDirs('work').done, 'sc2'))).toBe(true);
  });

  it('leaves a cancelled, non-terminal session claim for the park notice', () => {
    const st = sessionClaimed('sc3');
    appendStatus('sc3', 'work', 'working', 'mid-flight');
    requestCancel('sc3', 'work');
    reconcileOne(st, cfg, () => {});
    expect(fs.existsSync(st.dir)).toBe(true); // the session gets told first
    expect(readStatusLog('sc3', 'work').at(-1)?.verb).toBe('working');
  });
});

describe('reconcileOne — a headless runner waiting on a question is not a wedge', () => {
  it('a live runner parked on needs-decision whose wait heartbeats the stream is left alone', () => {
    const st = claimed('wq');
    appendStatus('wq', 'work', 'working');
    appendStatus('wq', 'work', 'needs-decision', 'proceed?');
    // Last real event an hour ago — past the wedge threshold — then the
    // runner's inbox wait refreshes the stream, as drive() does every poll.
    appendEvent('wq', 'work', { at: new Date().toISOString(), type: 'turn-end', data: {} });
    const stale = new Date(Date.now() - 3_600_000);
    fs.utimesSync(eventsPath('wq', 'work'), stale, stale);
    touchEvents('wq', 'work');
    // Our own pid stands in for the live runner; a wedge verdict would SIGKILL it.
    st.runner = { pid: process.pid, startedAt: stale.toISOString(), attempts: 1 };
    const logs: string[] = [];

    reconcileOne(st, cfg, (m) => logs.push(m));

    expect(logs).toEqual([]);
    expect(fs.existsSync(st.dir)).toBe(true);
    expect(readStatusLog('wq', 'work').at(-1)?.verb).toBe('needs-decision');
  });
});

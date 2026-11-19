import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { activeIds, appendStatus, claimNext, enqueue, ensureLayout, GB, laneDirs, loadConfig, readHold,
  readStatusLog, requestCancel, slotUsage, parkQuestion, sendMessage, mergeEvidence } from '@lobstah/core';
import type { Lane } from '@lobstah/core';
import { reconcileOne, tick, wakeParked } from '../src/daemon.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-slots-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

function activeTrap(id: string, lane: Lane = 'work'): void {
  enqueue({ id, repo: 'demo', brief: 'trap work' }, lane);
  claimNext(lane);
  fs.writeFileSync(path.join(laneDirs(lane).active, id, 'claim.json'), JSON.stringify({
    by: `wt:${id}`, sessionId: id, harness: 'codex', worktree: '/unused', at: new Date().toISOString(),
  }));
}

function activeHeadless(id: string, lane: Lane = 'work'): void {
  enqueue({ id, repo: 'demo', brief: 'headless work' }, lane);
  claimNext(lane);
  fs.writeFileSync(path.join(laneDirs(lane).active, id, 'runner.json'), JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString(), attempts: 1,
  }));
}

describe('only daemon-spawned work spends headless slots', () => {
  it('keeps an expired question parked until a late answer wakes its original session', () => {
    activeHeadless('question');
    const startedAt = new Date(Date.now() - 2 * 86400_000).toISOString();
    const runner = { pid: 2 ** 30, startedAt, attempts: 1 };
    const dir = path.join(laneDirs('work').active, 'question');
    fs.writeFileSync(path.join(dir, 'runner.json'), JSON.stringify(runner));
    mergeEvidence('question', 'work', { sessionId: 'same-session', harness: 'codex' });
    appendStatus('question', 'work', 'needs-decision', 'Which option?', new Date(Date.now() - 86400_000).toISOString());
    parkQuestion('question', 'work', 86400);
    const spawned: Array<{ id: string; resume?: string; wake?: string }> = [];
    const spawn: Parameters<typeof wakeParked>[3] = (state, options) => { spawned.push({ id: state.id, resume: options?.resume, wake: options?.wake }); };
    reconcileOne({ id: 'question', lane: 'work', dir, runner }, loadConfig(), () => {}, spawn);
    expect(spawned).toEqual([]);
    expect(wakeParked('work', 1, () => {}, spawn)).toBe(0);
    sendMessage('question', 'work', 'Use A', 'glass');
    expect(wakeParked('work', 1, () => {}, spawn)).toBe(1);
    expect(spawned).toEqual([{ id: 'question', resume: 'same-session', wake: '1 operator message(s) arrived' }]);
  });
  it('claims two headless dispatches alongside three trap catches at maxConcurrent=2', () => {
    for (const id of ['trap1', 'trap2', 'trap3']) activeTrap(id);
    for (const id of ['head1', 'head2']) enqueue({ id, repo: 'demo', brief: 'headless work' });
    const spawned: string[] = [];
    tick(() => {}, { spawnRunner: (st) => { spawned.push(st.id); } });
    expect(slotUsage('work')).toEqual({ headless: 2, traps: 3, parked: 0 });
    expect(spawned).toEqual(['head1', 'head2']);
    expect(activeIds('work')).toHaveLength(5);
  });

  it('holds a third headless dispatch when both slots are occupied', () => {
    activeHeadless('head1');
    activeHeadless('head2');
    enqueue({ id: 'head3', repo: 'demo', brief: 'queued work' });
    const spawned: string[] = [];
    tick(() => {}, { spawnRunner: (st) => { spawned.push(st.id); } });
    expect(spawned).toEqual([]);
    expect(activeIds('work')).toEqual(['head1', 'head2']);
  });

  it('does not run the free-space guard for trap-only active work or sticky bait', () => {
    for (const id of ['trap1', 'trap2', 'trap3']) activeTrap(id);
    enqueue({ id: 'addressed', repo: 'demo', brief: 'for missing trap', for: 'wt:missing' });
    fs.writeFileSync(path.join(home, 'config.toml'), '[limits]\nminFreeGB = 1\n');
    let reads = 0;
    tick(() => {}, { freeBytes: () => { reads++; return 0 * GB; }, spawnRunner: () => {} });
    expect(reads).toBe(0);
    expect(readHold()).toBeUndefined();
    expect(activeIds('work')).toHaveLength(3);
  });

  it('leaves trap-any work and chores queued even with free headless slots', () => {
    for (const lane of ['work', 'chore'] as const) enqueue({ id: `trap-any-${lane}`, repo: 'demo', brief: 'b', trapAny: true }, lane);
    const spawned: string[] = [];
    let reads = 0;
    tick(() => {}, { spawnRunner: (st) => { spawned.push(st.id); }, freeBytes: () => { reads++; return 100 * GB; } });
    expect(spawned).toEqual([]);
    expect(reads).toBe(0);
    expect(activeIds('work')).toEqual([]);
    expect(activeIds('chore')).toEqual([]);
    expect(fs.existsSync(path.join(laneDirs('work').queue, 'trap-any-work.json'))).toBe(true);
    expect(fs.existsSync(path.join(laneDirs('chore').queue, 'trap-any-chore.json'))).toBe(true);
  });

  it('uses the same counting rule in the chore lane', () => {
    activeTrap('trap-chore', 'chore');
    enqueue({ id: 'headless-chore', repo: 'demo', brief: 'chore' }, 'chore');
    const spawned: string[] = [];
    tick(() => {}, { spawnRunner: (st) => { spawned.push(st.id); } });
    expect(slotUsage('chore')).toEqual({ headless: 1, traps: 1, parked: 0 });
    expect(spawned).toEqual(['headless-chore']);
  });

  it('never wedges, restarts, or runs a wall-clock runner for a trap catch', () => {
    activeTrap('protected');
    appendStatus('protected', 'work', 'working', 'still in the interactive session');
    requestCancel('protected', 'work');
    const dir = path.join(laneDirs('work').active, 'protected');
    const spawned: string[] = [];
    reconcileOne({ id: 'protected', lane: 'work', dir,
      runner: { pid: 2 ** 30, startedAt: new Date(0).toISOString(), attempts: 1 } },
      loadConfig(), () => {}, (st) => { spawned.push(st.id); });
    expect(spawned).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'wallclock.json'))).toBe(false);
    expect(readStatusLog('protected', 'work').at(-1)?.verb).toBe('working');
  });
});

describe('a finished dispatch holds no slot', () => {
  it('done with its runner still alive: not counted, and the slot goes to queued work', () => {
    activeHeadless('fin1'); // runner pid: this test process, alive
    appendStatus('fin1', 'work', 'done', 'finished');
    activeHeadless('head2');
    enqueue({ id: 'head3', repo: 'demo', brief: 'queued work' });
    expect(slotUsage('work')).toEqual({ headless: 1, traps: 0, parked: 0 });
    const spawned: string[] = [];
    tick(() => {}, { spawnRunner: (st) => { spawned.push(st.id); } });
    expect(spawned).toEqual(['head3']);
    // The finished dispatch is left to its runner, which is still exiting.
    expect(activeIds('work')).toContain('fin1');
    expect(slotUsage('work')).toEqual({ headless: 2, traps: 0, parked: 0 });
  });

  it('failed by the worker counts the same way', () => {
    activeHeadless('fin2');
    appendStatus('fin2', 'work', 'failed', 'could not');
    expect(slotUsage('work')).toEqual({ headless: 0, traps: 0, parked: 0 });
  });
});

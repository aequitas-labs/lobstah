import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addWatch,
  listWatches,
  pendingWatchEvents,
  readWatch,
  readWatchEvents,
  removeWatch,
  runWatchCheck,
  watchDue,
} from '../src/watch.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-watch-'));
  process.env.LOBSTAH_HOME = dir;
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A check script that pages two events after cursor 0, then goes quiet. */
function pagingCheck(): string {
  const script = path.join(dir, 'check.cjs');
  fs.writeFileSync(
    script,
    `const cursor = process.argv[2];
if (cursor === '0') console.log(JSON.stringify({ cursor: '2', events: [{ seq: 1, summary: 'first' }, { seq: 2, summary: 'second' }] }));
else console.log(JSON.stringify({ cursor }));
`,
  );
  return `node "${script}" {cursor}`;
}

describe('addWatch', () => {
  it('is idempotent: re-adding updates the check but keeps the cursor', () => {
    addWatch('ume:abc', 'echo one', { cursor: '7' });
    const updated = addWatch('ume:abc', 'echo two');
    expect(updated.check).toBe('echo two');
    expect(updated.cursor).toBe('7');
    expect(readWatch('ume:abc')!.check).toBe('echo two');
    expect(listWatches()).toHaveLength(1);
  });

  it('defaults to man ownership; --for makes it dispatch-owned', () => {
    expect(addWatch('a', 'true').owner).toBe('man');
    expect(addWatch('b', 'true', { owner: 'dispatch:1234' }).owner).toBe('dispatch:1234');
  });
});

describe('runWatchCheck', () => {
  it('appends events, advances the cursor, and goes quiet on the next check', () => {
    const w = addWatch('ume:abc', pagingCheck());
    const first = runWatchCheck(w);
    expect(first.fresh.map((e) => e.summary)).toEqual(['first', 'second']);
    expect(first.watch.cursor).toBe('2');
    expect(first.watch.lastError).toBeUndefined();
    const second = runWatchCheck(first.watch);
    expect(second.fresh).toEqual([]);
    expect(readWatchEvents('ume:abc')).toHaveLength(2);
  });

  it('a failing check records lastError and leaves the cursor untouched', () => {
    const w = addWatch('bad', 'exit 3');
    const { watch, fresh } = runWatchCheck(w);
    expect(fresh).toEqual([]);
    expect(watch.lastError).toContain('exit 3');
    expect(watch.cursor).toBe('0');
  });

  it('unparseable output is an error, not silent progress', () => {
    const w = addWatch('garbled', 'echo not-json');
    const { watch } = runWatchCheck(w);
    expect(watch.lastError).toContain('unparseable');
    expect(watch.cursor).toBe('0');
  });

  it('done: true retires the watch once its events are consumed', () => {
    const script = path.join(dir, 'done.cjs');
    fs.writeFileSync(script, `console.log(JSON.stringify({ cursor: '1', events: [{ seq: 1, summary: 'final' }], done: true }));`);
    const w = addWatch('ume:closing', `node "${script}"`);
    runWatchCheck(w);
    const pending = pendingWatchEvents(true);
    expect(pending[0]!.events[0]!.summary).toBe('final');
    expect(listWatches()).toHaveLength(0); // consumed + done = retired
  });
});

describe('pendingWatchEvents', () => {
  it('is level-triggered: peek leaves events standing, consume advances', () => {
    const w = addWatch('ume:abc', pagingCheck());
    runWatchCheck(w);
    expect(pendingWatchEvents(false)).toHaveLength(1);
    expect(pendingWatchEvents(false)).toHaveLength(1); // still standing
    expect(pendingWatchEvents(true)).toHaveLength(1);
    expect(pendingWatchEvents(true)).toHaveLength(0); // consumed
  });

  it('separates man-owned from dispatch-owned delivery', () => {
    const w = addWatch('ume:worker', pagingCheck(), { owner: 'dispatch:1234' });
    runWatchCheck(w);
    expect(pendingWatchEvents(false, 'man')).toHaveLength(0);
    expect(pendingWatchEvents(false, 'dispatch')).toHaveLength(1);
  });
});

describe('watchDue', () => {
  it('due immediately when never checked, then not until the cadence elapses', () => {
    const w = addWatch('ume:abc', 'true');
    expect(watchDue(w, 45)).toBe(true);
    w.lastCheckedAt = new Date().toISOString();
    expect(watchDue(w, 45)).toBe(false);
    w.lastCheckedAt = new Date(Date.now() - 46_000).toISOString();
    expect(watchDue(w, 45)).toBe(true);
    w.everySecs = 120;
    expect(watchDue(w, 45)).toBe(false); // per-watch override wins
  });
});

describe('removeWatch', () => {
  it('removes the watch and its events', () => {
    const w = addWatch('ume:abc', pagingCheck());
    runWatchCheck(w);
    expect(removeWatch('ume:abc')).toBe(true);
    expect(listWatches()).toHaveLength(0);
    expect(readWatchEvents('ume:abc')).toEqual([]);
    expect(removeWatch('ume:abc')).toBe(false);
  });
});

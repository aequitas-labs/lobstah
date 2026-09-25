import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  activeIds,
  cancelQueued,
  claimNext,
  complete,
  enqueue,
  ensureLayout,
  pendingIds,
  queuedAt,
  queuedDescriptor,
  laneDirs,
  readDescriptor,
  readStatusLog,
} from '../src/index.js';

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

const desc = (id: string) => ({ id, repo: 'r', brief: 'do the thing' });

describe('queue', () => {
  it('rejects descriptors missing required fields', () => {
    expect(() => enqueue({ id: 'x', repo: '', brief: 'b' })).toThrow(/requires/);
  });

  it('enqueue then claim moves the descriptor atomically', () => {
    enqueue(desc('a1'));
    expect(pendingIds('work')).toEqual(['a1']);
    expect(claimNext('work')).toBe('a1');
    expect(pendingIds('work')).toEqual([]);
    expect(activeIds('work')).toEqual(['a1']);
    expect(readDescriptor('a1', 'work').brief).toBe('do the thing');
  });

  it('a descriptor is claimed at most once under contention', () => {
    enqueue(desc('c1'));
    const winners = [claimNext('work'), claimNext('work'), claimNext('work')].filter(Boolean);
    expect(winners).toEqual(['c1']);
  });

  it('claims oldest first', () => {
    enqueue(desc('old'));
    const f = path.join(home, 'queue', 'old.json');
    fs.utimesSync(f, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    enqueue(desc('new'));
    expect(claimNext('work')).toBe('old');
  });

  it('complete moves active to done', () => {
    enqueue(desc('d1'));
    claimNext('work');
    complete('d1', 'work');
    expect(activeIds('work')).toEqual([]);
    expect(fs.existsSync(path.join(home, 'done', 'd1', 'descriptor.json'))).toBe(true);
  });

  it('lanes are separate namespaces', () => {
    enqueue(desc('w1'), 'work');
    enqueue(desc('ch1'), 'chore');
    expect(pendingIds('work')).toEqual(['w1']);
    expect(pendingIds('chore')).toEqual(['ch1']);
    expect(claimNext('chore')).toBe('ch1');
    expect(pendingIds('work')).toEqual(['w1']);
  });
});

describe('cancelQueued', () => {
  it('finalizes an unclaimed item with an audit trail, never a silent delete', () => {
    enqueue(desc('q1'));
    expect(cancelQueued('q1', 'work')).toBe(true);
    expect(pendingIds('work')).toEqual([]);
    expect(fs.existsSync(path.join(home, 'done', 'q1', 'descriptor.json'))).toBe(true);
    const last = readStatusLog('q1', 'work').at(-1);
    expect(last?.verb).toBe('failed');
    expect(last?.note).toBe('cancelled before claim');
  });

  it('loses the race to a claim and says so', () => {
    enqueue(desc('q2'));
    expect(claimNext('work')).toBe('q2');
    expect(cancelQueued('q2', 'work')).toBe(false);
    expect(activeIds('work')).toEqual(['q2']); // the claim stands untouched
  });

  it('an unknown id cancels nothing', () => {
    expect(cancelQueued('nope', 'work')).toBe(false);
  });
});

describe('queuedAt', () => {
  it('enqueue stamps queuedAt; the descriptor round-trips it', () => {
    const before = Date.now();
    enqueue(desc('q1'));
    const stamped = queuedDescriptor('q1', 'work')!.queuedAt!;
    expect(Date.parse(stamped)).toBeGreaterThanOrEqual(before - 1000);
    expect(queuedAt('q1', 'work')).toBe(stamped);
    // A descriptor that already carries queuedAt keeps it.
    enqueue({ ...desc('q2'), queuedAt: '2026-01-02T03:04:05.000Z' });
    expect(queuedDescriptor('q2', 'work')!.queuedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(queuedAt('q2', 'work')).toBe('2026-01-02T03:04:05.000Z');
    // The claim carries it into active/ unchanged.
    expect(claimNext('work', (d) => d.id !== 'q2')).toBe('q2');
    expect(readDescriptor('q2', 'work').queuedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('an old descriptor without queuedAt falls back to the file mtime', () => {
    const file = path.join(laneDirs('work').queue, 'old.json');
    fs.writeFileSync(file, JSON.stringify(desc('old')));
    const mtime = new Date('2026-03-04T05:06:07.000Z');
    fs.utimesSync(file, mtime, mtime);
    expect(queuedAt('old', 'work')).toBe('2026-03-04T05:06:07.000Z');
  });

  it('is undefined once the descriptor has left the queue', () => {
    enqueue(desc('gone'));
    claimNext('work');
    expect(queuedAt('gone', 'work')).toBeUndefined();
  });
});

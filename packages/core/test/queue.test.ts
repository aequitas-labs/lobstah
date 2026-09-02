import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { activeIds, claimNext, complete, enqueue, ensureLayout, pendingIds, readDescriptor } from '../src/index.js';

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

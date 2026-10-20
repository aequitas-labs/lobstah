import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LOCK_CEILING_MS, tryDirLock, withDirLock } from '../src/dir-lock.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let dir: string, lock: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-dir-lock-'));
  lock = path.join(dir, 'thing.json.lock');
});
afterEach(() => removeTempDir(dir));

const STALE = 120_000;
/** Judged from far enough ahead that the lock's age is past the stale rule. */
const later = () => Date.now() + 10 * 60_000;
/** A pid that has exited. */
const deadPid = () => spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid!;
const setOwnerPid = (pid: number) => {
  const file = path.join(lock, 'owner');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), pid }));
};

describe('directory lock', () => {
  it('release does not throw when the lock is already gone', () => {
    const held = tryDirLock(lock, { staleMs: STALE })!;
    fs.rmSync(lock, { recursive: true, force: true });
    expect(() => held.release()).not.toThrow();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("a stale-lock takeover cannot remove a live holder's lock, however long it runs", () => {
    const held = tryDirLock(lock, { staleMs: STALE })!;
    expect(tryDirLock(lock, { staleMs: STALE, now: later() })).toBeUndefined();
    expect(fs.existsSync(lock)).toBe(true);
    held.release();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("a dead holder's stale lock is taken over, and the dead holder's release leaves the new lock alone", () => {
    const first = tryDirLock(lock, { staleMs: STALE })!;
    setOwnerPid(deadPid());
    // Not yet stale: the owner is dead, but the lock is young.
    expect(tryDirLock(lock, { staleMs: STALE })).toBeUndefined();
    const second = tryDirLock(lock, { staleMs: STALE, now: later() })!;
    expect(second).toBeDefined();
    first.release();
    expect(fs.existsSync(lock)).toBe(true);
    expect(tryDirLock(lock, { staleMs: STALE, now: later() })).toBeUndefined();
    second.release();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('a lock with no owner (a crash before it was written, or an older lobstah) goes stale by age', () => {
    fs.mkdirSync(lock);
    expect(tryDirLock(lock, { staleMs: STALE })).toBeUndefined();
    const held = tryDirLock(lock, { staleMs: STALE, now: later() });
    expect(held).toBeDefined();
    held!.release();
  });

  it('a live pid past the ceiling is a reused pid: the lock is taken over', () => {
    tryDirLock(lock, { staleMs: STALE })!;
    expect(tryDirLock(lock, { staleMs: STALE, now: Date.now() + LOCK_CEILING_MS + 60_000 })).toBeDefined();
    expect(fs.readdirSync(dir)).toEqual(['thing.json.lock']);
  });

  it('withDirLock releases after the action, even when it throws, and reports a held lock as busy', () => {
    expect(withDirLock(lock, () => 7, { staleMs: STALE, waitMs: 0, busy: () => new Error('busy') })).toBe(7);
    expect(fs.existsSync(lock)).toBe(false);
    expect(() => withDirLock(lock, () => { throw new Error('boom'); }, { staleMs: STALE, waitMs: 0, busy: () => new Error('busy') })).toThrow('boom');
    expect(fs.existsSync(lock)).toBe(false);
    const held = tryDirLock(lock, { staleMs: STALE })!;
    expect(() => withDirLock(lock, () => 7, { staleMs: STALE, waitMs: 0, busy: () => new Error('busy') })).toThrow('busy');
    held.release();
  });

  it('an action whose lock was removed underneath it still completes', () => {
    expect(
      withDirLock(lock, () => {
        fs.rmSync(lock, { recursive: true, force: true });
        return 'done';
      }, { staleMs: STALE, waitMs: 0, busy: () => new Error('busy') }),
    ).toBe('done');
  });
});

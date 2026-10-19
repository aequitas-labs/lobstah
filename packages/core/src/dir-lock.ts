import fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * A cross-process lock: an atomically created directory holding an owner
 * file (pid and a per-acquisition token).
 *
 * - A lock is taken over only when it is older than `staleMs` AND its owner
 *   is gone (dead pid, or no owner file: a crash between mkdir and write, or
 *   a lock from an older lobstah). A live owner keeps its lock however long
 *   its work runs (a `gh` call can outlast any fixed threshold), up to
 *   `LOCK_CEILING_MS`, which only guards against a reused pid.
 * - Release removes the lock only while it still carries this holder's
 *   token, and a lock that is already gone is not an error.
 */
export interface DirLock {
  /** Retries a transient denial until `deadline` (default: two seconds). */
  release(deadline?: number): void;
}

/** Past this age a lock is stale even with a live pid: that pid was reused. */
export const LOCK_CEILING_MS = 60 * 60_000;

const OWNER = 'owner';
const TRANSIENT = ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'];

interface Owner {
  pid: number;
  token: string;
  at: string;
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const code = (err: unknown) => (err as NodeJS.ErrnoException).code ?? '';

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return code(err) === 'EPERM';
  }
}

function readOwner(lock: string): Owner | undefined {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(lock, OWNER), 'utf8')) as Owner;
    return typeof o.pid === 'number' && typeof o.token === 'string' ? o : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remove a lock directory and its owner file, riding out Windows' brief
 * denials until `deadline`. A lock that is already gone is success.
 */
function removeLock(dir: string, deadline: number): void {
  for (;;) {
    try {
      fs.rmSync(path.join(dir, OWNER), { force: true });
      fs.rmdirSync(dir);
      return;
    } catch (err) {
      if (code(err) === 'ENOENT') return;
      if (!TRANSIENT.includes(code(err)) || Date.now() >= deadline) throw err;
      pause(10);
    }
  }
}

/**
 * Take a stale lock away from its dead owner. The lock is renamed aside
 * first, so two processes cannot both remove it, and one that changed
 * hands after it was judged is put back.
 */
function takeOver(lock: string, staleMs: number, now: number): void {
  let age: number;
  try {
    age = now - fs.statSync(lock).mtimeMs;
  } catch {
    return; // released meanwhile
  }
  if (age <= staleMs) return;
  const owner = readOwner(lock);
  if (owner && age <= LOCK_CEILING_MS && pidAlive(owner.pid)) return;
  const aside = `${lock}.stale-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(lock, aside);
  } catch {
    return; // another process took it over first
  }
  if (readOwner(aside)?.token !== owner?.token) {
    try {
      fs.renameSync(aside, lock);
      return;
    } catch {
      /* its place is taken; the moved lock is abandoned */
    }
  }
  try {
    removeLock(aside, Date.now() + 2000);
  } catch {
    /* a leftover aside directory blocks no one */
  }
}

type Attempt = { held: DirLock } | { busy: true; error?: Error };

function attempt(lock: string, staleMs: number, now: number): Attempt {
  for (let n = 0; n < 2; n++) {
    try {
      fs.mkdirSync(lock);
    } catch (err) {
      // Windows can deny briefly while another holder's removed directory still has open handles.
      if (TRANSIENT.includes(code(err))) return { busy: true, error: err as Error };
      if (code(err) !== 'EEXIST') throw err;
      if (n === 0) takeOver(lock, staleMs, now);
      continue;
    }
    const mine: Owner = { pid: process.pid, token: randomUUID(), at: new Date().toISOString() };
    try {
      fs.writeFileSync(path.join(lock, OWNER), JSON.stringify(mine));
    } catch (err) {
      try {
        fs.rmdirSync(lock);
      } catch {
        /* left for the stale rule */
      }
      throw err;
    }
    let released = false;
    return {
      held: {
        release(deadline = Date.now() + 2000) {
          if (released) return;
          released = true;
          // Taken over (this holder was judged dead) or already removed: not ours to remove.
          if (readOwner(lock)?.token !== mine.token) return;
          removeLock(lock, deadline);
        },
      },
    };
  }
  return { busy: true };
}

/** One attempt: the lock, or undefined while another holder has it. */
export function tryDirLock(lock: string, opts: { staleMs: number; now?: number }): DirLock | undefined {
  const a = attempt(lock, opts.staleMs, opts.now ?? Date.now());
  return 'held' in a ? a.held : undefined;
}

/**
 * Wait up to `waitMs` for the lock, run `action` holding it, then release
 * it. A persistent Windows denial surfaces as itself at the deadline; a
 * held lock as `busy()`.
 */
export function withDirLock<T>(
  lock: string,
  action: () => T,
  opts: { staleMs: number; waitMs: number; busy: () => Error; pauseMs?: number },
): T {
  const deadline = Date.now() + opts.waitMs;
  let a: Attempt;
  while (!('held' in (a = attempt(lock, opts.staleMs, Date.now())))) {
    if (Date.now() >= deadline) throw a.error ?? opts.busy();
    pause(opts.pauseMs ?? 10);
  }
  try {
    return action();
  } finally {
    a.held.release(deadline);
  }
}

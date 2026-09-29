import { afterEach, describe, expect, it, vi } from 'vitest';
import { startWallClock } from '../src/wallclock.js';
import { pausedWaiting } from '@lobstah/core';
import type { StatusEntry } from '@lobstah/core';

afterEach(() => vi.useRealTimers());

describe('the wall clock does not run while paused on something external', () => {
  it('does not spend either window or hard ceiling during a reported paused --waiting-on', () => {
    vi.useFakeTimers();
    let t = 0;
    let last: StatusEntry = { at: '2026-09-28T00:00:00Z', verb: 'working' };
    let expired = 0;
    const clock = startWallClock({ limitMs: 10_000, maxMs: 20_000, tickMs: 1000,
      now: () => t, paused: () => pausedWaiting(last), onExpire: () => expired++ });
    const advance = (seconds: number) => {
      for (let i = 0; i < seconds; i++) { t += 1000; vi.advanceTimersByTime(1000); }
    };
    advance(5);
    expect(clock.elapsed()).toBe(5000);
    last = { at: '2026-09-28T00:00:05Z', verb: 'paused', waitingOn: 'review' };
    expect(pausedWaiting(last)).toBe(true);
    advance(3600); // longer than both limits in real elapsed time
    expect(clock.elapsed()).toBe(5000);
    expect(clock.window()).toBe(10_000);
    expect(expired).toBe(0);
    last = { at: '2026-09-28T01:00:05Z', verb: 'working' };
    advance(5);
    expect(clock.elapsed()).toBe(10_000);
    expect(expired).toBe(1);
  });

  it('does not grant a fresh ceiling after a restart, regardless of restart allowance', () => {
    vi.useFakeTimers();
    let t = 0;
    let expired = 0;
    const first = startWallClock({ limitMs: 10_000, maxMs: 20_000, tickMs: 1000,
      now: () => t, paused: () => false, onExpire: () => expired++ });
    t += 9000; vi.advanceTimersByTime(9000);
    const spent = first.elapsed();
    first.stop();
    // A second runner attempt resumes the same budget, not another 20 seconds.
    const resumed = startWallClock({ limitMs: 10_000, maxMs: 20_000,
      initialElapsedMs: spent, initialWindowMs: 10_000, tickMs: 1000,
      now: () => t, paused: () => false, onExpire: () => expired++ });
    t += 1000; vi.advanceTimersByTime(1000);
    expect(resumed.elapsed()).toBe(10_000);
    expect(expired).toBe(1);
  });

  it('counts only running time', () => {
    vi.useFakeTimers();
    let t = 0;
    let paused = false;
    let expired = 0;
    const clock = startWallClock({ limitMs: 10_000, tickMs: 1000, now: () => t, paused: () => paused, onExpire: () => expired++ });
    const advance = (ms: number) => {
      for (let i = 0; i < ms / 1000; i++) {
        t += 1000;
        vi.advanceTimersByTime(1000);
      }
    };
    advance(6000);
    paused = true;
    advance(60_000); // a long review: the clock stands still
    expect(expired).toBe(0);
    expect(clock.elapsed()).toBe(6000);
    paused = false;
    advance(3000);
    expect(expired).toBe(0);
    advance(1000);
    expect(expired).toBe(1);
    advance(5000);
    expect(expired).toBe(1);
  });

  it('extends only for new progress and never beyond the hard ceiling', () => {
    vi.useFakeTimers();
    let t = 0;
    let progress = true;
    let expired = 0;
    const clock = startWallClock({
      limitMs: 10_000, maxMs: 30_000, tickMs: 1000, now: () => t,
      paused: () => false, progress: () => { const fresh = progress; progress = false; return fresh; },
      onExpire: () => expired++,
    });
    for (let i = 0; i < 10; i++) { t += 1000; vi.advanceTimersByTime(1000); }
    expect(clock.window()).toBe(20_000);
    expect(expired).toBe(0);
    for (let i = 0; i < 10; i++) { t += 1000; vi.advanceTimersByTime(1000); }
    expect(expired).toBe(1); // old progress cannot extend a second time
  });

  it('resumes the prior active budget instead of resetting on restart', () => {
    vi.useFakeTimers();
    let t = 0;
    let expired = 0;
    const clock = startWallClock({ limitMs: 10_000, maxMs: 40_000,
      initialElapsedMs: 28_000, initialWindowMs: 30_000, tickMs: 1000,
      now: () => t, paused: () => false, progress: () => false, onExpire: () => expired++ });
    t += 2000;
    vi.advanceTimersByTime(2000);
    expect(clock.elapsed()).toBe(30_000);
    expect(expired).toBe(1);
  });
});

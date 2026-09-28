import { afterEach, describe, expect, it, vi } from 'vitest';
import { startWallClock } from '../src/wallclock.js';

afterEach(() => vi.useRealTimers());

describe('the wall clock does not run while paused on something external', () => {
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
});

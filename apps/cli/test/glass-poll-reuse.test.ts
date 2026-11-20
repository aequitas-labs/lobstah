import { describe, expect, it } from 'vitest';
import { POLL_REUSE_IDLE_MS, POLL_REUSE_MS, pollReuse, pollReuseMs } from '../src/glass-snapshot-thread.js';
import type { PollBody } from '../src/glass-poll.js';

const body = (hash: string): PollBody => ({ body: '{}', hash, beats: {} }) as unknown as PollBody;

/** Pages poll every two seconds; count how many polls a build answered. */
function builds(polls: number, hashAt: (i: number) => string, pages = 1): number {
  let clock = 0, count = 0;
  const reuse = pollReuse(() => clock);
  for (let i = 0; i < polls; i++) {
    for (let page = 0; page < pages; page++) {
      if (reuse.reused(true)) continue;
      count++;
      reuse.record(true, body(hashAt(i)));
    }
    clock += 2000;
  }
  return count;
}

describe('glass poll reuse', () => {
  it('backs off to one build every ten seconds while nothing changes, whatever the number of pages', () => {
    expect(pollReuseMs(0)).toBe(POLL_REUSE_MS);
    expect(pollReuseMs(1)).toBe(2 * POLL_REUSE_MS);
    expect(pollReuseMs(20)).toBe(POLL_REUSE_IDLE_MS);
    // Ten minutes of polls from three pages: at most one build per idle window, plus the back-off ramp.
    const idle = builds(300, () => 'same', 3);
    expect(idle).toBeLessThanOrEqual(600_000 / POLL_REUSE_IDLE_MS + 3);
    expect(idle).toBeGreaterThan(0);
  });

  it('rebuilds every two seconds while the fleet keeps changing, and a write clears the reused body', () => {
    expect(builds(30, (i) => `h${i}`)).toBe(30);
    let clock = 0;
    const reuse = pollReuse(() => clock);
    reuse.record(true, body('a'));
    clock += 500;
    expect(reuse.reused(true)?.hash).toBe('a');
    expect(reuse.reused(false)).toBeUndefined();
    reuse.clear();
    expect(reuse.reused(true)).toBeUndefined();
  });
});

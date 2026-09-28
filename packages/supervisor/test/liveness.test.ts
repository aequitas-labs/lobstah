import { describe, expect, it } from 'vitest';
import { classify } from '../src/liveness.js';

const now = 1_000_000_000;
const threshold = 600_000;

describe('classify — dead and wedged get opposite treatment', () => {
  it('terminal verb wins regardless of process state', () => {
    expect(classify({ hasRunner: true, alive: true, lastVerb: 'done', now, wedgeThresholdMs: threshold })).toBe('terminal');
    // A budget stop reports failed with a budget: note; even a dead runner
    // must finalize instead of entering the restart ladder.
    expect(classify({ hasRunner: true, alive: false, lastVerb: 'failed', now, wedgeThresholdMs: threshold })).toBe('terminal');
  });
  it('no runner yet means unclaimed, not dead', () => {
    expect(classify({ hasRunner: false, now, wedgeThresholdMs: threshold })).toBe('unclaimed');
  });
  it('verified-dead process is dead', () => {
    expect(classify({ hasRunner: true, alive: false, lastVerb: 'working', now, wedgeThresholdMs: threshold })).toBe('dead');
  });
  it('alive with fresh activity is busy', () => {
    expect(
      classify({ hasRunner: true, alive: true, lastVerb: 'working', lastEventAt: now - 1000, now, wedgeThresholdMs: threshold }),
    ).toBe('busy');
  });
  it('alive with stale activity is wedged', () => {
    expect(
      classify({ hasRunner: true, alive: true, lastVerb: 'working', lastEventAt: now - threshold - 1, now, wedgeThresholdMs: threshold }),
    ).toBe('wedged');
  });
  it('alive with no events falls back to runner start time', () => {
    expect(
      classify({ hasRunner: true, alive: true, startedAt: now - 1000, now, wedgeThresholdMs: threshold }),
    ).toBe('busy');
    expect(
      classify({ hasRunner: true, alive: true, startedAt: now - threshold - 1, now, wedgeThresholdMs: threshold }),
    ).toBe('wedged');
  });
  it('unverifiable liveness is unknown, never idle', () => {
    expect(classify({ hasRunner: true, alive: undefined, lastVerb: 'working', now, wedgeThresholdMs: threshold })).toBe('unknown');
    expect(classify({ hasRunner: true, alive: true, now, wedgeThresholdMs: threshold })).toBe('unknown');
  });
});

describe('classify — a worker paused on something external is not wedged', () => {
  it('paused with --waiting-on stays busy past the wedge threshold; dead is still dead', () => {
    const now = 1_000_000_000;
    const old = now - 3600_000;
    const base = { hasRunner: true, alive: true, lastVerb: 'paused' as const, lastEventAt: old, now, wedgeThresholdMs: 600_000 };
    expect(classify(base)).toBe('wedged');
    expect(classify({ ...base, pausedWaiting: true })).toBe('busy');
    expect(classify({ ...base, alive: false, pausedWaiting: true })).toBe('dead');
  });
});

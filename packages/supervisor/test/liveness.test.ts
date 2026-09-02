import { describe, expect, it } from 'vitest';
import { classify } from '../src/liveness.js';

const now = 1_000_000_000;
const threshold = 600_000;

describe('classify — dead and wedged get opposite treatment', () => {
  it('terminal verb wins regardless of process state', () => {
    expect(classify({ hasRunner: true, alive: true, lastVerb: 'done', now, wedgeThresholdMs: threshold })).toBe('terminal');
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

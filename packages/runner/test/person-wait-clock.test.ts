import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, claimNext, enqueue, ensureLayout, sendMessage, workClockWaiting } from '@lobstah/core';
import { startWallClock } from '../src/wallclock.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-person-clock-'));
  process.env.LOBSTAH_HOME = home; ensureLayout();
  vi.useFakeTimers({ now: Date.parse('2026-11-19T12:00:00Z') });
  enqueue({ id: 'clock', repo: 'r', brief: 'Work' }); claimNext('work');
  appendStatus('clock', 'work', 'working');
});
afterEach(() => { vi.useRealTimers(); delete process.env.LOBSTAH_HOME; removeTempDir(home); });

it.each(['needs-decision', 'blocked'] as const)('stops both budget windows during %s and resumes immediately on an answer', (verb) => {
  let expired = 0;
  const clock = startWallClock({ limitMs: 10_000, maxMs: 20_000, tickMs: 1000, paused: () => workClockWaiting('clock', 'work'), onExpire: () => { expired++; } });
  vi.advanceTimersByTime(5000);
  appendStatus('clock', 'work', verb, 'Which option?');
  vi.advanceTimersByTime(60_000);
  expect(clock.elapsed()).toBe(5000);
  expect(clock.window()).toBe(10_000);
  expect(expired).toBe(0);
  sendMessage('clock', 'work', 'Use A', 'terminal');
  vi.advanceTimersByTime(5000);
  expect(clock.elapsed()).toBe(10_000);
  expect(expired).toBe(1);
  clock.stop();
});

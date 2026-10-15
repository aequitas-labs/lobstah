import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WAIT, IdleWait, enqueue, ensureLayout, loadConfig, resetWaitBackoff, sendMessage, waitTimeoutSecs } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-backoff-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

/** Advance virtual time, not the runner's clock or a real timeout. */
function quiet(session = 'helm', count = 7): void {
  for (let i = 0; i < count; i++) {
    const wait = new IdleWait(session, DEFAULT_WAIT, undefined, 0);
    wait.timedOut(wait.timeoutSecs * 1000);
  }
}

describe('idle waiter history', () => {
  it('persists three base waits, then doubles to the cap across process re-arms', () => {
    const timeouts: number[] = [];
    for (let i = 0; i < 10; i++) {
      const wait = new IdleWait('helm', DEFAULT_WAIT, undefined, 0);
      timeouts.push(wait.timeoutSecs);
      wait.timedOut(wait.timeoutSecs * 1000);
    }
    expect(timeouts).toEqual([900, 900, 900, 1800, 3600, 7200, 14400, 14400, 14400, 14400]);
    expect(new IdleWait('trap', DEFAULT_WAIT).timeoutSecs).toBe(900);
  });

  it('honors configured base, repeats and cap (including a non-power-of-two cap)', () => {
    const config = { baseTimeoutSecs: 30, baseRepeats: 2, maxTimeoutSecs: 100 };
    expect([0, 1, 2, 3, 1000].map((n) => waitTimeoutSecs(n, config))).toEqual([30, 30, 60, 100, 100]);
    fs.writeFileSync(path.join(home, 'config.toml'), '[wait]\nbaseTimeoutSecs = 30\nbaseRepeats = 2\nmaxTimeoutSecs = 100\n');
    expect(loadConfig().wait).toEqual(config);
  });

  it.each(['baseTimeoutSecs = 0', 'baseRepeats = -1', 'baseRepeats = 1.5', 'maxTimeoutSecs = "four hours"', 'maxTimeoutSecs = 100'])('rejects invalid config: %s', (line) => {
    fs.writeFileSync(path.join(home, 'config.toml'), `[wait]\n${line}\n`);
    expect(() => loadConfig()).toThrow('[wait].');
  });

  it('uses an explicit timeout as the base, without growing the re-arm command', () => {
    for (let i = 0; i < 3; i++) new IdleWait('trap', DEFAULT_WAIT, '600', 0).timedOut(600_000);
    expect(new IdleWait('trap', DEFAULT_WAIT, '600').timeoutSecs).toBe(1200);
    // Switching between a foreground override and a Stop park keeps history.
    expect(new IdleWait('trap', DEFAULT_WAIT).timeoutSecs).toBe(1800);
  });

  it('probes, unfinished waits and mere re-arms do not advance history', () => {
    quiet();
    new IdleWait('helm', DEFAULT_WAIT, '0', 0).timedOut(1000);
    new IdleWait('helm', DEFAULT_WAIT, undefined, 0).timedOut(1);
    expect(new IdleWait('helm', DEFAULT_WAIT).timeoutSecs).toBe(14400);
  });

  it('a delivered event resets only its session, including delivery during a probe', () => {
    quiet('helm'); quiet('trap');
    new IdleWait('helm', DEFAULT_WAIT, '0').woke();
    expect(new IdleWait('helm', DEFAULT_WAIT).timeoutSecs).toBe(900);
    expect(new IdleWait('trap', DEFAULT_WAIT).timeoutSecs).toBe(14400);
  });

  it.each(['prompt', 'dispatch', 'send'] as const)('%s resets already-armed waits and survives a late timeout write', (trigger) => {
    quiet('helm'); quiet('trap');
    const old = new IdleWait('helm', DEFAULT_WAIT, undefined, 0);
    expect(old.timeoutSecs).toBe(14400);
    if (trigger === 'prompt') resetWaitBackoff('helm');
    if (trigger === 'dispatch') enqueue({ id: 'work', repo: 'r', brief: 'b' });
    if (trigger === 'send') sendMessage('work', 'work', 'next');
    // The old invocation must not overwrite the reset on completion.
    old.timedOut(14_400_000);
    expect(new IdleWait('helm', DEFAULT_WAIT).timeoutSecs).toBe(900);
    expect(new IdleWait('trap', DEFAULT_WAIT).timeoutSecs).toBe(trigger === 'prompt' ? 14400 : 900);
    expect(old.remainingMs(1000)).toBe(900_000);
    expect(old.expired(900_999)).toBe(false);
    expect(old.expired(901_000)).toBe(true);
  });
});

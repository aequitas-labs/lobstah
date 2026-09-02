import { execFileSync } from 'node:child_process';
import { TERMINAL_VERBS } from '@lobstah/core';
import type { Verb } from '@lobstah/core';

export type Classification = 'terminal' | 'busy' | 'wedged' | 'dead' | 'unclaimed' | 'unknown';

export interface ClassifyInput {
  hasRunner: boolean;
  alive?: boolean;
  lastVerb?: Verb;
  lastEventAt?: number;
  startedAt?: number;
  now: number;
  wedgeThresholdMs: number;
}

/**
 * Three signal levels, none derived from another: runner liveness (pid),
 * agent activity (event stream), task state (declared verb). Missing,
 * malformed, stale, or unverified data is `unknown`, never idle.
 */
export function classify(input: ClassifyInput): Classification {
  const { hasRunner, alive, lastVerb, lastEventAt, startedAt, now, wedgeThresholdMs } = input;
  if (lastVerb && TERMINAL_VERBS.includes(lastVerb)) return 'terminal';
  if (!hasRunner) return 'unclaimed';
  if (alive === undefined) return 'unknown';
  if (!alive) return 'dead';
  const baseline = lastEventAt ?? startedAt;
  if (baseline === undefined) return 'unknown';
  return now - baseline > wedgeThresholdMs ? 'wedged' : 'busy';
}

/** Pid liveness with start-time verification, defeating pid reuse. */
export function processStartTime(pid: number): string | undefined {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).StartTime.Ticks`],
        { encoding: 'utf8' },
      ).trim();
      return out || undefined;
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function pidAlive(pid: number, recordedStart?: string): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (!recordedStart) return true;
  const current = processStartTime(pid);
  return current !== undefined && current === recordedStart;
}

/** Kill the runner's whole process tree — harnesses spawn children a bare kill orphans. */
export function killGroup(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // already gone
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

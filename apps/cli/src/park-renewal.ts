import * as fs from 'node:fs';
import * as path from 'node:path';
import { lobstahHome, readTrap, trapLabel } from '@lobstah/core';

/** A park shorter than this returned at once: the harness may be spinning. */
export const INSTANT_PARK_MS = 5_000;
/** Instant parks in a row after which the Stop hook stops renewing. */
export const MAX_INSTANT_PARKS = 3;

/** The renewal continuation: park again, and nothing else. */
export const RENEW_REASON = 'lobstah: this trap is still signed on and its park timed out. Park again: end this turn now and do nothing else.';

/** What the Stop hook prints when a trap's park ends without a wake. */
export type ParkRenewal =
  | { renew: true; output: { decision: 'block'; reason: string } }
  | { renew: false; output?: { systemMessage: string } };

interface RenewalState {
  /** Instant parks in a row. */
  instant: number;
  at: string;
}

const statePath = (trapId: string) => path.join(lobstahHome(), 'park-renewals', `${trapId}.json`);

function readState(trapId: string): RenewalState {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(trapId), 'utf8')) as RenewalState;
    return { instant: Number.isFinite(s.instant) ? s.instant : 0, at: s.at };
  } catch {
    return { instant: 0, at: '' };
  }
}

function writeState(trapId: string, state: RenewalState): void {
  const file = statePath(trapId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

/** Forget a trap's run of instant parks: a real wake, or the end of renewals. */
export function clearParkRenewal(trapId: string): void {
  fs.rmSync(statePath(trapId), { force: true });
}

/**
 * A trap's park in the Stop hook timed out after `parkedMs`. While the trap
 * is still signed on, the hook renews the park: it blocks the stop with a
 * continuation whose only instruction is to end the turn, and the next Stop
 * hook parks again. It stops renewing when the trap is stowed or its
 * registration is gone (silently), or after MAX_INSTANT_PARKS parks in a row that each returned within
 * INSTANT_PARK_MS (with a `systemMessage` that says why).
 * A stale daemon heartbeat after sleep is not a park failure: the trap can
 * keep polling its files and renewing its own heartbeat while the daemon recovers.
 */
export function parkRenewal(trapId: string, parkedMs: number, now: number = Date.now()): ParkRenewal {
  const reg = readTrap(trapId);
  if (!reg) {
    clearParkRenewal(trapId);
    return { renew: false };
  }
  const instant = parkedMs < INSTANT_PARK_MS ? readState(trapId).instant + 1 : 0;
  if (instant >= MAX_INSTANT_PARKS) {
    clearParkRenewal(trapId);
    return {
      renew: false,
      output: {
        systemMessage:
          `lobstah: trap ${trapLabel(reg)}'s park returned at once ${instant} times in a row, so it stopped renewing. ` +
          'Check `lobstah doctor`, then end a turn to park again.',
      },
    };
  }
  writeState(trapId, { instant, at: new Date(now).toISOString() });
  return { renew: true, output: { decision: 'block', reason: RENEW_REASON } };
}

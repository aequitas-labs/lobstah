import { loadConfig, retireTerminalPrWatches, syncStackReadiness } from '@lobstah/core';
import { observeWaitedPrs, finishResolvedWaits } from './pr-waits.js';
import { deliverRegisteredWatchActions } from './watch-automation.js';
import { pollSecs } from './pr-watch.js';
import { stampRepairerBeat } from './pr-repair.js';
import { deliverMergeWatchActions } from './watch-sources/merge.js';

/** PR observation projections, wait completion and authorized actions are source-owned. */
export function prWatchEffects(now: number, log: (message: string) => void): void {
  retireTerminalPrWatches();
  syncStackReadiness(loadConfig(), now);
  observeWaitedPrs({ everySecs: pollSecs(), now });
  // Release on merge needs the chain's completed wait before the cull pass.
  finishResolvedWaits(log);
  deliverRegisteredWatchActions(now, loadConfig().watch.maxForksPerCycle, log);
  deliverMergeWatchActions(log, { pr: {}, stack: {} }, now);
  stampRepairerBeat(now);
}

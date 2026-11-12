import { loadConfig, pruneRunHistory, retireFinishedRuns } from '@lobstah/core';

/** How often the daemon looks for finished run cards past their grace period. */
export const RUN_RETIRE_EVERY_MS = 30_000;
/** How often it prunes run history past `[limits].runRetentionDays`. */
export const RUN_PRUNE_EVERY_MS = 3_600_000;

/**
 * The daemon's run housekeeping. A finished run's card leaves the glass two
 * minutes after its run ends (the glass already hides it then); this
 * withdraws it, as Dismiss does, so its history moves with the card. Hourly,
 * it prunes run history older than `[limits].runRetentionDays` and proposals
 * the helm never posted.
 */
export function createRunCleanup(): (now: number, log: (message: string) => void) => void {
  let retiredAt = 0;
  let prunedAt = 0;
  return (now, log) => {
    if (now - retiredAt >= RUN_RETIRE_EVERY_MS) {
      retiredAt = now;
      const retired = retireFinishedRuns(now);
      if (retired.length) log(`run cleanup: ${retired.length} finished run card(s) left the glass`);
    }
    if (now - prunedAt >= RUN_PRUNE_EVERY_MS) {
      prunedAt = now;
      const { attempts, cards, proposals } = pruneRunHistory(loadConfig().limits.runRetentionDays, now);
      if (attempts || cards || proposals) log(`run cleanup: pruned ${attempts} run(s), ${cards} card(s) and ${proposals} proposal(s)`);
    }
  };
}

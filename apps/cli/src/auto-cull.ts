import type { DaemonCuller } from '@lobstah/supervisor';
import { applyCull, orderCull, planCull, planPressureCull } from './cull.js';
import { runMergeRelease } from './release.js';
import { loadConfig } from '@lobstah/core';

/**
 * The culler the CLI hands to the daemon. Cleanup runs without
 * measuring anything.
 *
 * retention: worktrees at `[limits].retentionDays`, records archived at
 * `[limits].recordRetentionDays`, minus every
 * dispatch whose PR is still open, with worktree groups before metadata-only groups.
 * release: with `[limits].releaseOnMerge`, the worktrees of merged PRs'
 * finished chains, when clean and pushed (see release.ts).
 * pressure: finished worktrees only, oldest first, one at a time, until the
 * caller's free-space check passes.
 */
export const cliCuller: DaemonCuller = {
  retention(days, now, log) {
    const plan = planCull(days, now, { measure: false, keepOpenPrs: true, worktrees: days > 0, recordRetentionDays: loadConfig().limits.recordRetentionDays });
    const items = orderCull(plan);
    if (items.length === 0) return 0;
    const applied = applyCull(items);
    const ids = new Set(applied.filter((i) => i.kind === 'done' || i.kind === 'worktree' || i.kind === 'state').map((i) => i.id));
    return ids.size;
  },
  release(now, log) {
    const { released, kept } = runMergeRelease(now);
    for (const k of kept) log(`release on merge: kept worktree ${k.id} (${k.reason})`);
    return released;
  },
  pressure(enough, now, log) {
    let removed = 0;
    for (const item of planPressureCull(now)) {
      if (enough()) break;
      if (applyCull([item]).length === 0) continue;
      removed++;
      log(`free-space cull: removed worktree ${item.id} (${item.ageDays}d old)`);
    }
    return removed;
  },
};

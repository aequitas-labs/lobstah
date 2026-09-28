import type { DaemonCuller } from '@lobstah/supervisor';
import { applyCull, limitBatch, planCull, planPressureCull } from './cull.js';
import { runMergeRelease } from './release.js';

/**
 * The culler the CLI hands to the daemon. Both passes delete without
 * measuring anything.
 *
 * retention: the `lobstah cull` plan at `[limits].retentionDays`, minus every
 * dispatch whose PR is still open, bounded to the oldest `batch` dispatches.
 * release: with `[limits].releaseOnMerge`, the worktrees of merged PRs'
 * finished chains, when clean and pushed (see release.ts).
 * pressure: finished worktrees only, oldest first, one at a time, until the
 * caller's free-space check passes.
 */
export const cliCuller: DaemonCuller = {
  retention(days, now, batch, log) {
    const plan = planCull(days, now, { measure: false, keepOpenPrs: true });
    const { batch: items, deferred } = limitBatch(plan, batch);
    if (items.length === 0) return 0;
    applyCull(items);
    const ids = new Set(items.filter((i) => i.kind === 'done' || i.kind === 'worktree' || i.kind === 'state').map((i) => i.id));
    if (deferred > 0) log(`retention cull: ${deferred} more group(s) left for the next pass`);
    return ids.size;
  },
  release(now, batch, log) {
    const { released, kept } = runMergeRelease(now, batch);
    for (const k of kept) log(`release on merge: kept worktree ${k.id} (${k.reason})`);
    return released;
  },
  pressure(enough, now, batch, log) {
    let removed = 0;
    for (const item of planPressureCull(now)) {
      if (removed >= batch || enough()) break;
      applyCull([item]);
      removed++;
      log(`free-space cull: removed worktree ${item.id} (${item.ageDays}d old)`);
    }
    return removed;
  },
};

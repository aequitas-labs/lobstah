import {
  listNotices, listReservations, lobstahHome, pendingIds, postNotice, queuedAt, queuedDescriptor,
  selectRepoTrap, trapLabel,
} from '@lobstah/core';
import type { Config, Descriptor, Lane } from '@lobstah/core';
import { throwNew, throwTrap } from './throw.js';
import type { ThrowOptions } from './throw.js';

/**
 * The daemon owns starts; trap-only work stays unaddressed until a real
 * claimant takes it. A slow or failed start cannot reserve that work.
 */
export function createTrapDispatchScheduler(options: Pick<ThrowOptions, 'adapter' | 'timeoutSecs' | 'pollMs'> = {}) {
  const running = new Set<string>();
  return (cfg: Config, now: number, log: (message: string) => void): void => {
    const groups = new Map<string, { descriptor: Descriptor; lane: Lane; since: string }>();
    for (const lane of ['chore', 'work'] as const) {
      for (const id of pendingIds(lane)) {
        const d = queuedDescriptor(id, lane);
        if (!d?.trapAny || d.for || !cfg.repos[d.repo]) continue;
        const key = JSON.stringify([lobstahHome(), d.repo, d.harness]);
        const since = queuedAt(id, lane) ?? new Date(now).toISOString();
        const prior = groups.get(key);
        if (!prior || since < prior.since) groups.set(key, { descriptor: d, lane, since });
      }
    }
    for (const [key, { descriptor: d, lane, since }] of groups) {
      if (running.has(key)) continue;
      const failures = listNotices(Number.MAX_SAFE_INTEGER).filter((n) =>
        n.kind === 'trap-start-failed' && n.repo === d.repo && n.at >= since);
      // Notices persist across daemon restarts, including throws that withdrew
      // their reservation. Do not keep retrying a quota-exhausted trap for this work.
      const failed = new Set(failures.flatMap((n) => n.refId ? [n.refId] : []));
      const choice = selectRepoTrap(cfg, d.repo, d.harness, now, failed);
      if (choice.action === 'reuse' || choice.action === 'wait') continue;
      if (listReservations().some((r) => r.repo === d.repo && !r.failedAt &&
        Date.parse(r.deadline) >= now && (!d.harness || r.harness === d.harness))) continue;
      // After exhausted candidates, wait for a real listener instead of making
      // a succession of new traps. A later dispatch can try starting again.
      if (choice.action === 'new' && failures.length) continue;
      running.add(key);
      let label = choice.action === 'return' ? trapLabel(choice.row) : `new ${d.repo} trap`;
      const trapId = choice.action === 'return' ? choice.row.trapId : undefined;
      // The async start reserves before its first await, so another group sees
      // that fence immediately. Its sign-on wait never holds the daemon tick.
      void (async () => {
        if (!queuedDescriptor(d.id, lane)) return; // A listener won before startup began.
        const opts = { ...options, cfg, onLaunch: (launch: { trap: string }) => { label = launch.trap; } };
        if (choice.action === 'return') await throwTrap({ ...opts, address: `wt:${choice.row.trapId}` });
        else await throwNew({ ...opts, repo: d.repo, harness: d.harness, reason: choice.why });
        log(`trap ${label}: listening for queued ${d.repo} work`);
      })().catch((error) => {
        const reason = error instanceof Error ? error.message : String(error);
        postNotice({ kind: 'trap-start-failed', repo: d.repo, refId: trapId ?? d.id,
          text: `trap ${label} failed to start for dispatch ${d.id}: ${reason}. Queued work can be taken by another suitable trap.`,
          dedupeKey: `dispatch-start-${d.id}-${trapId ?? 'new'}-${since}` });
        log(`trap ${label}: start failed; queued work remains eligible for other traps (${reason})`);
      }).finally(() => { running.delete(key); });
    }
  };
}

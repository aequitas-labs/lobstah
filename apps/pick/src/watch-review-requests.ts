import { randomUUID } from 'node:crypto';
import {
  builtinWatchRegistry,
  loadConfig,
  reviewAutomationCutoff,
  reviewDispatchIds,
  reviewWatchRevision,
  WatchAutomationRunner,
  WatchRuntime,
} from '@lobstah/core';
import { reconcileReviews } from './loops/reviews.js';
import type { WatchSourcePass } from '@lobstah/watch-types';
import type { PickupConfig } from './config.js';
import type { GhGraphql, ReviewReconciliationOptions } from './loops/reviews.js';

/** Review IO stays in a source effect with configuration authority and a recorded revision. */
export async function runReviewWatch(
  identity: string,
  token: () => string,
  log: (message: string) => void,
  options: ReviewReconciliationOptions,
): Promise<void> {
  const now = options.now ?? Date.now(),
    config = loadConfig();
  reviewAutomationCutoff(config.reviews, undefined, now);
  if (!config.reviews.enabled) return;
  const registry = builtinWatchRegistry({
    review: {
      automation: {
        propose() {
          return loadConfig().reviews.enabled
            ? [
                {
                  actionId: 'reconcile',
                  expectedRevision: reviewWatchRevision(),
                  idempotencyKey: randomUUID(),
                  authority: 'config:reviews.enabled',
                  arguments: { now },
                },
              ]
            : [];
        },
      },
      effectHandler: {
        execution: 'async',
        async execute(request) {
          if (request.actionId !== 'reconcile' || request.authorization.id !== 'config:reviews.enabled' || !loadConfig().reviews.enabled)
            throw new Error('Review automation authority is unavailable');
          if (request.expectedRevision !== reviewWatchRevision()) throw new Error('Review records changed; refresh before reconciling');
          const before = reviewDispatchIds();
          await reconcileReviews(identity, token, log, { ...options, now });
          return { workIds: [...reviewDispatchIds()].filter((id) => !before.has(id)) };
        },
      },
    },
  });
  const runtime = new WatchRuntime(registry),
    snapshot = runtime.register('review-requests', identity, {}, { kind: 'helm', grounds: 'home' });
  runtime.checkSync(snapshot.key, { now, everySecs: 0 });
  await new WatchAutomationRunner(registry, runtime.journal).run([snapshot.key], now, Number.MAX_SAFE_INTEGER, log);
  runtime.checkSync(snapshot.key, { now, everySecs: 0 });
}

/** The pickup composition root gets source labels and operations from the adapter module. */
export function reviewWatchPasses(settings: PickupConfig['reviews'], log: (message: string) => void, run?: GhGraphql): WatchSourcePass[] {
  return settings ? [{ label: 'reviews', run: () => runReviewWatch(settings.identity, settings.token, log, { run }) }] : [];
}

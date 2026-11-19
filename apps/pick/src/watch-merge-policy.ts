import { createHash, randomUUID } from 'node:crypto';
import { WatchAutomationRunner, WatchRuntime } from '@lobstah/core';
import { MergePolicyWatchType } from '@lobstah/watch-types/merge-policy';
import { WatchRegistry } from '@lobstah/watch-types';
import type { WatchSourcePass } from '@lobstah/watch-types';
import { reconcileMergePolicy } from './loops/merge.js';
import type { MergePolicy, MergeSource } from './types.js';
import type { PickupState } from './state.js';

/** Configuration grants the pass authority; the source still requires a fresh qualifying approval per PR. */
export async function runMergePolicyWatch(
  source: MergeSource,
  policy: MergePolicy,
  state: PickupState,
  log: (message: string) => void,
): Promise<void> {
  if (!policy.enabled) return;
  const revision = () => createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  const registry = new WatchRegistry(),
    adapter = new MergePolicyWatchType({
      revision,
      automation: {
        propose() {
          return policy.enabled
            ? [
                {
                  actionId: 'reconcile',
                  expectedRevision: revision(),
                  authority: `config:merge:${source.name}`,
                  idempotencyKey: randomUUID(),
                  arguments: null,
                },
              ]
            : [];
        },
      },
      effectHandler: {
        execution: 'async',
        async execute(request) {
          if (
            request.actionId !== 'reconcile' ||
            request.reference.name !== source.name ||
            request.authorization.id !== `config:merge:${source.name}` ||
            !policy.enabled ||
            request.expectedRevision !== revision()
          )
            throw new Error('Merge policy authority changed; refresh before advancing');
          await reconcileMergePolicy(source, policy, state, log);
          return { workIds: [] };
        },
      },
    });
  registry.register(adapter);
  const runtime = new WatchRuntime(registry),
    key = adapter.key({ name: source.name }),
    prior = runtime.journal.read(key),
    now = Date.now();
  if (!prior || prior.status === 'retired') runtime.register(adapter.descriptor.id, source.name, {}, { kind: 'helm', grounds: 'home' });
  await runtime.check(key, { now, everySecs: 0 });
  await new WatchAutomationRunner(registry, runtime.journal).run([key], now, Number.MAX_SAFE_INTEGER, log);
}

/** Pickup executes a generic list; this module supplies the configured source operations. */
export function mergeWatchPasses(
  merges: readonly { source: MergeSource; policy: MergePolicy }[],
  state: PickupState,
  log: (message: string) => void,
): WatchSourcePass[] {
  return merges.map(({ source, policy }) => ({
    label: `${source.name} merge`,
    run: () => runMergePolicyWatch(source, policy, state, log),
  }));
}

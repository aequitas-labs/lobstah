import type { WatchDispatchContext, WatchDispatchPlan, WatchValue, WatchRegistry } from '@lobstah/watch-types';
import { watchJson } from '@lobstah/watch-types';
import { WatchRuntime } from './watch-runtime.js';
import { readWatch } from './watch.js';
import type { Watch, WatchEvent } from './watch.js';
import { restoreCommandWatch, commandWatchRuntime } from './watch-command-runtime.js';

/** Typed and compatibility sources supply one delivery decision to every transport. */
function sourceContext(watch: Watch, events: readonly WatchEvent[], repo?: string, registry?: WatchRegistry) {
  const runtime = registry ? new WatchRuntime(registry) : commandWatchRuntime();
  if (watch.check && readWatch(watch.key)) restoreCommandWatch(watch, runtime);
  let snapshot = runtime.journal.read(watch.key);
  if (!snapshot) throw new Error(`Watch snapshot missing: ${watch.key}`);
  const source = runtime.registry.get(snapshot.type.id);
  const context: WatchDispatchContext<WatchValue, WatchValue, WatchValue, WatchValue> = {
    snapshot,
    now: new Date().toISOString(),
    ...(repo ? { repo } : {}),
    events: snapshot.events.filter((event) => events.some((pending) => String(pending.seq) === event.id)),
  };
  return { context, policy: source.dispatchPolicy };
}

/** Sources choose eligible event IDs; the generic transport owns the fork cap. */
export function planWatchDispatch(watch: Watch, events: readonly WatchEvent[], repo?: string, registry?: WatchRegistry): WatchDispatchPlan {
  const { context, policy } = sourceContext(watch, events, repo, registry);
  if (context.snapshot.status === 'retired') return { disposition: 'ignore', eventIds: [], notes: [] };
  const plan = policy?.plan(context) ?? { disposition: 'continue' as const, eventIds: context.events.map((event) => event.id), notes: [] };
  const known = new Set(context.events.map((event) => event.id));
  if (plan.eventIds.some((id) => !known.has(id))) throw new Error('Watch dispatch policy selected an unknown event');
  watchJson(plan);
  return plan;
}
export function prepareWatchBrief(
  watch: Watch,
  events: readonly WatchEvent[],
  filled: string,
  repo?: string,
  registry?: WatchRegistry,
): string {
  const { context, policy } = sourceContext(watch, events, repo, registry);
  return policy?.prepareBrief?.(context, filled) ?? filled;
}
export function completeWatchDispatch(
  watch: Watch,
  events: readonly WatchEvent[],
  plan: WatchDispatchPlan,
  workId: string,
  registry?: WatchRegistry,
): void {
  const { context, policy } = sourceContext(watch, events, undefined, registry);
  policy?.delivered?.(context, plan, workId);
}

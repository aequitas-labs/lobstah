import type { WatchOwner, WatchSnapshot, WatchRegistry, WatchRegistrationRequest, WatchRegistrationPlan } from '@lobstah/watch-types';
import { builtinWatchRegistry } from './watch-source-registry.js';
import { WatchRuntime } from './watch-runtime.js';

/** Binding selection is shared by explicit commands, reports and tool parks. */
export function registerWatchEvent(
  request: WatchRegistrationRequest,
  registry: WatchRegistry = builtinWatchRegistry(),
  typeId?: string,
): WatchSnapshot | undefined {
  const candidates = (typeId ? [registry.get(typeId)] : registry.list()).filter((source) =>
    source.bindings.some(
      (binding) =>
        binding.event === request.event &&
        typeof request.fields[binding.field] === 'string' &&
        (binding.pattern
          ? new RegExp(binding.pattern).test(request.fields[binding.field] as string)
          : request.event !== 'explicit' ||
            typeId !== undefined ||
            (request.fields[binding.field] as string).startsWith(`${source.descriptor.id}:`)),
    ),
  );
  const plans: Array<{ typeId: string; plan: WatchRegistrationPlan }> = [];
  for (const source of candidates) {
    const plan =
      source.registration?.prepare(request) ??
      (request.event === 'explicit' && !source.registration && typeof request.fields.key === 'string'
        ? { input: request.fields.key, options: request.options }
        : undefined);
    if (!plan) continue;
    if (source.identify(plan.input, plan.options)) plans.push({ typeId: source.descriptor.id, plan });
  }
  if (plans.length > 1) throw new Error('Several watch types recognize this reference; select one with --type');
  const selected = plans[0];
  if (!selected) return undefined;
  const snapshot = new WatchRuntime(registry).register(selected.typeId, selected.plan.input, selected.plan.options, request.owner);
  registry.get(selected.typeId).registration?.registered?.(request, snapshot);
  return snapshot;
}

/** Reconciliation executes source hooks independently, so one installation cannot stop the others. */
export function syncWatchRegistrations(
  registry: WatchRegistry,
  now: number,
  log: (message: string) => void,
  phase: 'before-observe' | 'after-observe' | 'report' = 'before-observe',
): void {
  for (const source of registry.list()) {
    try {
      source.registration?.sync?.(new Date(now).toISOString(), phase);
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
    }
  }
}

/** Register an installed adapter through its explicit binding. */
export function registerInstalledWatch(
  input: string,
  owner: WatchOwner,
  options: unknown = {},
  typeId?: string,
  registry: WatchRegistry = builtinWatchRegistry(),
  context: Pick<WatchRegistrationRequest, 'cwd' | 'cursor' | 'everySecs'> = {},
): WatchSnapshot | undefined {
  return registerWatchEvent(
    { event: 'explicit', fields: { key: input }, owner, options: options as WatchRegistrationRequest['options'], ...context },
    registry,
    typeId,
  );
}

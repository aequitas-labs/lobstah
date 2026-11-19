import type { WatchOwner, WatchSnapshot } from '@lobstah/watch-types';
import { builtinWatchRegistry } from './watch-source-registry.js';
import { WatchRuntime } from './watch-runtime.js';

/** Register an installed adapter through its explicit binding without a consumer-specific preset. */
export function registerInstalledWatch(
  input: string,
  owner: WatchOwner,
  options: unknown = {},
  typeId?: string,
): WatchSnapshot | undefined {
  const registry = builtinWatchRegistry();
  const candidates = typeId
    ? [registry.get(typeId)]
    : registry
        .list()
        .filter((source) =>
          source.bindings.some(
            (binding) =>
              binding.event === 'explicit' &&
              (binding.pattern ? new RegExp(binding.pattern).test(input) : input.startsWith(`${source.descriptor.id}:`)),
          ),
        );
  const recognized = candidates.filter((source) => source.identify(input, options));
  if (recognized.length > 1) throw new Error('Several watch types recognize this reference; select one with --type');
  if (!recognized.length) return undefined;
  return new WatchRuntime(registry).register(recognized[0]!.descriptor.id, input, options, owner);
}

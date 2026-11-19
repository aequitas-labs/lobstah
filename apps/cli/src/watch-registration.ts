import type { WatchCommandRequest, WatchRegistry } from '@lobstah/watch-types';
import { journalWatchViews, readWatch, registerInstalledWatch, WatchJournal } from '@lobstah/core';
import type { Watch } from '@lobstah/core';
import type { PrRecord } from '@lobstah/core';
import { createCliWatchRegistry } from './watch-automation.js';

/** Every CLI registration honors the installed source, including replacements for shipped types. */
export function addCliWatch(
  input: string,
  options: { forId?: string; everySecs?: number; cursor?: string; cwd?: string; options?: Record<string, unknown> } = {},
): Watch {
  const previous = readWatch(input);
  const stored = new WatchJournal().read(input);
  const priorOwner =
    (stored?.status !== 'retired' ? stored?.owner : undefined) ??
    (previous
      ? {
          grounds: previous.grounds ?? 'home',
          ...(previous.owner.startsWith('dispatch:')
            ? { kind: 'dispatch' as const, chainId: previous.owner.slice(9) }
            : previous.owner.startsWith('trap:')
              ? { kind: 'trap' as const, trapId: previous.owner.slice(5) }
              : { kind: 'helm' as const }),
        }
      : undefined);
  const snapshot = registerInstalledWatch(
    input,
    options.forId ? { kind: 'dispatch', chainId: options.forId, grounds: 'home' } : (priorOwner ?? { kind: 'helm', grounds: 'home' }),
    options.options ?? {},
    undefined,
    createCliWatchRegistry(() => {}),
    { everySecs: options.everySecs, cursor: options.cursor, cwd: options.cwd },
  );
  if (!snapshot) throw new Error(`No installed watch type recognizes ${input}.`);
  return readWatch(snapshot.key) ?? journalWatchViews().find((view) => view.watch.key === snapshot.key)!.watch;
}

/** Source-owned compatibility commands are selected from the same installed registry. */
export function runCliWatchCommand(
  request: WatchCommandRequest,
  registry: WatchRegistry = createCliWatchRegistry(() => {}),
): string | Promise<string> | undefined {
  const matches = registry
    .list()
    .filter((source) =>
      source.commands?.bindings.some(
        (binding) => binding.name === request.name && (!binding.pattern || new RegExp(binding.pattern).test(request.args[0] ?? '')),
      ),
    );
  if (matches.length > 1) throw new Error('Several watch types handle this command.');
  return matches[0]?.commands?.run(request);
}

/** Synchronous source projections use the same declared command bindings as the CLI. */
export function queryCliWatch<T>(name: string, input: unknown, fallback: T, registry?: WatchRegistry): T {
  const output = runCliWatchCommand({ name, args: [JSON.stringify(input)], flags: {} }, registry);
  if (output instanceof Promise) throw new Error(`Watch query ${name} must be synchronous.`);
  return output === undefined ? fallback : ((JSON.parse(output) as T | null) ?? fallback);
}

export function requireCliWatch<T>(name: string, input: unknown): T {
  const result = queryCliWatch<T | undefined>(name, input, undefined);
  if (result === undefined) throw new Error('No installed watch type handles this request.');
  return result;
}

/** Async compatibility operations retain the installed adapter's authority and result. */
export async function invokeCliWatch<T>(name: string, input: unknown, fallback: T): Promise<T> {
  const output = await runCliWatchCommand({ name, args: [JSON.stringify(input)], flags: {} });
  return output === undefined ? fallback : ((JSON.parse(output) as T | null) ?? fallback);
}

/** Reports notify every declaring source; a failed hook must not undo a recorded status. */
export async function recordCliWatchReport(input: unknown): Promise<{ fields: Record<string, string>; warnings: string[] }> {
  const result = { fields: {} as Record<string, string>, warnings: [] as string[] };
  for (const source of createCliWatchRegistry(() => {}).list()) {
    if (!source.commands?.bindings.some((binding) => binding.name === 'report.record')) continue;
    try {
      const output = JSON.parse(
        await source.commands.run({ name: 'report.record', args: [JSON.stringify(input)], flags: {} }),
      ) as typeof result;
      Object.assign(result.fields, output.fields);
      result.warnings.push(...output.warnings);
    } catch (error) {
      result.warnings.push(`${source.descriptor.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

/** Compatibility fields in the daemon and glass remain stable across source installations. */
export interface SourceRepairChore {
  id: string;
  pr: string;
  title?: string;
  lane: 'chore';
  state: 'queued' | 'active';
  worker: string;
  waitingForTrap: boolean;
  until?: string;
}
export interface SourceDiagnostics {
  live: { at: string; process: string; pid: number } | null;
  chores: SourceRepairChore[];
  waiting: PrRecord[];
}
export function watchDiagnostics(now = Date.now()): SourceDiagnostics {
  return queryCliWatch('repair.health', { now }, { live: null, chores: [], waiting: [] });
}

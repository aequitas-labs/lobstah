import { addWatch } from '@lobstah/core';
import type { Watch } from '@lobstah/core';
import type { WatchRegistrationPlan, WatchRegistrationRequest, WatchSnapshot, WatchValue } from '@lobstah/watch-types';

/** A compatibility registration keeps its command and captured context in the native journal. */
export function legacyRegistration(watch: Watch, overrides: WatchValue = {}): WatchRegistrationPlan {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Watch options must be an object.');
  return {
    input: watch.key,
    options: {
      check: watch.check,
      cursor: watch.cursor,
      ...(watch.brief ? { brief: watch.brief } : {}),
      ...(watch.context?.cwd ? { cwd: watch.context.cwd } : {}),
      ...(watch.context?.env ? { environment: watch.context.env } : {}),
      legacy: JSON.parse(JSON.stringify(watch)),
      ...overrides,
    },
  };
}

/** Publish the compatibility port only after the registry validates identity and ownership. */
export function registerLegacyWatch(request: WatchRegistrationRequest, snapshot: WatchSnapshot): void {
  const options = snapshot.options as unknown as {
    check: string;
    cursor?: string;
    brief?: string;
    cwd?: string;
    environment?: Record<string, string>;
    org?: string;
    legacy?: Watch;
  };
  const cadence = request.everySecs;
  addWatch(snapshot.key, options.check, {
    typeId: snapshot.type.id,
    owner:
      snapshot.owner.kind === 'dispatch'
        ? `dispatch:${snapshot.owner.chainId}`
        : snapshot.owner.kind === 'trap'
          ? `trap:${snapshot.owner.trapId}`
          : 'man',
    grounds: snapshot.owner.grounds,
    cursor: options.cursor,
    brief: options.brief,
    everySecs: cadence,
    context: options.legacy?.context ?? { cwd: options.cwd, env: options.environment, org: options.org },
  });
}

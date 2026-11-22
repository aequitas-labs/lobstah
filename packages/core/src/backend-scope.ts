import type { Config } from './config.js';
import type { BackendLocation } from './backend-model.js';
import { displayGrounds, storageGrounds } from './grounds-name.js';
/** Routing/display names; local file writers use resolveGrounds' storage identity instead. */
export type BackendScope = { grounds: string; repos: string[] } & (
  { kind: 'local'; wharf?: never; location?: never } |
  { kind: 'wharf'; wharf: string; location: BackendLocation }
);
export function backendScopes(config: Pick<Config, 'grounds' | 'wharves' | 'repos'>): BackendScope[] {
  const explicit = Object.entries(config.grounds);
  if (!explicit.length) return [{ kind: 'local', grounds: displayGrounds(storageGrounds('home', config), config), repos: Object.keys(config.repos) }];
  return explicit.map(([grounds, g]) => {
    if (!g.wharf) return { kind: 'local', grounds, repos: g.repos };
    const location = config.wharves?.[g.wharf];
    if (!location) throw new Error(`grounds ${grounds}: unknown wharf ${g.wharf}`);
    return { kind: 'wharf', grounds, repos: g.repos, wharf: g.wharf, location };
  });
}
/**
 * The grounds whose standing cards reach a wharf, each with the wharf they
 * go to: a wharf grounds goes to its own wharf, and a local grounds to the
 * wharf `[glass] mirror` names, under the mirror's one boat credential. A
 * local grounds with no mirror has none. Only cards and their answers use
 * this: a mirrored grounds' work stays local.
 */
export function cardScopes(config: Pick<Config, 'grounds' | 'wharves' | 'repos' | 'glass'>): Array<Extract<BackendScope, { kind: 'wharf' }>> {
  const mirror = config.glass?.mirror, location = mirror ? config.wharves?.[mirror] : undefined;
  return backendScopes(config).flatMap((s) => s.kind === 'wharf' ? [s] : location ? [{ kind: 'wharf' as const, grounds: s.grounds, repos: s.repos, wharf: mirror!, location }] : []);
}
export function backendScope(config: Pick<Config, 'grounds' | 'wharves' | 'repos'>, grounds = 'home'): BackendScope {
  const scopes = backendScopes(config); const scope = scopes.find((s) => s.grounds === displayGrounds(storageGrounds(grounds, config), config));
  if (!scope) throw new Error(`unknown grounds ${grounds}; choose ${scopes.map((s) => displayGrounds(s.grounds, config)).join(', ')}`);
  return scope;
}
/** A failed wharf is a result for that grounds, never a global failure. */
export async function eachBackend<T>(scopes: BackendScope[], read: (scope: BackendScope) => Promise<T>): Promise<Array<{
  scope: BackendScope; value?: T; unavailable?: string;
}>> {
  return Promise.all(scopes.map(async (scope) => {
    try { return { scope, value: await read(scope) }; }
    catch { return { scope, unavailable: 'backend unavailable; state unknown' }; }
  }));
}

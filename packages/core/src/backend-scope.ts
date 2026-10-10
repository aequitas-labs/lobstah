import type { Config } from './config.js';
import type { BackendLocation } from './backend-model.js';
export type BackendScope = { grounds: string; repos: string[] } & (
  { kind: 'local'; server?: never; location?: never } |
  { kind: 'server'; server: string; location: BackendLocation }
);
export function backendScopes(config: Pick<Config, 'grounds' | 'servers' | 'repos'>): BackendScope[] {
  const explicit = Object.entries(config.grounds);
  if (!explicit.length) return [{ kind: 'local', grounds: 'all', repos: Object.keys(config.repos) }];
  return explicit.map(([grounds, g]) => {
    if (!g.server) return { kind: 'local', grounds, repos: g.repos };
    const location = config.servers?.[g.server];
    if (!location) throw new Error(`grounds ${grounds}: unknown server ${g.server}`);
    return { kind: 'server', grounds, repos: g.repos, server: g.server, location };
  });
}
export function backendScope(config: Pick<Config, 'grounds' | 'servers' | 'repos'>, grounds = 'all'): BackendScope {
  const scopes = backendScopes(config); const scope = scopes.find((s) => s.grounds === grounds);
  if (!scope) throw new Error(`unknown grounds ${grounds}; choose ${scopes.map((s) => s.grounds).join(', ')}`);
  return scope;
}
/** A failed server is a result for that grounds, never a global failure. */
export async function eachBackend<T>(scopes: BackendScope[], read: (scope: BackendScope) => Promise<T>): Promise<Array<{
  scope: BackendScope; value?: T; unavailable?: string;
}>> {
  return Promise.all(scopes.map(async (scope) => {
    try { return { scope, value: await read(scope) }; }
    catch { return { scope, unavailable: 'backend unavailable; state unknown' }; }
  }));
}

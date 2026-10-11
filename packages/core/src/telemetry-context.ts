import { backendScopes } from './backend-scope.js';
import type { Config } from './config.js';
import { readHostedViews, DOCUMENTS_EVERY_MS } from './hosted-cache.js';
import { groundsBucket, usageBucket, safeAccess } from './telemetry-usage.js';
import type { BoatAccess, GroundsBucket, UsageBucket } from './telemetry-usage.js';

/** Chris's project-owned CLI/boat origin. Never serialized; exact origin equality only. */
export const HOSTED_WHARF_ORIGINS: readonly string[] = ['https://api.lobstah.dev'];
export function isHostedWharf(url: string): boolean {
  try { return HOSTED_WHARF_ORIGINS.includes(new URL(url).origin); } catch { return false; }
}
export interface TelemetryContext {
  grounds: { total: GroundsBucket; local: GroundsBucket; wharf: GroundsBucket };
  wharf: 'none' | 'hosted' | 'self-hosted' | 'both';
  boats: Exclude<UsageBucket, '0'> | null;
  boatAccess: BoatAccess;
  /** Internal current-seat facts, not identifiers or a payload object. */
  remoteHelms: number;
  remoteHelmsUnknown: boolean;
}
/** Read local snapshots only. A telemetry send never contacts a wharf. */
export function telemetryContext(config: Config, now: number): TelemetryContext {
  const scopes = backendScopes(config), remote = scopes.filter((s) => s.kind === 'wharf'), views = readHostedViews(config, now);
  const accounts = new Map(remote.map((s) => [JSON.stringify([new URL(s.location.url).origin, s.location.account]), s]));
  const facts = [...accounts.values()].map((s) => {
    const v = views.find((r) => r.url === s.location.url && r.account === s.location.account)?.usage;
    const age = now - Date.parse(v?.observedAt ?? '');
    return v && age >= 0 && age < DOCUMENTS_EVERY_MS * 2 ? v : undefined;
  });
  const hosted = remote.some((s) => isHostedWharf(s.location.url)), self = remote.some((s) => !isHostedWharf(s.location.url));
  const access = facts.map((f) => safeAccess(f?.boatAccess));
  const flag = (k: keyof BoatAccess) => access.some((f) => f[k] === true) ? true : access.some((f) => f[k] === null) ? null : false;
  // Per person, but several wharves/accounts can be configured. Report the
  // largest visible account roster, not a sum that double-counts the same boats.
  const boats = remote.length === 0 ? '1' : facts.some((f) => !f || f.boats === null || !Number.isSafeInteger(f.boats) || f.boats < 1) ? null
    : usageBucket(Math.max(1, ...facts.map((f) => f!.boats!))) as Exclude<UsageBucket, '0'>;
  return { grounds: { total: groundsBucket(scopes.length), local: groundsBucket(scopes.length - remote.length), wharf: groundsBucket(remote.length) },
    wharf: hosted && self ? 'both' : hosted ? 'hosted' : self ? 'self-hosted' : 'none', boats,
    boatAccess: { work: flag('work'), read: flag('read'), helm: flag('helm') },
    remoteHelms: facts.filter((f) => f?.helmLive === true).length,
    remoteHelmsUnknown: facts.some((f) => typeof f?.helmLive !== 'boolean'),
  };
}

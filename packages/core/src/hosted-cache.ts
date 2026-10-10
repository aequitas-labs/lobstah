import * as fs from 'node:fs';
import * as path from 'node:path';
import { lobstahHome, uniqueTempPath } from './paths.js';
import type { BackendScope } from './backend-scope.js';
import { backendScopes, eachBackend } from './backend-scope.js';
import type { Config } from './config.js';
import type { DispatchView } from './backend-model.js';
import { WharfBackend } from './wharf-backend.js';
export interface HostedView { grounds: string; wharf: string; url: string; account: string; observedAt: string; checkedAt?: string; dispatches: DispatchView[]; unavailable?: string }
function cachePath() { return path.join(lobstahHome(), 'hosted-snapshots.json'); }
export function readHostedViews(config: Config, now = Date.now()): HostedView[] {
  let rows: HostedView[];
  try { rows = JSON.parse(fs.readFileSync(cachePath(), 'utf8')); } catch { rows = []; }
  return backendScopes(config).filter((s) => s.kind === 'wharf').map((s) => {
    const cached = rows.find((r) => r.grounds === s.grounds && r.wharf === s.wharf && r.url === s.location?.url && r.account === s.location?.account);
    return cached && now - Date.parse(cached.checkedAt ?? cached.observedAt) < 30_000 ? cached : {
      grounds: s.grounds, wharf: s.wharf!, url: s.location!.url, account: s.location!.account, observedAt: cached?.observedAt ?? '', dispatches: cached?.dispatches ?? [], unavailable: 'wharf unavailable; state unknown',
    };
  });
}
export function wharfFor(scope: BackendScope, options: { session?: string; worker?: string; fetch?: typeof fetch } = {}): WharfBackend {
  if (scope.kind !== 'wharf') throw new Error('this grounds uses local files');
  return new WharfBackend(scope.location, process.env[scope.location.tokenEnv] ?? '', options);
}
/** The local daemon's existing cadence drives independent remote snapshots. */
export async function refreshHostedViews(config: Config): Promise<void> {
  const rows = await eachBackend(backendScopes(config).filter((s) => s.kind === 'wharf'), async (s) => (await wharfFor(s).list()).filter((d) => s.repos.includes(d.repo)));
  const old = readHostedViews(config);
  const views = rows.map(({ scope, value, unavailable }) => ({ grounds: scope.grounds, wharf: scope.wharf!, url: scope.location!.url, account: scope.location!.account,
    checkedAt: new Date().toISOString(), observedAt: value ? new Date().toISOString() : old.find((v) => v.grounds === scope.grounds)?.observedAt ?? '',
    dispatches: value ?? old.find((v) => v.grounds === scope.grounds)?.dispatches ?? [], ...(unavailable ? { unavailable } : {}) }));
  if (!rows.length) return;
  const file = cachePath(); const tmp = uniqueTempPath(file); fs.writeFileSync(tmp, JSON.stringify(views)); fs.renameSync(tmp, file);
}
/** Only the dispatch capability is handed to an agent subprocess. */
export function agentEnvironment(config: Config, scope: BackendScope, token: string, base = process.env): NodeJS.ProcessEnv {
  const env = { ...base }; for (const s of Object.values(config.wharves ?? {})) delete env[s.tokenEnv];
  if (scope.kind !== 'wharf' || !token.startsWith(`d.${scope.location.account}.`)) throw new Error('dispatch token required');
  env[scope.location.tokenEnv] = token; env.LOBSTAH_GROUNDS = scope.grounds; return env;
}

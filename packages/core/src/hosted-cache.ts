import * as fs from 'node:fs';
import * as path from 'node:path';
import { lobstahHome, uniqueTempPath } from './paths.js';
import type { BackendScope } from './backend-scope.js';
import { backendScopes, eachBackend } from './backend-scope.js';
import type { Config } from './config.js';
import type { DispatchView, WharfDocumentSummary } from './backend-model.js';
import { BackendError, WharfBackend } from './wharf-backend.js';
import { wharfCredential } from './wharf-credentials.js';
export interface HostedView {
  grounds: string; wharf: string; url: string; account: string; observedAt: string; checkedAt?: string; dispatches: DispatchView[]; unavailable?: string;
  /** The wharf's glass origin, as its last answer named it. Absent until one did (an older wharf never does). */
  glass?: string;
  /**
   * The account's published decisions and reports that this grounds may show,
   * as last read, and when. Read on the daemon's existing poll, but no more
   * often than DOCUMENTS_EVERY_MS: they change far less than job status, and
   * every read spends the account's shared request budget.
   */
  documents?: WharfDocumentSummary[];
  documentsAt?: string;
}
export const DOCUMENTS_EVERY_MS = 30_000;
function cachePath() { return path.join(lobstahHome(), 'hosted-snapshots.json'); }
export function readHostedViews(config: Config, now = Date.now()): HostedView[] {
  let rows: HostedView[];
  try { rows = JSON.parse(fs.readFileSync(cachePath(), 'utf8')); } catch { rows = []; }
  return backendScopes(config).filter((s) => s.kind === 'wharf').map((s) => {
    const cached = rows.find((r) => r.grounds === s.grounds && r.wharf === s.wharf && r.url === s.location?.url && r.account === s.location?.account);
    return cached && now - Date.parse(cached.checkedAt ?? cached.observedAt) < 30_000 ? cached : {
      grounds: s.grounds, wharf: s.wharf!, url: s.location!.url, account: s.location!.account, observedAt: cached?.observedAt ?? '', dispatches: cached?.dispatches ?? [], unavailable: 'wharf unavailable; state unknown',
      ...(cached?.glass ? { glass: cached.glass } : {}),
      ...(cached?.documents ? { documents: cached.documents, documentsAt: cached.documentsAt } : {}),
    };
  });
}
export function wharfFor(scope: BackendScope, options: { session?: string; worker?: string; fetch?: typeof fetch } = {}): WharfBackend {
  if (scope.kind !== 'wharf') throw new Error('this grounds uses local files');
  return new WharfBackend(scope.location, wharfCredential(scope), options);
}
/** The local daemon's existing cadence drives independent remote snapshots. */
export async function refreshHostedViews(config: Config): Promise<void> {
  const old = readHostedViews(config);
  const rows = await eachBackend(backendScopes(config).filter((s) => s.kind === 'wharf'), async (s) => {
    const wharf = wharfFor(s); const listed = await wharf.list(); const dispatches = listed.filter((d) => s.repos.includes(d.repo));
    const readAt = Date.parse(old.find((v) => v.grounds === s.grounds)?.documentsAt ?? '');
    if (Date.now() - readAt < DOCUMENTS_EVERY_MS) return { dispatches, glass: wharf.glass };
    let documents: WharfDocumentSummary[];
    // A wharf from before documents has no such route: it has none to show, and its jobs still read.
    try { documents = await wharf.documents(); }
    catch (error) { if (!(error instanceof BackendError) || error.status !== 404) throw error; documents = []; }
    // A document about a job of another grounds' repo is that grounds' to show.
    const here = new Set(dispatches.map((d) => d.id)), elsewhere = new Set(listed.filter((d) => !here.has(d.id)).map((d) => d.id));
    return { dispatches, glass: wharf.glass, documents: documents.filter((d) => !d.dispatch || !elsewhere.has(d.dispatch)) };
  });
  const views = rows.map(({ scope, value, unavailable }): HostedView => {
    const before = old.find((v) => v.grounds === scope.grounds);
    // An answer that names no glass keeps the last one named: the address outlives one bad read.
    const glass = value?.glass ?? before?.glass;
    return { grounds: scope.grounds, wharf: scope.wharf!, url: scope.location!.url, account: scope.location!.account,
      checkedAt: new Date().toISOString(), observedAt: value ? new Date().toISOString() : before?.observedAt ?? '',
      dispatches: value?.dispatches ?? before?.dispatches ?? [], ...(unavailable ? { unavailable } : {}), ...(glass ? { glass } : {}),
      ...(value?.documents ? { documents: value.documents, documentsAt: new Date().toISOString() }
        : before?.documents ? { documents: before.documents, documentsAt: before.documentsAt } : {}) };
  });
  if (!rows.length) return;
  const file = cachePath(); const tmp = uniqueTempPath(file); fs.writeFileSync(tmp, JSON.stringify(views)); fs.renameSync(tmp, file);
}
/** Only the dispatch capability is handed to an agent subprocess. */
export function agentEnvironment(config: Config, scope: BackendScope, token: string, base = process.env): NodeJS.ProcessEnv {
  const env = { ...base }; for (const s of Object.values(config.wharves ?? {})) delete env[s.tokenEnv];
  if (scope.kind !== 'wharf' || !token.startsWith(`d.${scope.location.account}.`)) throw new Error('dispatch token required');
  env[scope.location.tokenEnv] = token; env.LOBSTAH_GROUNDS = scope.grounds; env.LOBSTAH_WHARF_AGENT = '1'; return env;
}

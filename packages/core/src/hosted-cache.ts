import * as fs from 'node:fs';
import * as path from 'node:path';
import { lobstahHome, uniqueTempPath } from './paths.js';
import type { BackendScope } from './backend-scope.js';
import { backendScopes, eachBackend } from './backend-scope.js';
import type { Config } from './config.js';
import type { DispatchView, WharfAck, WharfDocumentSummary } from './backend-model.js';
import { BackendError, WharfBackend } from './wharf-backend.js';
import { wharfCredential } from './wharf-credentials.js';
import { accessFlags, UNKNOWN_ACCESS } from './telemetry-usage.js';
import type { BoatAccess } from './telemetry-usage.js';
export interface WharfUsageSnapshot { boats: number | null; boatAccess: BoatAccess; helmLive: boolean | null; observedAt: string }
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
  /** Coarse facts from existing boat/glass reads. No telemetry install ID is available to those requests. */
  usage?: WharfUsageSnapshot;
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
      ...(cached?.usage ? { usage: cached.usage } : {}),
    };
  });
}
export function wharfFor(scope: BackendScope, options: { session?: string; worker?: string; fetch?: typeof fetch } = {}): WharfBackend {
  if (scope.kind !== 'wharf') throw new Error('this grounds uses local files');
  return new WharfBackend(scope.location, wharfCredential(scope), options);
}
/** The local daemon's existing cadence drives independent remote snapshots. */
export async function refreshHostedViews(config: Config): Promise<void> {
  const known = readHostedViews(config);
  const usageReads = new Map<string, Promise<WharfUsageSnapshot | undefined>>();
  const usage = (scope: BackendScope): Promise<WharfUsageSnapshot | undefined> => {
    const key = JSON.stringify(scope.location), prior = known.find((v) => v.url === scope.location?.url && v.account === scope.location?.account)?.usage;
    if (prior && Date.now() - Date.parse(prior.observedAt) < DOCUMENTS_EVERY_MS) return Promise.resolve(prior);
    if (!usageReads.has(key)) usageReads.set(key, readWharfUsage(wharfFor(scope)));
    return usageReads.get(key)!;
  };
  const usageRows = await Promise.all(backendScopes(config).filter((s) => s.kind === 'wharf').map(async (s) => ({ grounds: s.grounds, value: await usage(s) })));
  const rows = await eachBackend(backendScopes(config).filter((s) => s.kind === 'wharf'), async (s) => {
    const wharf = wharfFor(s); const listed = await wharf.list(); const dispatches = listed.filter((d) => s.repos.includes(d.repo));
    const readAt = Date.parse(known.find((v) => v.grounds === s.grounds)?.documentsAt ?? '');
    if (Date.now() - readAt < DOCUMENTS_EVERY_MS) return { dispatches, glass: wharf.glass };
    let documents: WharfDocumentSummary[];
    // A wharf from before documents has no such route: it has none to show, and its jobs still read.
    try { documents = await wharf.documents(); }
    catch (error) { if (!(error instanceof BackendError) || error.status !== 404) throw error; documents = []; }
    // A document about a job of another grounds' repo is that grounds' to show.
    const here = new Set(dispatches.map((d) => d.id)), elsewhere = new Set(listed.filter((d) => !here.has(d.id)).map((d) => d.id));
    return { dispatches, glass: wharf.glass, documents: documents.filter((d) => !d.dispatch || !elsewhere.has(d.dispatch)) };
  });
  // Read again now: an ack this boat recorded while the wharf was answering is in the cache, not in that answer.
  const old = readHostedViews(config);
  const views = rows.map(({ scope, value, unavailable }): HostedView => {
    const before = old.find((v) => v.grounds === scope.grounds);
    const jobAck = (d: DispatchView) => before?.dispatches.find((x) => x.id === d.id)?.ack;
    const dispatches = value?.dispatches.map((d) => (!d.ack && jobAck(d)?.status === d.status?.at ? { ...d, ack: jobAck(d) } : d));
    const documents = value?.documents?.map((d) => { const was = before?.documents?.find((x) => x.id === d.id)?.ack; return !d.ack && was ? { ...d, ack: was } : d; });
    // An answer that names no glass keeps the last one named: the address outlives one bad read.
    const glass = value?.glass ?? before?.glass;
    return { grounds: scope.grounds, wharf: scope.wharf!, url: scope.location!.url, account: scope.location!.account,
      checkedAt: new Date().toISOString(), observedAt: value ? new Date().toISOString() : before?.observedAt ?? '',
      dispatches: dispatches ?? before?.dispatches ?? [], ...(unavailable ? { unavailable } : {}), ...(glass ? { glass } : {}),
      usage: usageRows.find((r) => r.grounds === scope.grounds)?.value,
      ...(documents ? { documents, documentsAt: new Date().toISOString() }
        : before?.documents ? { documents: before.documents, documentsAt: before.documentsAt } : {}) };
  });
  if (!rows.length) return;
  writeCache(views);
}
/** Existing routes only. Work-only boats can read their grants, not the roster or helm seat. */
async function readWharfUsage(wharf: WharfBackend): Promise<WharfUsageSnapshot> {
  const unknown = (): WharfUsageSnapshot => ({ boats: null, boatAccess: { ...UNKNOWN_ACCESS }, helmLive: null, observedAt: new Date().toISOString() });
  try {
    const own = await wharf.request('_boat') as { permissions?: unknown };
    if (!Array.isArray(own.permissions) || own.permissions.some((p) => !['work', 'read', 'helm', 'admin'].includes(p))) return unknown();
    const boatAccess = accessFlags(own.permissions);
    let boats: number | null = null, helmLive: boolean | null = null;
    if (boatAccess.read) {
      try {
        const glass = await wharf.request('glass') as { boats?: unknown; helmLive?: unknown };
        if (Array.isArray(glass.boats) && glass.boats.length <= 100) boats = Math.max(1, glass.boats.filter((b) => b && typeof b === 'object' && b.revoked === 0).length);
        if (typeof glass.helmLive === 'boolean') helmLive = glass.helmLive;
      } catch { /* No read, old wharf, or unavailable: unknown. */ }
    }
    return { boats, boatAccess, helmLive, observedAt: new Date().toISOString() };
  } catch { return unknown(); } // Cache a failed attempt too; retry only on the normal cadence.
}
function writeCache(views: HostedView[]) {
  const file = cachePath(); const tmp = uniqueTempPath(file); fs.writeFileSync(tmp, JSON.stringify(views)); fs.renameSync(tmp, file);
}
/**
 * The wharf accepted an ack from this boat: show it now, without waiting for
 * the next read of that wharf. Only the cached item gains its ack; the wharf
 * stays the record.
 */
export function recordHostedAck(view: Pick<HostedView, 'grounds' | 'wharf' | 'url' | 'account'>, item: { document: string; ack: WharfAck } | { dispatch: string; ack: WharfAck & { status: string } }): void {
  let rows: HostedView[];
  try { rows = JSON.parse(fs.readFileSync(cachePath(), 'utf8')); } catch { return; }
  // Every grounds on that wharf account reads the same documents and jobs.
  for (const row of rows.filter((r) => r.url === view.url && r.account === view.account)) {
    if ('document' in item) row.documents = row.documents?.map((d) => (d.id === item.document && !d.ack ? { ...d, ack: item.ack } : d));
    else row.dispatches = row.dispatches.map((d) => (d.id === item.dispatch && d.status?.at === item.ack.status ? { ...d, ack: item.ack } : d));
  }
  writeCache(rows);
}
/** Only the dispatch capability is handed to an agent subprocess. */
export function agentEnvironment(config: Config, scope: BackendScope, token: string, base = process.env): NodeJS.ProcessEnv {
  const env = { ...base }; for (const s of Object.values(config.wharves ?? {})) delete env[s.tokenEnv];
  if (scope.kind !== 'wharf' || !token.startsWith(`d.${scope.location.account}.`)) throw new Error('dispatch token required');
  env[scope.location.tokenEnv] = token; env.LOBSTAH_GROUNDS = scope.grounds; env.LOBSTAH_WHARF_AGENT = '1'; return env;
}

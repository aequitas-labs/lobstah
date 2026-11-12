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
/** How often a daemon on the wharf's socket reads the coarse usage facts: they change with the roster and the helm seat, never per job. */
export const USAGE_EVERY_MS = 3_600_000;
/**
 * The daemon's say over one refresh, from what its socket to each wharf
 * heard: which parts of a grounds' view to read now, and whether its socket
 * is open (a view on an open socket stays current with no read).
 */
export interface HostedRefresh {
  due: (scope: BackendScope, part: 'dispatches' | 'documents' | 'usage') => boolean;
  live: (scope: BackendScope) => boolean;
  /** Read one route, on the socket when it is open: the usage reads, so an idle boat sends no HTTP. */
  read?: (scope: BackendScope, path: string) => Promise<unknown>;
}
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
/**
 * Read each wharf grounds' jobs, documents and usage into the cache the
 * glass and `ls` show. A one-shot command reads everything (documents and
 * usage at most every DOCUMENTS_EVERY_MS). The daemon passes `refresh`: it
 * reads only the parts its socket says changed, and a grounds whose socket
 * is open and heard nothing is marked checked with no request.
 */
export async function refreshHostedViews(config: Config, refresh?: HostedRefresh): Promise<void> {
  const known = readHostedViews(config);
  const scopes = backendScopes(config).filter((s) => s.kind === 'wharf');
  const usageReads = new Map<string, Promise<WharfUsageSnapshot | undefined>>();
  const usage = (scope: BackendScope): Promise<WharfUsageSnapshot | undefined> => {
    const key = JSON.stringify(scope.location), prior = known.find((v) => v.url === scope.location?.url && v.account === scope.location?.account)?.usage;
    const fresh = refresh ? !refresh.due(scope, 'usage') : Date.now() - Date.parse(prior?.observedAt ?? '') < DOCUMENTS_EVERY_MS;
    if (prior && fresh) return Promise.resolve(prior);
    const wharf = wharfFor(scope);
    if (!usageReads.has(key)) usageReads.set(key, readWharfUsage(refresh?.read ? (path) => refresh.read!(scope, path) : (path) => wharf.request(path)));
    return usageReads.get(key)!;
  };
  const usageRows = await Promise.all(scopes.map(async (s) => ({ grounds: s.grounds, value: await usage(s) })));
  // Asked once per grounds: asking marks a part read.
  const parts = new Map(scopes.map((s) => [s.grounds, refresh ? { dispatches: refresh.due(s, 'dispatches'), documents: refresh.due(s, 'documents') } : undefined]));
  const quiet = (s: BackendScope) => { const p = parts.get(s.grounds); return !!p && !p.dispatches && !p.documents; };
  const rows = await eachBackend(scopes.filter((s) => !quiet(s)), async (s) => {
    const wharf = wharfFor(s); const listed = await wharf.list(); const dispatches = listed.filter((d) => (d.target ? d.target.grounds === s.grounds : !!d.repo && s.repos.includes(d.repo)));
    const readAt = Date.parse(known.find((v) => v.grounds === s.grounds)?.documentsAt ?? '');
    // Never read (NaN) is due too.
    const documentsDue = parts.get(s.grounds)?.documents ?? !(Date.now() - readAt < DOCUMENTS_EVERY_MS);
    if (!documentsDue) return { dispatches, glass: wharf.glass };
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
  const kept = scopes.filter(quiet).map((scope): HostedView | undefined => {
    const before = old.find((v) => v.grounds === scope.grounds);
    if (!before?.observedAt) return undefined;
    // Nothing changed on an open socket: the view is current as it stands. With the socket down it ages, as an unread one does.
    const { unavailable: _unavailable, ...view } = before;
    return { ...view, ...(refresh!.live(scope) ? { checkedAt: new Date().toISOString() } : {}),
      usage: usageRows.find((r) => r.grounds === scope.grounds)?.value ?? before.usage };
  }).filter((v): v is HostedView => !!v);
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
  if (!rows.length && !kept.length) return;
  writeCache([...views, ...kept]);
}
/** Existing routes only. Work-only boats can read their grants, not the roster or helm seat. */
async function readWharfUsage(read: (path: string) => Promise<unknown>): Promise<WharfUsageSnapshot> {
  const unknown = (): WharfUsageSnapshot => ({ boats: null, boatAccess: { ...UNKNOWN_ACCESS }, helmLive: null, observedAt: new Date().toISOString() });
  try {
    const own = await read('_boat') as { permissions?: unknown };
    if (!Array.isArray(own.permissions) || own.permissions.some((p) => !['work', 'read', 'helm', 'admin'].includes(p))) return unknown();
    const boatAccess = accessFlags(own.permissions);
    let boats: number | null = null, helmLive: boolean | null = null;
    if (boatAccess.read) {
      try {
        const glass = await read('glass') as { boats?: unknown; helmLive?: unknown };
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

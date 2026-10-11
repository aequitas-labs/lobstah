import { createHash } from 'node:crypto';
import { backendScopes, displayGrounds, loadConfig, readHostedViews } from '@lobstah/core';
import type { Config, DispatchView, HostedView, GlassDispatch, TendAttention, WharfDocumentSummary } from '@lobstah/core';

// Display identity only: never used as authority or sent to the wharf.
export function hostedId(view: HostedView, id: string): string {
  return `srv-${createHash('sha256').update(JSON.stringify([view.wharf, view.url, view.account, view.grounds, id])).digest('hex').slice(0, 40)}`;
}
export function backendViews(config: Config) {
  const views = readHostedViews(config);
  return backendScopes(config).map((s) => ({ grounds: displayGrounds(s.grounds, config), kind: s.kind, wharf: s.wharf,
    ...(s.kind === 'wharf' ? { url: s.location.url, unavailable: views.find((v) => v.grounds === s.grounds)?.unavailable } : {}) }));
}
export function hostedDispatch(view: HostedView, d: DispatchView): GlassDispatch {
  const id = hostedId(view, d.id); const at = d.status?.at ?? view.observedAt;
  const label = `${view.grounds}@${view.wharf}`;
  return {
    id, lane: d.lane ?? 'work', bucket: d.state === 'cancelled' ? 'done' : d.state,
    repo: `${label} · ${d.repo}`, title: `[${label}] ${d.brief.split('\n')[0].slice(0, 200)}`,
    verb: view.unavailable ? 'unknown' : d.status?.verb ?? (d.state === 'queued' ? 'queued' : 'unknown'),
    note: view.unavailable ?? d.status?.note, verbAt: d.status?.at, updated: at, sort: Date.parse(at) || 0,
    brief: d.brief, attachments: [], messageAttachments: [], inbox: [], log: d.status ? [d.status] : [],
    evidence: { prUrls: d.status?.evidence?.prUrls },
    backend: { grounds: view.grounds, wharf: view.wharf, dispatch: d.id, unavailable: view.unavailable },
  };
}
export function hostedDispatches(config: Config): GlassDispatch[] {
  return readHostedViews(config).flatMap((view) => view.dispatches.map((d) => hostedDispatch(view, d)));
}
/**
 * The hosted glass at one item: `#job/<id>`, `#decision/<id>` or `#report/<id>`
 * (services/wharf/glass/src/route.ts). Nothing when the wharf has not named
 * its glass, or the id is not one the glass would accept in a link.
 */
export function hostedGlassLink(view: Pick<HostedView, 'glass'>, kind: 'job' | 'decision' | 'report', id: string): string | undefined {
  return view.glass && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? `${view.glass}/#${kind}/${id}` : undefined;
}
/**
 * Each cached decision or report once, under the grounds that shows it. Two
 * grounds on one wharf account both read a document that names no job of
 * theirs (a helm's report, a job past the list): the first grounds has it.
 */
function hostedDocuments(views: HostedView[]): Array<{ view: HostedView; doc: WharfDocumentSummary; key: string; id: string }> {
  const seen = new Set<string>();
  return views.flatMap((view) => (view.documents ?? []).flatMap((doc) => {
    const account = JSON.stringify([view.url, view.account, doc.id]);
    if (seen.has(account)) return [];
    seen.add(account);
    const id = hostedId(view, `document:${doc.id}`);
    return [{ view, doc, id, key: `${doc.kind}:${id}` }];
  }));
}
/**
 * The jobs a hosted decision frames, as tend's hideFramedQuestions reads
 * them: the worker's raw question does not walk beside the decision that
 * asks it properly. Withdrawn decisions are not in the cache.
 */
export function hostedDecisionFrames(config: Config): Array<{ dispatch: string; lane: 'work' | 'chore'; askedAt: string }> {
  return hostedDocuments(readHostedViews(config)).flatMap(({ view, doc }) => {
    const job = doc.kind === 'decision' && doc.dispatch ? view.dispatches.find((d) => d.id === doc.dispatch) : undefined;
    return job ? [{ dispatch: hostedId(view, job.id), lane: job.lane ?? 'work', askedAt: doc.at }] : [];
  });
}
/**
 * Decisions and reports filed on a wharf (`man ask`, `man file`), from the
 * boat's cache. A decision stands until the wharf shows it answered or
 * withdrawn; a report stands until it is acknowledged on this boat. The ack
 * is this boat's own file, like every other ack: the wharf records none.
 */
function hostedDocumentAttention(views: HostedView[], now: number): TendAttention[] {
  return hostedDocuments(views).flatMap(({ view, doc, key, id }): TendAttention[] => {
    if (doc.kind === 'decision' && doc.answered) return [];
    const job = doc.dispatch ? view.dispatches.find((d) => d.id === doc.dispatch) : undefined;
    const glass = hostedGlassLink(view, doc.kind, doc.id);
    return [{ key, id: job ? hostedId(view, job.id) : id, lane: job?.lane ?? 'work', kind: doc.kind,
      stateHash: `${doc.id}:${doc.at}`, verb: doc.kind, at: doc.at, standingSince: doc.at,
      ageSecs: Math.max(0, Math.floor((now - Date.parse(doc.at)) / 1000)), quiet: !!view.unavailable,
      note: `[${view.grounds}@${view.wharf}] ${view.unavailable ?? doc.title}`, ...(job ? { repo: job.repo } : {}),
      grounds: view.grounds, wharf: view.wharf, ...(glass ? { glass } : {}),
    }];
  });
}
/**
 * Whether a hosted item's ack still has its item, for cull. The item is in
 * the boat's cache: a listed job, a listed report, or a decision not yet
 * answered. While any wharf's state is unknown, every hosted ack is kept:
 * unknown is not gone.
 */
export function hostedItemExists(key: string, config: Config = loadConfig()): boolean {
  const views = readHostedViews(config);
  if (views.some((v) => v.unavailable)) return true;
  return views.some((view) => view.dispatches.some((d) => `${d.lane ?? 'work'}:${hostedId(view, d.id)}` === key))
    || hostedDocuments(views).some((d) => d.key === key && !(d.doc.kind === 'decision' && d.doc.answered));
}
export function hostedAttention(config: Config, now: number): TendAttention[] {
  const views = readHostedViews(config);
  return [...hostedDocumentAttention(views, now), ...views.flatMap((view) => view.dispatches.flatMap((d): TendAttention[] => {
    const status = d.status;
    if (!status || !['needs-decision', 'blocked', 'done', 'failed'].includes(status.verb) || d.state === 'cancelled') return [];
    const id = hostedId(view, d.id); const lane = d.lane ?? 'work';
    const glass = hostedGlassLink(view, 'job', d.id);
    return [{ key: `${lane}:${id}`, id, lane, kind: status.verb === 'done' || status.verb === 'failed' ? 'landed' : 'question',
      stateHash: `${status.at}:${status.verb}`, verb: status.verb, at: status.at, standingSince: status.at,
      ageSecs: Math.max(0, Math.floor((now - Date.parse(status.at)) / 1000)), quiet: !!view.unavailable,
      note: `[${view.grounds}@${view.wharf}] ${view.unavailable ?? status.note ?? status.verb}`, repo: d.repo,
      grounds: view.grounds, wharf: view.wharf, ...(glass ? { glass } : {}),
    }];
  }))];
}

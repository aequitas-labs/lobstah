import { createHash } from 'node:crypto';
import { backendScopes, readHostedViews } from '@lobstah/core';
import type { Config, DispatchView, HostedView, GlassDispatch, TendAttention } from '@lobstah/core';

// Display identity only: never used as authority or sent to the wharf.
export function hostedId(view: HostedView, id: string): string {
  return `srv-${createHash('sha256').update(JSON.stringify([view.wharf, view.url, view.account, view.grounds, id])).digest('hex').slice(0, 40)}`;
}
export function backendViews(config: Config) {
  const views = readHostedViews(config);
  return backendScopes(config).map((s) => ({ grounds: s.grounds, kind: s.kind, wharf: s.wharf,
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
export function hostedAttention(config: Config, now: number): TendAttention[] {
  return readHostedViews(config).flatMap((view) => view.dispatches.flatMap((d): TendAttention[] => {
    const status = d.status;
    if (!status || !['needs-decision', 'blocked', 'done', 'failed'].includes(status.verb) || d.state === 'cancelled') return [];
    const id = hostedId(view, d.id); const lane = d.lane ?? 'work';
    return [{ key: `${lane}:${id}`, id, lane, kind: status.verb === 'done' || status.verb === 'failed' ? 'landed' : 'question',
      stateHash: `${status.at}:${status.verb}`, verb: status.verb, at: status.at, standingSince: status.at,
      ageSecs: Math.max(0, Math.floor((now - Date.parse(status.at)) / 1000)), quiet: !!view.unavailable,
      note: `[${view.grounds}@${view.wharf}] ${view.unavailable ?? status.note ?? status.verb}`, repo: d.repo,
    }];
  }));
}

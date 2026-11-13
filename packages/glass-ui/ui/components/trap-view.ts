import type { GlassSnapshot } from '@lobstah/core';
import type { GlassTrapView } from '../../src/glass-diff.js';
import { fileUrl } from '../backend.js';
import { html } from '../html.js';
import {
  cmdRow,
  liveLinkNote,
  startCommands,
  trapDisplayName,
  trapOpen,
  trapRoutes,
  trapOpenRoutes,
  readOnlyNotice,
  trapScope,
  trapSessionRow,
  trapStatus,
} from './common.js';
import { DetailFrame } from './detail-frame.js';
import { Ago, ViewMessages, WorkerLine } from './detail-parts.js';
import { dispatchCard } from './dispatches.js';
import { LinkedText } from './links.js';
import { StatusChip } from './prs.js';
import { GrantChip } from './session-grants.js';

/** The trap's current dispatch and recent catches use the same cards as their tab. */
export function TrapView({ trap: t, snapshot }: { trap: GlassTrapView; snapshot: GlassSnapshot }) {
  const current = t.live && t.claimed ? t.catches.find((catch_) => catch_.id === t.claimed && catch_.bucket === 'active') : undefined;
  const catches = t.catches.filter((catch_) => catch_.id !== current?.id);
  const status = trapStatus(t);
  const routes = trapRoutes(t);
  const route = routes[0];
  const open = route
    ? html`<div class="route">${route.control(route.name)} <span class="dim">${route.where}</span></div>`
    : trapOpen(t, 'Open session');
  const session = trapSessionRow(t);
  const lifecycle = [...t.notices].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return html`<${DetailFrame} identity=${html`<span>${trapScope(t)}${trapScope(t) && ' · '}<code>wt:${t.trapId}</code></span>`} open=${open}>
    <header class="pr-view-head"><h2>🪤 ${trapDisplayName(t)}</h2><div class="pr-view-chips">${StatusChip(t.live ? 'live' : status.word, t.live ? 'ok' : status.tone)}${t.live && StatusChip(current ? status.word : t.listening ? 'listening' : 'idle', status.tone)}</div><div class="view-meta"><${WorkerLine} worker=${t} />${t.signedOnAt && html` · signed on ${Ago(t.signedOnAt)}`}${t.heartbeatAt && html` · heartbeat ${Ago(t.heartbeatAt)}`}${t.sessionId && html`<${GrantChip} session=${t.sessionId} grants=${snapshot.sessionGrants ?? []} />`}</div></header>
    ${t.starting || t.requested ? html`<section class="trap-start"><h4>${t.starting?.failedAt ? 'Start failed' : t.requested ? 'Requested' : 'Starting'}</h4>${t.starting?.reason && html`<p class="bad">${LinkedText(t.starting.reason)}</p>`}${t.starting?.reservedAt && html`<p class="dim">Reserved ${Ago(t.starting.reservedAt)}</p>`}${startCommands(t) ?? html`<p class="dim">Waiting for the helm to start this trap.</p>`}</section>` : current ? html`<section class="trap-current"><h4>Working on</h4>${dispatchCard(current)}</section>` : t.live && html`<section class="trap-current"><p class="dim">Listening for work</p></section>`}
    ${(catches.length > 0 || (t.totalCatches ?? 0) > 0) && html`<section class="trap-catches"><h4>🦞 Catches <span class="dim">${t.totalCatches ?? 0} all time</span></h4><div class="detail-cards">${catches.map(dispatchCard)}</div></section>`}
    <${ViewMessages} messages=${t.messages} file=${(name: string) => fileUrl({ kind: 'trap', trapId: t.trapId }, name)} />
    ${lifecycle.length > 0 && html`<details class="view-details trap-lifecycle"><summary>Lifecycle</summary>${lifecycle.map((notice) => html`<article class="view-event"><div><b>${notice.kind}</b><span class="dim"> · ${Ago(notice.at)}</span></div><div>${LinkedText(notice.text)}</div></article>`)}</details>`}
    ${(t.worktree || t.sessionId || session || t.liveLink) && html`<details class="view-details trap-details"><summary>Details</summary>${(!snapshot.viewer?.onMachine || t.boat) && html`<p class="dim offmachine">Running on ${t.boat ?? snapshot.viewer?.machine ?? 'its machine'}</p>`}${t.worktree && html`<h4>Worktree</h4>${cmdRow(t.worktree)}`}${t.sessionId && html`<h4>Session</h4>${cmdRow(t.sessionId)}`}${routes.slice(1).map((route) => html`<div class="route">${route.control(route.name)} <span class="dim">${route.where}</span></div>`)}${!route && trapOpenRoutes(t)}${session && html`<h4>Open session</h4><div class="route">${session}</div>`}${readOnlyNotice()}${liveLinkNote(t)}</details>`}
  <//>`;
}

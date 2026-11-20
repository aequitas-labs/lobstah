import { useEffect, useRef, useState } from 'preact/hooks';
import type { ThreadSummary, ThreadView, ThreadRound } from '@lobstah/core';
import { html } from '../html.js';
import { backend, fileUrl } from '../backend.js';
import { getState, viewOf } from '../store.js';
import { openDecision } from '../actions.js';
import { closeThreadSheet, markThreadResponseSeen, openThread, reopenConversation } from '../thread-actions.js';
import { safeHref } from '../../src/glass-markdown.js';
import { ThreadComposer } from './thread-composer.js';
import { Button } from './button.js';
import { SectionHead } from './section-head.js';
import { LinkedText } from './links.js';
import { Age, ImageThumb } from './common.js';
import { DecisionRow } from './decision-row.js';
import { VerbIcon } from './run-status.js';
import { dispatchCard } from './dispatches.js';
import { ReportEmbed } from './decision-embeds.js';
import { prCard } from './prs.js';
import { Sheet } from './sheet.js';

function useThread(id: string | undefined) {
  const [view, setView] = useState<ThreadView>(),
    [error, setError] = useState('');
  const snapshot = getState().snapshot;
  const revision = snapshot?.threads?.find((t) => t.id === id)?.updatedAt;
  const cards = snapshot?.decisions?.map((c) => c.key).join(',');
  useEffect(() => {
    let live = true;
    setView(undefined);
    setError('');
    if (id && backend().thread)
      backend().thread!(id).then(
        (r) => {
          if (!live) return;
          if (r.ok) setView(r.data);
          else setError('This conversation is unavailable');
        },
        () => live && setError('The conversation could not be loaded'),
      );
    else if (id) setError('This conversation is unavailable');
    return () => {
      live = false;
    };
  }, [id, revision, cards]);
  return { view, error };
}
/** A response is read only while its content is visible on this page. */
function ThreadResponse({ view }: { view: ThreadView }) {
  const box = useRef<HTMLDivElement>(null);
  const state = getState(),
    covered = !!(state.reportSheet || state.lightbox || state.messageSheet);
  useEffect(() => {
    let marked = false,
      busy = false,
      visible = typeof IntersectionObserver !== 'function';
    const seen = async () => {
      if (covered || document.hidden || !visible || marked || busy || !view.unreadResponse || !view.responseSeq) return;
      busy = true;
      marked = await markThreadResponseSeen(view.id, view.responseSeq);
      busy = false;
    };
    const observer =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            visible = entries.some((entry) => entry.isIntersecting);
            void seen();
          })
        : undefined;
    if (box.current) observer?.observe(box.current);
    void seen();
    document.addEventListener('visibilitychange', seen);
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', seen);
    };
  }, [view.id, view.responseSeq, view.unreadResponse, covered]);
  return html`<div class="thread-response" ref=${box}>${outcome(view)}${view.responseText && html`<p>Helm · ${LinkedText(view.responseText)}</p>`}</div>`;
}
export function ThreadNotes({ id }: { id: string }) {
  const { view, error } = useThread(id);
  return html`<aside class="thread-notes"><a href=${`#thread/${id}`}>${view?.title ?? 'Conversation'}</a>${error && html`<p class="dim">${error}</p>`}${view && html`<${ThreadResponse} view=${view} />`}${view && Notes(view)}</aside>`;
}
function Notes(view: ThreadView) {
  const notes = [
    ...view.notes.open.map((text) => ({ text, checked: false })),
    ...view.notes.decided.map((text) => ({ text, checked: true })),
  ];
  return (
    notes.length > 0 &&
    html`<ul class="thread-checklist" aria-label="Conversation notes">${notes.map(
      ({ text, checked }) =>
        html`<li><input type="checkbox" checked=${checked} disabled aria-label=${checked ? 'Decided' : 'Open'} /><span>${LinkedText(text)}</span></li>`,
    )}</ul>`
  );
}

/** References keep the same cards and destinations as their own overview pages. */
function ThreadLink({ kind, reference: ref, text }: { kind: string; reference: string; text: string }) {
  const snapshot = viewOf(getState());
  if (kind === 'report') {
    const key = ref.startsWith('report:') ? ref : `report:${ref}`;
    return html`<div class="thread-links cards"><${ReportEmbed} reference=${{ kind: 'report', key }} /></div>`;
  }
  if (kind === 'dispatched') return html`<${ThreadDispatch} id=${ref} text=${text} />`;
  const pr = snapshot?.prs.find((p) => p.url === ref || p.key === ref);
  return pr
    ? html`<div class="thread-links cards">${prCard(pr)}</div>`
    : html`<p><a href=${safeHref(ref)} target="_blank" rel="noopener">${LinkedText(text)}</a></p>`;
}
function ThreadDispatch({ id, text }: { id: string; text: string }) {
  const key = id.replace(/^(work|chore):/, '');
  const cached = viewOf(getState())?.dispatches.find((d) => d.id === key);
  const [loaded, setLoaded] = useState<typeof cached>();
  useEffect(() => {
    let live = true;
    if (!cached)
      void backend()
        .dispatch(id)
        .then((r) => {
          if (live && r.ok) setLoaded(r.data);
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [id, !!cached]);
  const dispatch = cached ?? loaded;
  return dispatch
    ? html`<div class="thread-links cards">${dispatchCard(dispatch)}</div>`
    : html`<p><a href=${`#dispatch/${encodeURIComponent(id)}`}>${LinkedText(text)}</a></p>`;
}
function outcome(item: ThreadSummary | ThreadView) {
  const result = item.outcome;
  if (!result) return null;
  const chip = html`<span class="badge">${result.kind}</span>`;
  return html`<div class="thread-outcome">${
    result.ref && (result.kind === 'planned' || result.kind === 'dispatched')
      ? html`<${ThreadLink} kind=${result.kind} reference=${result.ref} text=${result.note} />`
      : [chip, ' ', LinkedText(result.note)]
  }</div>`;
}
function Round({ round, view, number, current }: { round: ThreadRound; view: ThreadView; number: number; current: boolean }) {
  return html`<details class="thread-round" open=${current}><summary>Round ${number} · ${Age(round.at)} ago</summary>${round.entries.map(
    (entry) => {
      if ('card' in entry) {
        const card = view.cards.find((c) => c.key === entry.card);
        return html`<article class="msg"><${Button} onClick=${() => openDecision(entry.card)}>${card?.title ?? 'Open card'}<//>${card?.standing ? html`<span class="badge warn">Card for you</span>` : card?.answer ? html`<p>${LinkedText([card.answer.option, card.answer.text].filter(Boolean).join(' · '))}</p>` : html`<p class="dim">Closed card</p>`}${card?.answer?.attachments.map((a) => html`<span class="dchip">${a.name}</span>`)}</article>`;
      }
      if ('link' in entry) return html`<${ThreadLink} kind=${entry.link} reference=${entry.ref} text=${entry.text} />`;
      return html`<article class="msg"><span class="dim">You${entry.via === 'chat' ? ' · In chat' : ''}</span><div>${LinkedText(entry.text)}</div><div class="dfiles">${entry.attachments.map((a) => (/\.(png|jpe?g|webp|gif)$/i.test(a.name) ? ImageThumb(fileUrl({ kind: 'thread', id: view.id }, a.name), a.name, 'dimg') : html`<a href=${fileUrl({ kind: 'thread', id: view.id }, a.name)} download=${a.name}>${a.name}</a>`))}</div></article>`;
    },
  )}</details>`;
}
/** A conversation in the sheet over the Threads tab, as a report opens; Back returns to the list. */
export function ThreadSheet({ id }: { id: string }) {
  const { view, error } = useThread(id);
  // The snapshot already names it, so the bar has its title before the conversation loads.
  const title = view?.title ?? getState().snapshot?.threads?.find((t) => t.id === id)?.title ?? 'Conversation';
  return html`<${Sheet} page=${id} title=${title} titleId="tsheet-title" cls="tsheet" onBack=${closeThreadSheet}>
    <div class="thread-sheet-body">${error ? html`<p role="status">${error}</p>` : view ? html`<${Conversation} view=${view} />` : html`<p class="dim">Loading conversation</p>`}</div>
  <//>`;
}
function Conversation({ view }: { view: ThreadView }) {
  return html`<div class="thread-view"><${SectionHead} title=${view.title} page />
    ${html`<${ThreadResponse} view=${view} />`}${Notes(view)}
    ${view.rounds.length >= 6 && html`<p class="thread-hint dim">This is a long thread · A report can fill in missing facts or a plan can settle the approach</p>`}
    ${view.rounds.map((round, i) => html`<${Round} key=${round.at} round=${round} view=${view} number=${i + 1} current=${i === view.rounds.length - 1} />`)}
    ${view.state === 'resolved' ? html`<${Button} action=${() => reopenConversation(view.id)} done="Conversation reopened">Reopen<//>` : html`<${ThreadComposer} id=${view.id} />`}
  </div>`;
}
/** Resolved conversations stay separate even while their last response is unread. */
export function threadSections(items: readonly ThreadSummary[]) {
  const newest = [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return { open: newest.filter((t) => t.state === 'open'), resolved: newest.filter((t) => t.state === 'resolved') };
}
export function threadStatus(item: ThreadSummary) {
  if (item.state === 'resolved') return { verb: 'done' as const, label: 'Resolved' };
  if (item.cards.length) return { verb: 'needs-decision' as const, label: 'Waiting for you' };
  if (item.waitingForHelm) return { verb: 'queued' as const, label: 'Waiting for helm' };
  return { verb: 'done' as const, label: 'Acknowledged' };
}
function ThreadCard({ item }: { item: ThreadSummary }) {
  const status = threadStatus(item);
  const preview =
    item.responseText === 'Notes updated' ? (item.openLine ?? item.responseText) : (item.responseText ?? item.openLine ?? status.label);
  return html`<${DecisionRow} title=${item.title} label=${`${item.unreadResponse ? 'Unread response: ' : ''}${item.title}`} state=${item.unreadResponse ? 'unread' : 'read'}
    attrs=${{ 'data-thread': item.id, class: `drow thread-card ${item.unreadResponse ? 'unread' : 'read'}` }}
    prefix=${html`<span class="thread-state" role="img" aria-label=${status.label} title=${status.label}><span aria-hidden="true"><${VerbIcon} verb=${status.verb} /></span></span>`}
    preview=${preview} meta=${[item.grounds, ' · ', Age(item.updatedAt), ' ago']}
    onOpen=${() => openThread(item.id)} />`;
}
export function Threads() {
  const state = getState();
  const query = state.prefs.q.toLowerCase();
  const items = (state.snapshot?.threads ?? []).filter(
    (t) => !query || `${t.title} ${t.openLine ?? ''} ${t.responseText ?? ''}`.toLowerCase().includes(query),
  );
  const sections = threadSections(items);
  const list = (items: ThreadSummary[]) =>
    html`<ul class="dlist">${items.map((item) => html`<${ThreadCard} key=${item.id} item=${item} />`)}</ul>`;
  return html`<section class="threads-page"><${SectionHead} title="Threads" page />
    ${sections.open.length ? list(sections.open) : html`<p class="empty">No open threads</p>`}
    ${sections.resolved.length > 0 && html`<details class="thread-resolved"><summary>Resolved (${sections.resolved.length})${sections.resolved.some((t) => t.unreadResponse) ? ' · unread responses' : ''}</summary>${list(sections.resolved)}</details>`}
  </section>`;
}

import { useEffect, useState } from 'preact/hooks';
import type { ThreadSummary, ThreadView, ThreadRound } from '@lobstah/core';
import { html } from '../html.js';
import { backend, fileUrl } from '../backend.js';
import { getState } from '../store.js';
import { openDecision } from '../actions.js';
import { openThread, reopenConversation, threadId } from '../thread-actions.js';
import { safeHref } from '../../src/glass-markdown.js';
import { ThreadComposer } from './thread-composer.js';
import { Button } from './button.js';
import { SectionHead } from './section-head.js';
import { LinkedText } from './links.js';
import { Age, ImageThumb } from './common.js';

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
export function ThreadNotes({ id }: { id: string }) {
  const { view, error } = useThread(id);
  return html`<aside class="thread-notes"><a href=${`#thread/${id}`}>${view?.title ?? 'Conversation'}</a>${error && html`<p class="dim">${error}</p>`}${view && Notes(view)}</aside>`;
}
function Notes(view: ThreadView) {
  return [
    view.notes.decided.length > 0 && html`<h4>Decided</h4><ul>${view.notes.decided.map((s) => html`<li>${LinkedText(s)}</li>`)}</ul>`,
    view.notes.open.length > 0 && html`<h4>Open</h4><ul>${view.notes.open.map((s) => html`<li>${LinkedText(s)}</li>`)}</ul>`,
  ];
}
function outcome(item: ThreadSummary | ThreadView) {
  const result = item.outcome;
  if (!result) return null;
  const chip = html`<span class="badge">${result.kind}</span>`;
  return html`<div class="thread-outcome">${result.kind === 'planned' ? html`<a href=${safeHref(result.ref ?? '')} target="_blank" rel="noopener">${chip}</a>` : result.kind === 'dispatched' ? html`<a href=${`#dispatch/${encodeURIComponent(result.ref ?? '')}`}>${chip}</a>` : chip} ${LinkedText(result.note)}</div>`;
}
function Round({ round, view, number, current }: { round: ThreadRound; view: ThreadView; number: number; current: boolean }) {
  return html`<details class="thread-round" open=${current}><summary>Round ${number} · ${Age(round.at)} ago</summary>${round.entries.map(
    (entry) => {
      if ('card' in entry) {
        const card = view.cards.find((c) => c.key === entry.card);
        return html`<article class="msg"><${Button} onClick=${() => openDecision(entry.card)}>${card?.title ?? 'Open card'}<//>${card?.standing ? html`<span class="badge warn">Card for you</span>` : card?.answer ? html`<p>${LinkedText([card.answer.option, card.answer.text].filter(Boolean).join(' · '))}</p>` : html`<p class="dim">Closed card</p>`}${card?.answer?.attachments.map((a) => html`<span class="dchip">${a.name}</span>`)}</article>`;
      }
      if ('link' in entry)
        return html`<p>${entry.link === 'planned' ? html`<a href=${safeHref(entry.ref)} target="_blank" rel="noopener">${LinkedText(entry.text)}</a>` : entry.link === 'dispatched' ? html`<a href=${`#dispatch/${encodeURIComponent(entry.ref)}`}>${LinkedText(entry.text)}</a>` : html`<a href=${`#report/${encodeURIComponent(entry.ref)}`}>${LinkedText(entry.text)}</a>`}</p>`;
      return html`<article class="msg"><span class="dim">You${entry.via === 'chat' ? ' · In chat' : ''}</span><div>${LinkedText(entry.text)}</div><div class="dfiles">${entry.attachments.map((a) => (/\.(png|jpe?g|webp|gif)$/i.test(a.name) ? ImageThumb(fileUrl({ kind: 'thread', id: view.id }, a.name), a.name, 'dimg') : html`<a href=${fileUrl({ kind: 'thread', id: view.id }, a.name)} download=${a.name}>${a.name}</a>`))}</div></article>`;
    },
  )}</details>`;
}
function Conversation({ id }: { id: string }) {
  const { view, error } = useThread(id);
  if (error) return html`<p role="status">${error}</p>`;
  if (!view) return html`<p class="dim">Loading conversation</p>`;
  return html`<div class="thread-view"><a href="#helm">All conversations</a><${SectionHead} title=${view.title} page />
    ${outcome(view)}${Notes(view)}
    ${view.rounds.length >= 6 && html`<p class="thread-hint dim">This is a long thread · A report can fill in missing facts or a plan can settle the approach</p>`}
    ${view.rounds.map((round, i) => html`<${Round} key=${round.at} round=${round} view=${view} number=${i + 1} current=${i === view.rounds.length - 1} />`)}
    ${view.state === 'resolved' ? html`<${Button} action=${() => reopenConversation(view.id)} done="Conversation reopened">Reopen<//>` : html`<${ThreadComposer} id=${view.id} />`}
  </div>`;
}
export function Helm() {
  const state = getState(),
    id = threadId();
  if (id) return html`<${Conversation} key=${id} id=${id} />`;
  const query = state.prefs.q.toLowerCase();
  const items = (state.snapshot?.threads ?? []).filter((t) => !query || `${t.title} ${t.openLine ?? ''}`.toLowerCase().includes(query));
  const section = (title: string, list: ThreadSummary[]) =>
    html`<section><${SectionHead} title=${title} count=${list.length} />${list.length ? html`<ul class="dlist">${list.map((item) => html`<li key=${item.id} class="drow"><button class="dopen" type="button" onClick=${() => openThread(item.id)}><b class="dtitle">${item.title}</b><span class="dmeta dim">${item.state === 'resolved' ? 'Resolved' : item.cards.length ? 'Card for you' : item.waitingForHelm ? 'Waiting for helm' : 'Open'} · ${item.grounds} · ${Age(item.updatedAt)} ago</span>${item.openLine && html`<span class="dim">${item.openLine}</span>`}</button>${outcome(item)}</li>`)}</ul>` : html`<p class="dim">Nothing here</p>`}</section>`;
  return [
    html`<${SectionHead} title="Helm" page />`,
    section(
      'Bait',
      items.filter((t) => t.state === 'open' && t.kind !== 'thread'),
    ),
    section(
      'Threads',
      items.filter((t) => t.state === 'open' && t.kind === 'thread'),
    ),
    section(
      'Resolved today',
      items.filter((t) => t.state === 'resolved'),
    ),
  ];
}

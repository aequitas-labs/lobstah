import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ThreadSummary, ThreadView, ThreadEntry, ThreadAttachment, ThreadTrackedItem } from '@lobstah/core';
import type { ComponentChildren } from 'preact';
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
import { isIconVerb, VerbIcon, WorkStateIcon, type WorkStateIconState } from './run-status.js';
import { dispatchCard, dispatchHeadCard } from './dispatches.js';
import { ReportEmbed } from './decision-embeds.js';
import { prCard } from './prs.js';
import { HelmIcon, WORK_ICON } from './icons.js';
import type { WorkKind } from './icons.js';
import { Sheet } from './sheet.js';

/**
 * A conversation, fetched again whenever the snapshot says it changed. The
 * loaded one stays on screen while it refreshes, so the page keeps its
 * height and scroll; another conversation's never shows under this id.
 */
function useThread(id: string | undefined) {
  const [loaded, setLoaded] = useState<{ id: string; view: ThreadView }>(),
    [error, setError] = useState('');
  const snapshot = getState().snapshot;
  const revision = snapshot?.threads?.find((t) => t.id === id)?.updatedAt;
  const cards = snapshot?.decisions?.map((c) => c.key).join(',');
  useEffect(() => {
    setError('');
  }, [id]);
  useEffect(() => {
    let live = true;
    if (id && backend().thread)
      backend().thread!(id).then(
        (r) => {
          if (!live) return;
          if (r.ok) {
            setLoaded({ id, view: r.data });
            setError('');
          } else setError('This conversation is unavailable');
        },
        () => live && setError('The conversation could not be loaded'),
      );
    else if (id) setError('This conversation is unavailable');
    return () => {
      live = false;
    };
  }, [id, revision, cards]);
  return { view: loaded && loaded.id === id ? loaded.view : undefined, error };
}
/** A response is read only while its content is visible on this page. */
function useSeen(view: ThreadView) {
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
  return box;
}
/** Above a card's question: the thread's latest response, read once it shows. */
function ThreadResponse({ view }: { view: ThreadView }) {
  const box = useSeen(view);
  return html`<div class="thread-response" ref=${box}>${outcome(view)}${view.responseText && html`<p>Helm · ${LinkedText(view.responseText)}</p>`}</div>`;
}
/** The end of the conversation: everything above it has been shown once it is in view. */
function SeenMark({ view }: { view: ThreadView }) {
  const box = useSeen(view);
  return html`<div class="thread-seen" ref=${box} aria-hidden="true"></div>`;
}
export function ThreadNotes({ id }: { id: string }) {
  const { view, error } = useThread(id);
  return html`<aside class="thread-notes"><a href=${`#thread/${id}`}>${view?.title ?? 'Conversation'}</a>${error && html`<p class="dim">${error}</p>`}${view && html`<${ThreadResponse} view=${view} />`}${view && Notes(view)}</aside>`;
}
/** The helm's notes, pinned above the conversation: what's decided, then what's still open. */
function Notes(view: Pick<ThreadView, 'notes' | 'notesAt'>) {
  const notes = [
    ...view.notes.decided.map((text) => ({ text, decided: true })),
    ...view.notes.open.map((text) => ({ text, decided: false })),
  ];
  return (
    notes.length > 0 &&
    html`<section class="thread-notes-box" aria-label="Notes">
      <p class="thread-notes-head">Notes · helm${view.notesAt && html` · updated ${Age(view.notesAt)} ago`}</p>
      <ul>${notes.map(
        ({ text, decided }) =>
          html`<li class=${decided ? 'decided' : 'open'}><span class="thread-note-mark" aria-hidden="true">${decided ? '✓' : '?'}</span><span class="sr-only">${decided ? 'Decided: ' : 'Open: '}</span><span>${LinkedText(text)}</span></li>`,
      )}</ul>
    </section>`
  );
}

const WORK_LABEL: Record<WorkKind, string> = { dispatch: 'Dispatch', pr: 'PR', card: 'Card', todo: 'Todo', report: 'Report', plan: 'Plan' };
/** A kind of work's icon, named for screen readers. */
function WorkIcon({ kind }: { kind: WorkKind }) {
  return html`<span class="thread-work-icon" title=${WORK_LABEL[kind]}>${WORK_ICON[kind]}<span class="sr-only">${WORK_LABEL[kind]}: </span></span>`;
}
/** Linked work in a conversation: its kind's icon beside its card or link. */
function Work({ kind, children }: { kind: WorkKind; children: ComponentChildren }) {
  return html`<div class=${`thread-work thread-work-${kind}`}><${WorkIcon} kind=${kind} /><div class="thread-work-body">${children}</div></div>`;
}
/** A PR reference (`owner/repo#7`, `pr:owner/repo#7`, or already its URL) as its GitHub URL. */
function prUrl(ref: string): string {
  const m = /^(?:pr:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(ref.trim());
  return m ? `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` : ref;
}
/** References keep the same cards and destinations as their own overview pages. */
function ThreadLink({ kind, reference: ref, text }: { kind: string; reference: string; text: string }) {
  const snapshot = viewOf(getState());
  if (kind === 'report') {
    const key = ref.startsWith('report:') ? ref : `report:${ref}`;
    return html`<${Work} kind="report"><div class="thread-links cards"><${ReportEmbed} reference=${{ kind: 'report', key }} /></div><//>`;
  }
  if (kind === 'dispatched') return html`<${ThreadDispatch} id=${ref} text=${text} />`;
  const pr = snapshot?.prs.find((p) => p.url === ref || p.key === ref);
  if (pr) return html`<${Work} kind="pr"><div class="thread-links cards">${prCard(pr)}</div><//>`;
  // A PR the snapshot doesn't list keeps its icon and links to GitHub.
  const href = kind === 'pr' ? prUrl(ref) : ref;
  return html`<${Work} kind=${kind === 'pr' ? 'pr' : 'plan'}><p><a href=${safeHref(href)} target="_blank" rel="noopener">${LinkedText(text)}</a></p><//>`;
}
/** The dispatch a conversation started on: its card heads the conversation, loaded when the snapshot no longer lists it. */
function useDispatch(id: string) {
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
  return cached ?? loaded;
}
function AboutDispatch({ id }: { id: string }) {
  const dispatch = useDispatch(id);
  if (!dispatch) return html`<p class="thread-about"><a href=${`#dispatch/${encodeURIComponent(id)}`}>Open dispatch</a></p>`;
  const snapshot = viewOf(getState());
  const prs = dispatch.prList?.length
    ? dispatch.prList
    : dispatch.prHead
      ? [dispatch.prHead]
      : (snapshot?.prs ?? []).filter((pr) => pr.dispatchIds.includes(dispatch.id));
  return html`<div class="thread-about cards">${dispatchHeadCard(dispatch, prs)}</div>`;
}
function ThreadDispatch({ id, text }: { id: string; text: string }) {
  const dispatch = useDispatch(id);
  return html`<${Work} kind="dispatch">${
    dispatch
      ? html`<div class="thread-links cards">${dispatchCard(dispatch)}</div>`
      : html`<p><a href=${`#dispatch/${encodeURIComponent(id)}`}>${LinkedText(text)}</a></p>`
  }<//>`;
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
function Files({ view, files }: { view: ThreadView; files: readonly ThreadAttachment[] }) {
  if (!files.length) return null;
  const owner = { kind: 'thread' as const, id: view.id };
  return html`<div class="dfiles">${files.map((a) => (/\.(png|jpe?g|webp|gif)$/i.test(a.name) ? ImageThumb(fileUrl(owner, a.name), a.name, 'dimg') : html`<a href=${fileUrl(owner, a.name)} download=${a.name}>${a.name}</a>`))}</div>`;
}
const SYSTEM_EVENT: Record<string, string> = { thread: 'Discussion started', bait: 'Bait received' };
/** One entry of the conversation: the person on the right, the helm beside its wheel on the left. */
function Entry({ entry, view, at }: { entry: ThreadEntry; view: ThreadView; at: string }) {
  if ('card' in entry) {
    const card = view.cards.find((c) => c.key === entry.card);
    return html`<article class="thread-entry thread-card-entry"><${WorkIcon} kind="card" />${card?.standing ? html`<span class="badge warn">Card for you</span>` : null}<${Button} onClick=${() => openDecision(entry.card)}>${card?.title ?? 'Open card'}<//>${card?.answer ? html`<p class="thread-answer">${LinkedText([card.answer.option, card.answer.text].filter(Boolean).join(' · '))}</p>` : !card?.standing && html`<p class="dim">Closed card</p>`}${card?.answer?.attachments.map((a) => html`<span class="dchip">${a.name}</span>`)}</article>`;
  }
  if ('link' in entry)
    return html`<div class="thread-entry thread-system"><${ThreadLink} kind=${entry.link} reference=${entry.ref} text=${entry.text} /></div>`;
  if ('event' in entry)
    return html`<p class="thread-entry thread-system dim">${entry.event === 'tracked' ? entry.text : (SYSTEM_EVENT[entry.kind] ?? 'Classified')} · ${Age(at)} ago</p>`;
  if (entry.by === 'helm') {
    const unread = entry.seq > (view.seenThrough ?? 0);
    return html`<article class=${'thread-entry thread-msg from-helm' + (unread ? ' unread' : '')}><span class="thread-avatar" aria-hidden="true">${HelmIcon}</span><div class="thread-bubble"><p class="thread-meta">Helm · ${Age(at)} ago${unread && html` · <span class="thread-new">New</span>`}</p>${entry.text && html`<div class="thread-text">${LinkedText(entry.text)}</div>`}<${Files} view=${view} files=${entry.attachments} /></div></article>`;
  }
  return html`<article class="thread-entry thread-msg from-person"><div class="thread-bubble"><p class="thread-meta">You${entry.via === 'chat' ? ' · in chat' : entry.via === 'slack' ? ' · in Slack' : ''} · ${Age(at)} ago</p>${entry.text && html`<div class="thread-text">${LinkedText(entry.text)}</div>`}<${Files} view=${view} files=${entry.attachments} /></div></article>`;
}
/** The conversation as one chat: rounds stay in the stored thread for the helm, but the reader sees only the messages. */
function Timeline({ view }: { view: ThreadView }) {
  return html`<div class="thread-timeline">${view.rounds.flatMap((round, r) =>
    round.entries.map(
      (entry, i) => html`<${Entry} key=${`${r}:${i}`} entry=${entry} view=${view} at=${('at' in entry && entry.at) || round.at} />`,
    ),
  )}</div>`;
}
/** Within this many pixels of the end, the reader counts as at the newest message. */
const PIN_SLACK = 24;
/**
 * Keep a conversation's sheet at its newest message: set before the first
 * paint when it opens or another opens in its place, and again as it grows
 * (a new message, an image, a card that loads) while the reader is at the
 * bottom. Once they scroll up to read, it stays where they put it.
 */
function usePinnedBottom(id: string, ready: boolean) {
  const body = useRef<HTMLDivElement>(null),
    pinned = useRef(true);
  const scroller = () => body.current?.closest<HTMLElement>('.rbody') ?? undefined;
  const stick = () => {
    const box = scroller();
    if (box && pinned.current && box.scrollTop !== box.scrollHeight - box.clientHeight) box.scrollTop = box.scrollHeight;
  };
  useLayoutEffect(() => {
    pinned.current = true;
  }, [id]);
  useLayoutEffect(stick);
  useLayoutEffect(() => {
    const box = scroller();
    if (!box || !ready) return;
    const onScroll = () => {
      pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight <= PIN_SLACK;
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    const grown = typeof ResizeObserver === 'function' ? new ResizeObserver(stick) : undefined;
    if (body.current) grown?.observe(body.current);
    return () => {
      box.removeEventListener('scroll', onScroll);
      grown?.disconnect();
    };
  }, [id, ready]);
  return body;
}
/** A conversation in the sheet over the Threads tab, as a report opens; Back returns to the list. */
export function ThreadSheet({ id }: { id: string }) {
  const { view, error } = useThread(id);
  const body = usePinnedBottom(id, !!view);
  // The snapshot already names it, so the bar has its title before the conversation loads.
  const title = view?.title ?? getState().snapshot?.threads?.find((t) => t.id === id)?.title ?? 'Conversation';
  return html`<${Sheet} page=${id} title=${title} titleId="tsheet-title" cls="tsheet" onBack=${closeThreadSheet}>
    <div class="thread-sheet-body" ref=${body}>${error && !view ? html`<p role="status">${error}</p>` : view ? html`<${Conversation} view=${view} />` : html`<p class="dim">Loading conversation</p>`}</div>
  <//>`;
}
/** Status words that name a state other than the dispatch verb of the same name. */
const TRACKED_STATUS: Record<string, WorkStateIconState> = {
  merged: 'merged',
  open: 'open',
  draft: 'open',
  'closed without merging': 'closed',
  'checks failing': 'failed',
  'not watched yet': 'unknown',
  gone: 'unknown',
  answered: 'done',
  'waiting for you': 'needs-decision',
  withdrawn: 'closed',
  dropped: 'closed',
  overdue: 'limited',
  stale: 'paused',
};
/** Without a known status word, the item's state decides: done, stalled, or still open. */
const TRACKED_FALLBACK: Record<ThreadTrackedItem['state'], WorkStateIconState> = { done: 'done', stalled: 'blocked', open: 'open' };

/** A linked item's state icon, and its status in words for its name and tooltip. */
export function trackedStateIcon(item: Pick<ThreadTrackedItem, 'state' | 'status'>): { state: WorkStateIconState; label: string } {
  const state = TRACKED_STATUS[item.status] ?? (isIconVerb(item.status) ? item.status : TRACKED_FALLBACK[item.state]);
  const words = item.status.replace(/-/g, ' ');
  return { state, label: words.charAt(0).toUpperCase() + words.slice(1) };
}
/** Work the thread waits on, with its live state as an icon in one right-hand column. Read-only: each item is acted on in its own view. */
function Tracked(view: ThreadView) {
  const items = view.tracked ?? [];
  return (
    items.length > 0 &&
    html`<section class="thread-tracked" aria-label="Linked work">
      <p class="thread-notes-head">${view.state === 'tracking' ? 'Tracking · closes when this work finishes' : 'Linked work'}</p>
      <ul>${items.map((item) => {
        const icon = trackedStateIcon(item);
        return html`<li><${WorkIcon} kind=${item.kind} />${item.href ? html`<a href=${safeHref(item.href)}>${item.title}</a>` : html`<span>${item.title}</span>`}<${WorkStateIcon} state=${icon.state} label=${icon.label} /></li>`;
      })}</ul>
    </section>`
  );
}
function Conversation({ view }: { view: ThreadView }) {
  return html`<div class="thread-view"><${SectionHead} title=${view.title} page />
    ${view.about && html`<${AboutDispatch} id=${view.about} />`}${Notes(view)}${Tracked(view)}
    ${view.rounds.length >= 6 && html`<p class="thread-hint dim">This is a long thread · A report can fill in missing facts or a plan can settle the approach</p>`}
    <${Timeline} view=${view} />
    ${outcome(view)}<${SeenMark} view=${view} />
    ${view.state === 'resolved' ? html`<${Button} action=${() => reopenConversation(view.id)} done="Conversation reopened">Reopen<//>` : html`<${ThreadComposer} id=${view.id} />`}
  </div>`;
}
/** Tracking and resolved conversations sit apart from the open ones; neither is ever unread. */
export function threadSections(items: readonly ThreadSummary[]) {
  const newest = [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return {
    open: newest.filter((t) => t.state === 'open'),
    tracking: newest.filter((t) => t.state === 'tracking'),
    resolved: newest.filter((t) => t.state === 'resolved'),
  };
}
export function threadStatus(item: ThreadSummary) {
  if (item.state === 'resolved') return { verb: 'done' as const, label: 'Resolved' };
  if (item.state === 'tracking') return { verb: 'working' as const, label: 'Tracking' };
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
    ${sections.tracking.length > 0 && html`<details class="thread-resolved thread-tracking"><summary>Tracking (${sections.tracking.length})</summary>${list(sections.tracking)}</details>`}
    ${sections.resolved.length > 0 && html`<details class="thread-resolved"><summary>Resolved (${sections.resolved.length})</summary>${list(sections.resolved)}</details>`}
  </section>`;
}

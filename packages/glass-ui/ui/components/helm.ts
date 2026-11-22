import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ThreadSummary, ThreadView, ThreadEntry, ThreadAttachment, ThreadTrackedItem } from '@lobstah/core';
import type { ComponentChildren } from 'preact';
import { html } from '../html.js';
import { backend, fileUrl } from '../backend.js';
import { getState, viewOf } from '../store.js';
import type { PendingMessage } from '../store.js';
import { openDecision, openLightbox } from '../actions.js';
import { MarkdownElements } from './markdown.js';
import { closeThreadSheet, markThreadResponseSeen, openThread, reopenConversation, settlePendingMessages } from '../thread-actions.js';
import { safeHref } from '../../src/glass-markdown.js';
import { ThreadComposer } from './thread-composer.js';
import { Button } from './button.js';
import { SectionHead } from './section-head.js';
import { LinkedText } from './links.js';
import { Age, ImageThumb } from './common.js';
import { DecisionRow } from './decision-row.js';
import { InlineDecisionAnswer } from './decisions.js';
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
/**
 * A message's words as the glass's safe Markdown (bold, lists, code, links),
 * each newline kept as typed. Raw HTML stays text. An image it names by a bare
 * filename is one of the conversation's files; a remote image shows as a link.
 * Before the conversation holds the message (`thread` absent), an image shows
 * as its alt text.
 */
function MessageText({ text, thread }: { text: string; thread?: string }) {
  const image = (name: string, alt: string): ComponentChildren =>
    thread ? ImageThumb(fileUrl({ kind: 'thread', id: thread }, name), alt, 'mdimg') : alt;
  return html`<div class="thread-text mdpage"><${MarkdownElements} text=${text} image=${image} lineBreaks="typed" glassLinks copyCode openImage=${openLightbox} /></div>`;
}
const SYSTEM_EVENT: Record<string, string> = { thread: 'Discussion started', bait: 'Bait received' };
/** One entry of the conversation: the person on the right, the helm beside its wheel on the left. */
function Entry({ entry, view, at }: { entry: ThreadEntry; view: ThreadView; at: string }) {
  if ('card' in entry) {
    const card = view.cards.find((c) => c.key === entry.card);
    // A card replaced before it was answered is gone; its replacement follows in the conversation.
    if (!card) return null;
    const answer = card.answer
      ? html`<p class="thread-answer">${LinkedText([card.answer.option, card.answer.text].filter(Boolean).join(' · '))}</p>`
      : card.standing
        ? html`<${InlineDecisionAnswer} cardKey=${card.key} />`
        : html`<p class="dim">Closed card</p>`;
    return html`<article class="thread-entry thread-card-entry"><${WorkIcon} kind="card" />${card.standing ? html`<span class="badge warn">Card for you</span>` : null}<${Button} class="thread-card-title" onClick=${() => openDecision(card.key)}>${card.title}<//>${answer}${card.answer?.attachments.map((a) => html`<span class="dchip">${a.name}</span>`)}</article>`;
  }
  if ('link' in entry)
    return html`<div class="thread-entry thread-system"><${ThreadLink} kind=${entry.link} reference=${entry.ref} text=${entry.text} /></div>`;
  if ('event' in entry)
    return html`<p class="thread-entry thread-system dim">${entry.event === 'tracked' ? entry.text : (SYSTEM_EVENT[entry.kind] ?? 'Classified')} · ${Age(at)} ago</p>`;
  if (entry.by === 'helm') {
    const unread = entry.seq > (view.seenThrough ?? 0);
    return html`<article class=${'thread-entry thread-msg from-helm' + (unread ? ' unread' : '')}><span class="thread-avatar" aria-hidden="true">${HelmIcon}</span><div class="thread-bubble"><p class="thread-meta">Helm · ${Age(at)} ago${unread && html` · <span class="thread-new">New</span>`}</p>${entry.text && html`<${MessageText} text=${entry.text} thread=${view.id} />`}<${Files} view=${view} files=${entry.attachments} /></div></article>`;
  }
  return html`<article class="thread-entry thread-msg from-person"><div class="thread-bubble"><p class="thread-meta">You${entry.via === 'chat' ? ' · in chat' : entry.via === 'slack' ? ' · in Slack' : ''} · ${Age(at)} ago</p>${entry.text && html`<${MessageText} text=${entry.text} thread=${view.id} />`}<${Files} view=${view} files=${entry.attachments} /></div></article>`;
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
  const sent = (getState().pendingMessages ?? []).filter((m) => m.thread === id);
  useEffect(() => {
    if (view) settlePendingMessages(view);
  }, [view]);
  // A message this page sent shows until the loaded conversation holds it.
  const pending = view ? sent.filter((m) => !holdsSubmission(view, m.submission)) : sent;
  const body = usePinnedBottom(id, !!view || pending.length > 0);
  // The snapshot already names it, so the bar has its title before the conversation loads.
  const title =
    view?.title ?? getState().snapshot?.threads?.find((t) => t.id === id)?.title ?? (pending[0] && firstLine(pending[0])) ?? 'Conversation';
  const content = view
    ? html`<${Conversation} view=${view} pending=${pending} />`
    : pending.length > 0
      ? html`<div class="thread-view"><${SectionHead} title=${title} page /><div class="thread-timeline">${pending.map((m) => html`<${PendingEntry} key=${m.submission} message=${m} />`)}</div></div>`
      : error
        ? html`<p role="status">${error}</p>`
        : html`<p class="dim">Loading conversation</p>`;
  return html`<${Sheet} page=${id} title=${title} titleId="tsheet-title" cls="tsheet" onBack=${closeThreadSheet}>
    <div class="thread-sheet-body" ref=${body}>${content}</div>
  <//>`;
}
/** A new conversation's title, as the server will name it: the message's first line, or its first file. */
const firstLine = (m: PendingMessage) => (m.text.split('\n')[0] || m.files[0]?.name || 'Attachment').slice(0, 200);
/** Whether the conversation already holds the message this page sent as `submission`. */
const holdsSubmission = (view: ThreadView, submission: string) =>
  view.rounds.some((round) => round.entries.some((entry) => 'by' in entry && entry.by === 'person' && entry.submission === submission));
/** Words for a sent message's state, after "You". */
const PENDING_STATE: Record<PendingMessage['state'], string> = { sending: 'Sending', sent: 'Sent' };
/** A message this page sent, before its conversation holds it. */
function PendingEntry({ message }: { message: PendingMessage }) {
  return html`<article class=${`thread-entry thread-msg from-person pending-msg ${message.state}`} aria-busy=${message.state === 'sending'}>
    <div class="thread-bubble"><p class="thread-meta">You · ${PENDING_STATE[message.state]}</p>${message.text && html`<${MessageText} text=${message.text} />`}${message.files.map((f) => html`<span class="dchip">${f.name}</span>`)}</div>
  </article>`;
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
function Conversation({ view, pending = [] }: { view: ThreadView; pending?: readonly PendingMessage[] }) {
  return html`<div class="thread-view"><${SectionHead} title=${view.title} page />
    ${view.about && html`<${AboutDispatch} id=${view.about} />`}${Notes(view)}${Tracked(view)}
    ${view.rounds.length >= 6 && html`<p class="thread-hint dim">This is a long thread · A report can fill in missing facts or a plan can settle the approach</p>`}
    <${Timeline} view=${view} />${pending.length > 0 && html`<div class="thread-timeline">${pending.map((m) => html`<${PendingEntry} key=${m.submission} message=${m} />`)}</div>`}
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
/** The threads list's mark on a conversation the helm opened, beside its wheel. */
const HELM_STARTED = 'Started by the helm';
function ThreadCard({ item }: { item: ThreadSummary }) {
  const status = threadStatus(item);
  const preview =
    item.responseText === 'Notes updated' ? (item.openLine ?? item.responseText) : (item.responseText ?? item.openLine ?? status.label);
  const byHelm = item.startedBy === 'helm';
  return html`<${DecisionRow} title=${item.title} label=${`${item.unreadResponse ? 'Unread response: ' : ''}${item.title}${byHelm ? `, ${HELM_STARTED}` : ''}`} state=${item.unreadResponse ? 'unread' : 'read'}
    attrs=${{ 'data-thread': item.id, class: `drow thread-card ${item.unreadResponse ? 'unread' : 'read'}` }}
    prefix=${html`<span class="thread-state" role="img" aria-label=${status.label} title=${status.label}><span aria-hidden="true"><${VerbIcon} verb=${status.verb} /></span></span>`}
    preview=${preview} meta=${[byHelm && html`<span class="thread-starter">${HelmIcon}${HELM_STARTED}</span>`, byHelm && ' · ', item.grounds, ' · ', Age(item.updatedAt), ' ago']}
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

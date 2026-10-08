import type { Attachment, GlassDispatch, GlassDispatchSummary, GlassOlderKind, GlassPr, TendAttention } from '@lobstah/core';
import type { GlassTrapView as GlassTrap } from '../../../src/glass-diff.js';
import { useState } from 'preact/hooks';
import { dispatchFileUrl, isImageName, prBadgeClass, watchState } from '../../../src/glass-diff.js';
import type { DispatchDetail, ModalType } from '../../../src/glass-diff.js';
import { copyText, loadOlder, openLightbox, openTrapWindow, requestTrap, showModal } from '../actions.js';
import { getState } from '../store.js';
import { html } from '../html.js';
import type { Children } from '../html.js';
import { workerMetadata } from '../../../../../packages/core/src/worker-metadata.js';
import type { WorkerMetadata, WorkerConfig } from '@lobstah/core';

/** Shared pieces every section renders with: ages, tables, copyable commands, PR and kind badges. */

export const ageText = (iso: string | undefined | null): string => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return Math.round(s) + 's';
  if (s < 5400) return Math.round(s / 60) + 'm';
  if (s < 172800) return (s / 3600).toFixed(1) + 'h';
  return Math.round(s / 86400) + 'd';
};

/** An age ("3m"), recomputed each render; unchanged text leaves the node alone. */
export const Age = (iso: string | undefined | null) => html`<span data-age=${iso ?? ''}>${ageText(iso)}</span>`;

type WorkerInfo = { harness?: string | null; model?: string | null; config?: WorkerConfig; observedAt?: string };

/** Only the existing harness indicator at rest; model/effort on hover or focus. */
export function Harness({ worker, label, cls = 'badge' }: { worker: WorkerInfo; label?: Children; cls?: string }) {
  const w = workerMetadata(worker);
  const text = [w.model ?? 'model unknown', w.config.effort].filter(Boolean).join(' · ');
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const show = (e: Event) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 280)), top: r.bottom + 6 });
  };
  return html`<span class=${cls + ' worker-harness'} tabindex="0" aria-label=${text}
    onMouseEnter=${show} onFocus=${show} onBlur=${() => setPos(null)}
    onMouseLeave=${(e: Event) => {
      if (document.activeElement !== e.currentTarget) setPos(null);
    }}
    onKeyDown=${(e: KeyboardEvent) => {
      if (e.key === 'Escape') setPos(null);
    }}>
    ${label ?? w.harness ?? 'unknown harness'}${pos && !getState().modal && html`<span class="worker-tooltip" role="tooltip" aria-hidden="true" style=${pos}>${text}</span>`}
  </span>`;
}
export const WorkerIndicator = (x: Pick<GlassDispatchSummary, 'worker'>) => x.worker && html`<${Harness} worker=${x.worker} />`;

/** One details section in the modal, including headless launch observations. */
export function WorkerDetails({ worker, headless = false }: { worker: WorkerInfo | WorkerMetadata; headless?: boolean }) {
  const w = workerMetadata(worker);
  return html`<section class="worker-details"><div class="sec">${headless ? 'headless worker · launch / observation' : 'worker observation'}</div><dl>
    <dt>harness</dt><dd>${w.harness ?? 'unknown'}</dd>
    <dt>model</dt><dd>${w.model ?? 'model unknown'}</dd>
    <dt>effort</dt><dd>${w.config.effort ?? 'unknown'}</dd>
    <dt>permission mode</dt><dd>${w.config.permissionMode ?? 'unknown'}</dd>
    <dt>observed</dt><dd>${w.observedAt ?? 'unknown'}</dd>
  </dl></section>`;
}

/** The activity line under a dispatch's verb and note: what it is doing now, and how long ago. Stale shows dim. */
export const ActivityLine = (x: Pick<GlassDispatchSummary, 'activity'>) =>
  x.activity &&
  html`<div class=${'activity' + (x.activity.stale ? ' stale' : '')} title=${x.activity.stale ? 'no activity past the wedge threshold' : x.activity.kind}>${x.activity.stale ? 'stale · ' : ''}${x.activity.summary} · ${Age(x.activity.at)} ago</div>`;

/** An http(s) link, or undefined: the page never renders any other scheme as a link. */
const safeHref = (u: string | undefined): string | undefined => (u && /^https?:\/\//i.test(u) ? u : undefined);

/** `paused: waiting on review · 12m · <link>`: what the worker waits on outside lobstah, and for how long. */
export const WaitingLine = (x: Pick<GlassDispatchSummary, 'waiting' | 'verb'>) => {
  const w = x.waiting;
  if (!w) return undefined;
  const href = safeHref(w.link);
  let label = href;
  try {
    if (href) label = new URL(href).host + new URL(href).pathname.replace(/\/$/, '');
  } catch {
    label = href;
  }
  return html`<div class="waiting">${x.verb}: waiting on ${w.on} · ${Age(w.since)}${
    href && [' · ', html`<a href=${href} target="_blank" rel="noopener noreferrer" onClick=${stop}>${label}</a>`]
  }</div>`;
};

/**
 * A card badge of up to this many characters always shows whole. A longer one
 * carries the `long` class, may truncate with an ellipsis once the title has
 * reached its minimum, and keeps its full text in its title attribute.
 */
export const BADGE_WHOLE_CHARS = 12;
const longBadge = (text: string | undefined): boolean => text !== undefined && text.length > BADGE_WHOLE_CHARS;
export const badgeTitle = (text: string | undefined): string | undefined => (longBadge(text) ? text : undefined);
/** ' long' for a badge that may truncate, else ''. */
export const badgeLong = (text: string | undefined): string => (longBadge(text) ? ' long' : '');

/** A click handler that opens a modal (and never bubbles to a row that opens another). */
export const opener = (type: ModalType, key: string) => () => showModal(type, key);
export const stop = (e: Event) => e.stopPropagation();

const resumeCmd = (t: GlassTrap): string | undefined =>
  t.sessionId ? (t.harness === 'codex' ? 'codex resume ' : 'claude --resume ') + t.sessionId : undefined;

/** The same live-trap action and honest result wherever a trap is shown. */
export function windowAction(t: GlassTrap): Children {
  if (t.requested) return html`<span class="dim">Requested — no window yet</span>`;
  if (t.starting) return html`<span class="dim">${t.starting.failedAt ? 'Did not start' : 'Starting — no window yet'}</span>`;
  if (!t.live) {
    const command = resumeCmd(t);
    return command
      ? html`<span class="dim">Resume: <code onClick=${stop}>${command}</code></span>`
      : html`<span class="dim">Resume command unavailable</span>`;
  }
  const state = getState();
  if (!state.snapshot?.focusSupported && !t.link) return html`<span class="dim">Window focus is not supported here</span>`;
  const clicked = (e: Event) => {
    stop(e);
    void openTrapWindow(t.trapId);
  };
  return html`<span class="winaction"><button class="btn open" title="open this trap's window" onClick=${clicked}>↗ open</button>${t.link && [' ', html`<a href=${t.link} onClick=${stop}>Session link</a>`]}${
    state.focusResults[t.trapId] && [' ', html`<span class="dim">${state.focusResults[t.trapId]}</span>`]
  }</span>`;
}

export function Table(headers: readonly string[], rows: Children[], empty: string) {
  if (!rows.length) return html`<div class="empty">${empty}</div>`;
  return html`<div class="wrap"><table><tbody><tr>${headers.map((h) => html`<th>${h}</th>`)}</tr>${rows}</tbody></table></div>`;
}

/** Paging in history /data leaves out: how many are left, and whether a page is on its way. */
export interface OlderControl {
  left: number;
  loading: boolean;
  error?: string;
}

/** `show 50 older (of 212)` under a list whose history pages in; nothing when none is left. */
export function ShowOlder({ kind, more }: { kind: GlassOlderKind; more: OlderControl }) {
  if (!more.left && !more.error) return null;
  return html`<div class="older">${
    more.left > 0 &&
    html`<button class="btn" disabled=${more.loading} onClick=${() => void loadOlder(kind)}>${
      more.loading ? 'loading…' : `show ${Math.min(more.left, 50)} older (of ${more.left})`
    }</button>`
  }${more.error && html` <span class="bad">${more.error}</span>`}</div>`;
}

/** A command the reader copies (the glass never runs anything): click the text or ⧉. */
function CmdRow({ text }: { text: string }) {
  const [copied, setCopied] = useState<'code' | 'button' | null>(null);
  const copy = (which: 'code' | 'button') => async () => {
    if (!(await copyText(text))) return;
    setCopied(which);
    setTimeout(() => setCopied(null), 1000);
  };
  return html`<div class="cmd"><code class=${copied === 'code' ? 'copied' : undefined} title="click to copy" onClick=${copy('code')}>${text}</code><button title="copy" onClick=${copy('button')}>${copied === 'button' ? '✓' : '⧉'}</button></div>`;
}
export const cmdRow = (text: string, key?: string) => html`<${CmdRow} key=${key} text=${text} />`;

/** A clickable image that opens in the in-page overlay. */
export const ImageThumb = (src: string, name: string, cls = 'thumb') =>
  html`<button
    type="button"
    class=${cls}
    title=${'view ' + name}
    onClick=${(e: Event) => {
      stop(e);
      openLightbox(src, name);
    }}
  >
    <img src=${src} alt=${name} loading="lazy" />
  </button>`;

/**
 * Attachment rows: name, type, size, and the path to copy. With `fileUrl`
 * (where the glass serves this list's files), an image also shows a thumb
 * that opens in the overlay.
 */
export const attachmentRows = (items: readonly Attachment[], fileUrl?: (name: string) => string) =>
  items.map((a) => [
    html`<div class="sub">${a.name} · ${a.type} · ${a.bytes} bytes</div>`,
    fileUrl && isImageName(a.name) && ImageThumb(fileUrl(a.name), a.name),
    cmdRow(a.path),
  ]);

/** A `wt:<id>` address in free text. */
const TRAP_ADDRESS = /\bwt:([a-z0-9][a-z0-9-]*)/g;

/** The trap's name from the snapshot (the live registration's, else the name registry's), if known. */
const knownTrapName = (trapId: string): string | undefined => getState().snapshot?.trapNames?.[trapId];

/** Text with each `wt:<id>` shown by the trap's name; `wt:<id>` stays where no name is known. */
export const namedText = (text: string): string =>
  text.replace(TRAP_ADDRESS, (whole: string, id: string, at: number) => {
    const name = knownTrapName(id);
    return name && !labelled(text, at, whole.length, name) ? name : whole;
  });

/** The address at `at` already sits in its label, `<name> (wt:<id>)`: the name is shown. */
const labelled = (text: string, at: number, length: number, name: string): boolean =>
  text.slice(Math.max(0, at - name.length - 2), at) === `${name} (` && text[at + length] === ')';

/** A trap shown by name, its full `wt:<id>` in the title. A click opens the trap's modal. */
export function TrapName(trapId: string): Children {
  const address = 'wt:' + trapId;
  const name = knownTrapName(trapId) ?? address;
  if (!getState().snapshot?.traps.some((t) => t.trapId === trapId)) return html`<span class="trapname" title=${address}>${name}</span>`;
  const open = (e: Event) => {
    e.preventDefault();
    stop(e);
    showModal('trap', trapId);
  };
  return html`<a class="trapname" href="#traps" title=${address} onClick=${open}>${name}</a>`;
}

/** A worker address: a `wt:<id>` shows as TrapName; any other address shows as it is. */
export const WorkerAddress = (address: string): Children => {
  const m = /^wt:([a-z0-9][a-z0-9-]*)$/.exec(address);
  return m ? TrapName(m[1]!) : address;
};

/**
 * Free text with each `wt:<id>` shown as TrapName. Past `max` shown
 * characters it is cut with an ellipsis, counting names as shown.
 */
export function NamedText(text: string, max = Infinity): Children[] {
  const parts: Array<{ text: string; trapId?: string }> = [];
  let last = 0;
  for (const m of text.matchAll(TRAP_ADDRESS)) {
    if (m.index! > last) parts.push({ text: text.slice(last, m.index) });
    const name = knownTrapName(m[1]!);
    parts.push(name && labelled(text, m.index!, m[0].length, name) ? { text: m[0] } : { text: name ?? m[0], trapId: m[1] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  const total = parts.reduce((n, p) => n + p.text.length, 0);
  let budget = total > max ? max - 1 : Infinity;
  const out: Children[] = [];
  for (const p of parts) {
    if (budget <= 0) break;
    if (p.text.length <= budget) out.push(p.trapId ? TrapName(p.trapId) : p.text);
    else out.push(p.text.slice(0, budget));
    budget -= p.text.length;
  }
  if (total > max) out.push('…');
  return out;
}

/** A dispatch's status log, one line per entry, each trap shown by name that opens its modal. */
export const LogLines = (x: Pick<GlassDispatch, 'log'>): Children[] =>
  x.log.flatMap((e, i) => [i ? '\n' : '', e.at + '  ' + e.verb, ...(e.note ? ['  ', ...NamedText(e.note)] : [])]);

/** Whether a dispatch modal's item has its detail: the brief, log, and full evidence. */
export const hasDetail = (x: GlassDispatchSummary | GlassDispatch): x is GlassDispatch => 'brief' in x;

export function detailBody(x: GlassDispatchSummary | GlassDispatch, detail?: DispatchDetail | null) {
  const progress = [
    x.elapsed && `elapsed: ${x.elapsed}`,
    x.attempt && `attempt: ${x.attempt}`,
    x.branch && `branch: ${x.branch}`,
    x.lastCommit && `last commit: ${x.lastCommit}`,
    x.aheadTrunk && `commits: ${x.aheadTrunk}`,
    x.draftPr && `draft PR: ${x.draftPr}`,
    x.updated && `updated: ${x.updated}`,
  ]
    .filter(Boolean)
    .join('\n');
  const head = html`${x.waiting && [html`<div class="sec">waiting</div>`, WaitingLine(x)]}${x.activity && [html`<div class="sec">activity</div>`, ActivityLine(x)]}${progress && [html`<div class="sec">progress</div>`, html`<pre>${progress}</pre>`]}`;
  // The brief, log, inbox, and evidence come with the detail, fetched when the modal opens.
  // Worker fields have a single labeled section above; don't repeat them in
  // the raw evidence dump. Leave all other evidence intact.
  const evidence: Record<string, unknown> | undefined = x.evidence && { ...x.evidence };
  if (evidence?.worker) {
    delete evidence.worker;
    delete evidence.harness;
  }
  if (!hasDetail(x))
    return html`${head}<div class="sec">brief</div><div class=${detail?.error ? 'bad' : 'dim'}>${detail?.error ?? 'loading…'}</div>${
      x.followUp && [html`<div class="sec">forks</div>`, html`<pre>${x.followUp}</pre>`]
    }${x.note && [html`<div class="sec">last note</div>`, html`<div class="loglines">${NamedText(x.note)}</div>`]}`;
  return html`${head}<div class="sec">brief</div><pre>${x.brief}</pre>${
    x.attachments.length > 0 && [
      html`<div class="sec">attachments (${x.attachments.length})</div>`,
      attachmentRows(x.attachments, (name) => dispatchFileUrl(x.lane, x.id, name)),
    ]
  }${
    x.messageAttachments.length > 0 && [
      html`<div class="sec">message attachments (${x.messageAttachments.length})</div>`,
      attachmentRows(x.messageAttachments, (name) => dispatchFileUrl(x.lane, x.id, name)),
    ]
  }${x.followUp && [html`<div class="sec">forks</div>`, html`<pre>${x.followUp}</pre>`]}<div class="sec">log</div><div class="loglines">${
    x.log.length ? LogLines(x) : 'no entries yet'
  }</div>${x.inbox.length > 0 && [html`<div class="sec">inbox</div>`, html`<div class="loglines">${x.inbox.join('\n---\n')}</div>`]}${
    x.awaitingReply && [
      html`<div class="sec">awaiting reply</div>`,
      html`<div>${x.awaitingReply.line} · from ${x.awaitingReply.from} · ${Age(x.awaitingReply.sentAt)} ago</div>`,
    ]
  }${evidence && [html`<div class="sec">evidence</div>`, html`<div class="loglines">${JSON.stringify(evidence)}</div>`]}`;
}

export function addrCell(x: GlassDispatchSummary) {
  if (x.for)
    return [
      WorkerAddress(x.for),
      x.evidence && x.evidence.deliveredTo
        ? [' ', html`<span class="ok">✓delivered</span>`]
        : [' ', html`<span class="warn">waiting</span>`],
    ];
  return x.claimedBy ? WorkerAddress(x.claimedBy) : '';
}

export function prCell(x: GlassDispatchSummary) {
  // Several PRs: each in stack order with its own state; one not yet observed shows none.
  if (x.prList && x.prList.length > 1) {
    return [
      x.prList.map((p, i) => [
        i ? ' → ' : '',
        html`<a href=${p.url} target="_blank" rel="noopener" onClick=${stop}>#${p.number}</a>`,
        p.badge && [' ', html`<span class=${'badge ' + prBadgeClass(p.badge)}>${p.badge.text}</span>`],
      ]),
      x.prGate && [' ', html`<span class="badge dim" title="merge gate (pick)">${x.prGate}</span>`],
    ];
  }
  const url = x.evidence && (x.evidence.prUrl || (x.evidence.pr && x.evidence.pr.url));
  if (!url) return '';
  const b = x.prBadge;
  const many = x.evidence && x.evidence.prUrls && x.evidence.prUrls.length > 1 ? x.evidence.prUrls : undefined;
  return [
    many
      ? many.map((u, i) => [i ? ' ' : '', html`<a href=${u} target="_blank" rel="noopener" onClick=${stop}>#${u.split('/').pop()}</a>`])
      : html`<a href=${url} target="_blank" rel="noopener" onClick=${stop}>PR</a>`,
    b && [' ', html`<span class=${'badge ' + prBadgeClass(b)} title=${'observed ' + b.observedAt}>${b.text}</span>`],
    x.prGate && [' ', html`<span class="badge dim" title="merge gate (pick)">${x.prGate}</span>`],
  ];
}

// Attention kinds (tend's contract): the short label shown in lobs, the pet, and the table.
export const KIND_LABEL: Record<string, string> = {
  'pr:draft': 'draft',
  'pr:review': 'review',
  'pr:checks': 'checks',
  'pr:conflict': 'conflicts',
  'pr:ready': 'ready',
  'stack-ready': 'stack',
  landed: 'landed',
  watch: 'watch',
};
export const KIND_TONE: Record<string, string> = {
  'pr:review': 'bad',
  'pr:checks': 'bad',
  'pr:conflict': 'pr-conflicts',
  'pr:ready': 'ok',
  'stack-ready': 'ok',
  'pr:draft': 'dim',
  watch: 'warn',
};
export const kindLabel = (k: string): string => KIND_LABEL[k] || '';

export function kindCell(x: Pick<TendAttention, 'kind' | 'verb'>) {
  if (x.kind === 'question') return html`<span class=${'v-' + x.verb}>${x.verb}</span>`;
  const tone = x.kind === 'landed' ? (x.verb === 'failed' ? 'bad' : 'ok') : KIND_TONE[x.kind] || 'dim';
  return [
    html`<span class=${'badge ' + tone}>${kindLabel(x.kind) || x.kind}</span>`,
    x.kind === 'landed' && [' ', html`<span class="dim">${x.verb}</span>`],
  ];
}

export const prLink = (p: Pick<GlassPr, 'url' | 'number'>) =>
  html`<a href=${p.url} target="_blank" rel="noopener" onClick=${stop}>#${p.number}</a>`;

/** A PR card's name: the number bold, then the title; the number alone when there is no title. One line, cut with an ellipsis. */
export const prName = (p: Pick<GlassPr, 'number' | 'title'>) =>
  html`<span class="prname" title=${p.title || undefined}><b>#${p.number}</b>${p.title && [' ', p.title]}</span>`;

/** A stack's numbers, `#98 → #101`, each carrying its PR's title as a title attribute. `bold` marks one number. */
export function stackNumbers(numbers: number[], titles: Map<number, string | undefined>, bold?: number) {
  return numbers.flatMap((n, i) => {
    const t = titles.get(n) || undefined;
    const num = n === bold ? html`<b title=${t}>#${n}</b>` : html`<span title=${t}>#${n}</span>`;
    return i ? [' → ', num] : [num];
  });
}

export function prChecks(p: Pick<GlassPr, 'checks'>): string {
  const c = p.checks;
  return (
    c.passed +
    '/' +
    c.total +
    ' passed' +
    (c.failed ? ' · ' + c.failed + ' failed' : '') +
    (c.pending ? ' · ' + c.pending + ' pending' : '')
  );
}

export function prReview(p: Pick<GlassPr, 'review' | 'reviewDecision'>): string {
  const r: Partial<NonNullable<GlassPr['review']>> = p.review || {};
  return (
    (p.reviewDecision || '') +
    (r.unresolvedThreads ? ' · ' + r.unresolvedThreads + ' unresolved' : '') +
    (r.changesRequested ? ' · changes requested' : '')
  );
}

export function prMerge(p: Pick<GlassPr, 'mergeStateStatus' | 'nextMergeable' | 'blockedBy'>) {
  return [
    p.mergeStateStatus,
    p.nextMergeable ? [' · ', html`<span class="ok">next mergeable</span>`] : p.blockedBy ? ' · blocked by #' + p.blockedBy : '',
  ];
}

export function watchCell(w: GlassPr['watch']) {
  const ws = watchState(w);
  return w ? [ws.text, ' · ', ws.at ? [Age(ws.at), ' ago'] : 'never checked'] : html`<span class="dim">${ws.text}</span>`;
}

export interface TrapRowView {
  stale: boolean;
  listen: Children;
  hb: Children;
}

export function trapRow(t: GlassTrap): TrapRowView {
  if (t.requested)
    return {
      stale: false,
      listen: [html`<span class="dot"></span>`, html`<span class="dim">requested</span>`],
      hb: html`<span class="dim">—</span>`,
    };
  if (t.starting)
    return {
      stale: false,
      listen: t.starting.failedAt
        ? [html`<span class="dot bad"></span>`, html`<span class="bad">start failed</span>`]
        : [html`<span class="dot warn"></span>`, 'starting'],
      hb: html`<span class="dim">—</span>`,
    };
  if (!t.live)
    return {
      stale: false,
      listen: [html`<span class="dot"></span>`, html`<span class="dim">signed off</span>`],
      hb: html`<span class="dim">—</span>`,
    };
  const stale = Date.now() - Date.parse(t.heartbeatAt!) > 1800000;
  const listening = t.listening ?? (!!t.firstParkedAt && !stale);
  return {
    stale,
    listen: listening ? [html`<span class="dot ok"></span>`, 'listening'] : [html`<span class="dot warn"></span>`, 'not listening'],
    hb: html`<span class=${stale ? 'bad' : 'ok'}>${stale && 'stale '}${Age(t.heartbeatAt)} ago</span>`,
  };
}

/** A trap's state: starting, start failed, signed off, idle (listening or not), parked on a wait, or working a catch. */
type TrapState =
  | { kind: 'requested'; helmOn: boolean }
  | { kind: 'starting'; deadline: string }
  | { kind: 'start failed'; reason: string }
  | { kind: 'signed off' }
  | { kind: 'idle'; listening: boolean }
  | { kind: 'parked'; current: GlassDispatchSummary }
  | { kind: 'working'; current: GlassDispatchSummary };

function trapState(t: GlassTrap): TrapState {
  if (t.requested) return { kind: 'requested', helmOn: !!getState().snapshot?.helmOn };
  if (t.starting)
    return t.starting.failedAt
      ? { kind: 'start failed', reason: t.starting.reason ?? 'no session signed on in time' }
      : { kind: 'starting', deadline: t.starting.deadline };
  if (!t.live) return { kind: 'signed off' };
  const current = t.claimed ? t.catches.find((c) => c.id === t.claimed && c.bucket === 'active') : undefined;
  if (!current)
    return { kind: 'idle', listening: t.listening ?? (!!t.firstParkedAt && Date.now() - Date.parse(t.heartbeatAt ?? '') <= 1800000) };
  if (current.waiting || current.verb === 'paused') return { kind: 'parked', current };
  return { kind: 'working', current };
}

/** The state dot's tone: green working or listening, amber parked or starting, red start failed, grey not listening or signed off. */
export function trapDotTone(t: GlassTrap): 'ok' | 'warn' | 'bad' | 'dim' {
  const s = trapState(t);
  if (s.kind === 'working' || (s.kind === 'idle' && s.listening)) return 'ok';
  if (s.kind === 'start failed') return 'bad';
  return s.kind === 'parked' || s.kind === 'starting' ? 'warn' : 'dim';
}

const parkedText = (c: GlassDispatchSummary) => (c.waiting ? `waiting on ${c.waiting.on}` : c.note || 'waiting');
const workTitle = (c: GlassDispatchSummary) => c.title.slice(0, 40) || '(no title)';

/** One current activity line for deck and traps tab, from the shared snapshot, led by the state dot. */
export function trapNow(t: GlassTrap): Children {
  const s = trapState(t);
  const dot = html`<span class=${'dot trapdot ' + trapDotTone(t)}></span>`;
  if (s.kind === 'requested') return [dot, html`<span class="dim">${requestedText(t, s.helmOn)}</span>`];
  if (s.kind === 'starting') return [dot, 'starting · waiting for its session to sign on'];
  if (s.kind === 'start failed') return [dot, html`<span class="bad">start failed</span>`, ' · ', s.reason];
  if (s.kind === 'signed off') return [dot, html`<span class="dim">signed off</span>`];
  if (s.kind === 'idle') return [dot, 'idle · ', s.listening ? 'listening' : 'not listening'];
  const current = s.current;
  if (s.kind === 'parked') return [dot, 'parked · ', parkedText(current)];
  const openDispatch = (event: MouseEvent) => {
    event.preventDefault();
    stop(event);
    showModal('dispatch', `${current.lane}:${current.id}`);
  };
  return [
    dot,
    'working · ',
    html`<a href="#dispatches" onClick=${openDispatch}>${current.id.slice(0, 8)}</a>`,
    ' · ',
    workTitle(current),
    current.activity && [' · ', current.activity.summary, ' ', Age(current.activity.at), ' ago'],
  ];
}

const requestedText = (t: GlassTrap, helmOn: boolean): string =>
  `requested · ${t.repo ?? ''} · ${t.harness ?? ''} · ${helmOn ? 'waiting for the helm' : 'waiting for a helm'}`;

/** A reserved trap's start commands, each copyable: the way to start it by hand. Only a starting card has them. */
export function startCommands(t: GlassTrap): Children {
  const commands = t.starting?.commands;
  if (!commands?.length) return null;
  return html`<div class="startcmds" onClick=${stop}><div class="dim">start it: run one in a terminal</div>${commands.map((c) => cmdRow(c.command, c.harness))}</div>`;
}

/** The New trap button and its form: a repo and a harness, filed as a request for the helm. */
export function NewTrap() {
  const d = getState().snapshot;
  const repos = d?.repoKeys ?? [];
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState('');
  const [harness, setHarness] = useState('claude');
  const [result, setResult] = useState<string | null>(null);
  const chosen = repo || repos[0] || '';
  const submit = async (e: Event) => {
    e.preventDefault();
    const error = await requestTrap(chosen, harness);
    setResult(error ?? null);
    if (!error) setOpen(false);
  };
  if (!open)
    return html`<span class="newtrap"><button class="btn" onClick=${(e: Event) => (stop(e), setOpen(true), setResult(null))}>+ New trap</button></span>`;
  return html`<form class="newtrap" onClick=${stop} onSubmit=${submit}>
    <label>repo <select name="repo" value=${chosen} onChange=${(e: Event) => setRepo((e.target as HTMLSelectElement).value)}>${repos.map((r) => html`<option value=${r}>${r}</option>`)}</select></label>
    <label>harness <select name="harness" value=${harness} onChange=${(e: Event) => setHarness((e.target as HTMLSelectElement).value)}><option value="claude">claude</option><option value="codex">codex</option></select></label>
    <button class="btn" type="submit" disabled=${!chosen}>Request</button>
    <button class="btn" type="button" onClick=${() => setOpen(false)}>Cancel</button>
    ${result && html`<span class="bad">${result}</span>`}
  </form>`;
}

/** trapNow as plain text: the hover title of a clamped meta line. */
export function trapNowText(t: GlassTrap): string {
  const s = trapState(t);
  if (s.kind === 'requested') return requestedText(t, s.helmOn);
  if (s.kind === 'starting') return `starting · sign-on due by ${s.deadline}`;
  if (s.kind === 'start failed') return `start failed · ${s.reason}`;
  if (s.kind === 'signed off') return 'signed off';
  if (s.kind === 'idle') return `idle · ${s.listening ? 'listening' : 'not listening'}`;
  if (s.kind === 'parked') return `parked · ${parkedText(s.current)}`;
  const current = s.current;
  return [
    `working · ${current.id.slice(0, 8)} · ${workTitle(current)}`,
    current.activity && `${current.activity.summary} ${ageText(current.activity.at)} ago`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A trap's mail count, or null when it has none. */
export function mailCell(t: GlassTrap) {
  const p = t.messages.filter((m) => m.state === 'pending').length;
  return t.messages.length ? ['✉ ' + t.messages.length, p > 0 && [' ', html`<span class="warn">(${p} pending)</span>`]] : null;
}

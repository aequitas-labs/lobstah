import type { Attachment, GlassDispatch, GlassPr, GlassTrap, TendAttention } from '@lobstah/core';
import { useState } from 'preact/hooks';
import { prBadgeClass, watchState } from '../../../src/glass-diff.js';
import type { ModalType } from '../../../src/glass-diff.js';
import { copyText, openTrapWindow, showModal } from '../actions.js';
import { getState } from '../store.js';
import { html } from '../html.js';
import type { Children } from '../html.js';

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

/** The activity line under a dispatch's verb and note: what it is doing now, and how long ago. Stale shows dim. */
export const ActivityLine = (x: Pick<GlassDispatch, 'activity'>) =>
  x.activity &&
  html`<div class=${'activity' + (x.activity.stale ? ' stale' : '')} title=${x.activity.stale ? 'no activity past the wedge threshold' : x.activity.kind}>${x.activity.stale ? 'stale · ' : ''}${x.activity.summary} · ${Age(x.activity.at)} ago</div>`;

/** An http(s) link, or undefined: the page never renders any other scheme as a link. */
const safeHref = (u: string | undefined): string | undefined => (u && /^https?:\/\//i.test(u) ? u : undefined);

/** `paused: waiting on review · 12m · <link>`: what the worker waits on outside lobstah, and for how long. */
export const WaitingLine = (x: Pick<GlassDispatch, 'waiting' | 'verb'>) => {
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

export const attachmentRows = (items: readonly Attachment[]) =>
  items.map((a) => [html`<div class="sub">${a.name} · ${a.type} · ${a.bytes} bytes</div>`, cmdRow(a.path)]);

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

export function detailBody(x: GlassDispatch) {
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
  return html`${x.waiting && [html`<div class="sec">waiting</div>`, WaitingLine(x)]}${x.activity && [html`<div class="sec">activity</div>`, ActivityLine(x)]}${progress && [html`<div class="sec">progress</div>`, html`<pre>${progress}</pre>`]}<div class="sec">brief</div><pre>${x.brief}</pre>${
    x.attachments.length > 0 && [html`<div class="sec">attachments (${x.attachments.length})</div>`, attachmentRows(x.attachments)]
  }${
    x.messageAttachments.length > 0 && [
      html`<div class="sec">message attachments (${x.messageAttachments.length})</div>`,
      attachmentRows(x.messageAttachments),
    ]
  }${x.followUp && [html`<div class="sec">forks</div>`, html`<pre>${x.followUp}</pre>`]}<div class="sec">log</div><div class="loglines">${
    x.log.length ? LogLines(x) : 'no entries yet'
  }</div>${x.inbox.length > 0 && [html`<div class="sec">inbox</div>`, html`<div class="loglines">${x.inbox.join('\n---\n')}</div>`]}${
    x.awaitingReply && [
      html`<div class="sec">awaiting reply</div>`,
      html`<div>${x.awaitingReply.line} · from ${x.awaitingReply.from} · ${Age(x.awaitingReply.sentAt)} ago</div>`,
    ]
  }${x.evidence && [html`<div class="sec">evidence</div>`, html`<div class="loglines">${JSON.stringify(x.evidence)}</div>`]}`;
}

export function addrCell(x: GlassDispatch) {
  if (x.for)
    return [
      WorkerAddress(x.for),
      x.evidence && x.evidence.deliveredTo
        ? [' ', html`<span class="ok">✓delivered</span>`]
        : [' ', html`<span class="warn">waiting</span>`],
    ];
  return x.claimedBy ? WorkerAddress(x.claimedBy) : '';
}

export function prCell(x: GlassDispatch) {
  const url = x.evidence && (x.evidence.prUrl || (x.evidence.pr && x.evidence.pr.url));
  if (!url) return '';
  const b = x.prBadge;
  return [
    html`<a href=${url} target="_blank" rel="noopener" onClick=${stop}>PR</a>`,
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
  landed: 'landed',
  watch: 'watch',
};
export const KIND_TONE: Record<string, string> = {
  'pr:review': 'bad',
  'pr:checks': 'bad',
  'pr:conflict': 'pr-conflicts',
  'pr:ready': 'ok',
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
  | { kind: 'starting'; deadline: string }
  | { kind: 'start failed'; reason: string }
  | { kind: 'signed off' }
  | { kind: 'idle'; listening: boolean }
  | { kind: 'parked'; current: GlassDispatch }
  | { kind: 'working'; current: GlassDispatch };

function trapState(t: GlassTrap): TrapState {
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

const parkedText = (c: GlassDispatch) => (c.waiting ? `waiting on ${c.waiting.on}` : c.note || 'waiting');
const workTitle = (c: GlassDispatch) => c.brief.split(/\r?\n/, 1)[0]?.trim().slice(0, 40) || '(no title)';

/** One current activity line for deck and traps tab, from the shared snapshot, led by the state dot. */
export function trapNow(t: GlassTrap): Children {
  const s = trapState(t);
  const dot = html`<span class=${'dot trapdot ' + trapDotTone(t)}></span>`;
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

/** trapNow as plain text: the hover title of a clamped meta line. */
export function trapNowText(t: GlassTrap): string {
  const s = trapState(t);
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

import type { Attachment, GlassDispatch, GlassPr, GlassTrap, TendAttention } from '@lobstah/core';
import { useState } from 'preact/hooks';
import { prBadgeClass, watchState } from '../../../src/glass-diff.js';
import type { ModalType } from '../../../src/glass-diff.js';
import { copyText, showModal } from '../actions.js';
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

/** A click handler that opens a modal (and never bubbles to a row that opens another). */
export const opener = (type: ModalType, key: string) => () => showModal(type, key);
export const stop = (e: Event) => e.stopPropagation();

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

/** A dispatch's status log, one line per entry. */
export const logText = (x: Pick<GlassDispatch, 'log'>): string =>
  x.log.map((e) => e.at + '  ' + e.verb + (e.note ? '  ' + e.note : '')).join('\n');

export function detailBody(x: GlassDispatch) {
  return html`<div class="sec">brief</div><pre>${x.brief}</pre>${
    x.attachments.length > 0 && [html`<div class="sec">attachments (${x.attachments.length})</div>`, attachmentRows(x.attachments)]
  }${
    x.messageAttachments.length > 0 && [
      html`<div class="sec">message attachments (${x.messageAttachments.length})</div>`,
      attachmentRows(x.messageAttachments),
    ]
  }${x.followUp && [html`<div class="sec">forks</div>`, html`<pre>${x.followUp}</pre>`]}<div class="sec">log</div><div class="loglines">${
    x.log.length ? logText(x) : 'no entries yet'
  }</div>${x.inbox.length > 0 && [html`<div class="sec">inbox</div>`, html`<div class="loglines">${x.inbox.join('\n---\n')}</div>`]}${
    x.evidence && [html`<div class="sec">evidence</div>`, html`<div class="loglines">${JSON.stringify(x.evidence)}</div>`]
  }`;
}

export function addrCell(x: GlassDispatch) {
  if (x.for)
    return [
      x.for,
      x.evidence && x.evidence.deliveredTo
        ? [' ', html`<span class="ok">✓delivered</span>`]
        : [' ', html`<span class="warn">waiting</span>`],
    ];
  return x.claimedBy ? x.claimedBy : '';
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
  if (!t.live)
    return {
      stale: false,
      listen: [html`<span class="dot"></span>`, html`<span class="dim">signed off</span>`],
      hb: html`<span class="dim">—</span>`,
    };
  const stale = Date.now() - Date.parse(t.heartbeatAt!) > 1800000;
  return {
    stale,
    listen: t.firstParkedAt ? [html`<span class="dot ok"></span>`, 'listening'] : [html`<span class="dot warn"></span>`, 'never parked'],
    hb: html`<span class=${stale ? 'bad' : 'ok'}>${stale && 'stale '}${Age(t.heartbeatAt)} ago</span>`,
  };
}

/** A trap's mail count, or null when it has none. */
export function mailCell(t: GlassTrap) {
  const p = t.messages.filter((m) => m.state === 'pending').length;
  return t.messages.length ? ['✉ ' + t.messages.length, p > 0 && [' ', html`<span class="warn">(${p} pending)</span>`]] : null;
}

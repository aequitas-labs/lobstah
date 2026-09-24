import type { Attachment, GlassDispatch, GlassPr, GlassTrap, TendAttention } from '@lobstah/core';
import { prBadgeClass, watchState } from '../../../src/glass-diff.js';
import { esc, html, join, raw } from '../html.js';
import type { Html, Part } from '../html.js';

/** Shared pieces every section renders with: ages, tables, copyable commands, PR and kind badges. */

export const age = (iso: string | undefined | null): string => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return Math.round(s) + 's';
  if (s < 5400) return Math.round(s / 60) + 'm';
  if (s < 172800) return (s / 3600).toFixed(1) + 'h';
  return Math.round(s / 86400) + 'd';
};

// Ages tick in place (refreshAges) so a quiet section never needs a rewrite.
export const ageEl = (iso: string | undefined | null): Html => html`<span data-age="${iso}">${age(iso)}</span>`;

export function refreshAges(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-age]')) {
    const t = age(el.dataset.age);
    if (el.textContent !== t) el.textContent = t;
  }
}

export function table(headers: readonly string[], rows: readonly Part[], empty: string): Html {
  if (!rows.length) return html`<div class="empty">${empty}</div>`;
  return html`<div class="wrap"><table><tr>${headers.map((h) => html`<th>${h}</th>`)}</tr>${rows}</table></div>`;
}

/** A command the reader copies (the glass never runs anything). */
export function cmdRow(text: string): Html {
  const j = raw(JSON.stringify(text).replace(/"/g, '&quot;'));
  return html`<div class="cmd"><code title="click to copy" onclick="copyCmd(this,${j})">${text}</code><button title="copy" onclick="copyCmd(this,${j})">⧉</button></div>`;
}

export function attachmentRows(items: readonly Attachment[]): Html {
  return join(items.map((a) => html`<div class="sub">${a.name} · ${a.type} · ${a.bytes} bytes</div>${cmdRow(a.path)}`));
}

/** A dispatch's status log, one line per entry. */
export const logText = (x: Pick<GlassDispatch, 'log'>): Html =>
  raw(x.log.map((e) => esc(e.at) + '  ' + esc(e.verb) + (e.note ? '  ' + esc(e.note) : '')).join('\n'));

export function detailBody(x: GlassDispatch): Html {
  const attachments =
    x.attachments.length > 0 && html`<div class="sec">attachments (${x.attachments.length})</div>${attachmentRows(x.attachments)}`;
  const messageAttachments =
    x.messageAttachments.length > 0 &&
    html`<div class="sec">message attachments (${x.messageAttachments.length})</div>${attachmentRows(x.messageAttachments)}`;
  const forks = x.followUp && html`<div class="sec">forks</div><pre>${x.followUp}</pre>`;
  const inbox =
    x.inbox.length > 0 && html`<div class="sec">inbox</div><div class="loglines">${raw(x.inbox.map(esc).join('\n---\n'))}</div>`;
  const evidence = x.evidence && html`<div class="sec">evidence</div><div class="loglines">${JSON.stringify(x.evidence)}</div>`;
  return html`<div class="sec">brief</div><pre>${x.brief}</pre>${attachments}${messageAttachments}${forks}<div class="sec">log</div><div class="loglines">${x.log.length ? logText(x) : 'no entries yet'}</div>${inbox}${evidence}`;
}

export function addrCell(x: GlassDispatch): Html {
  if (x.for)
    return html`${x.for}${x.evidence && x.evidence.deliveredTo ? raw(' <span class="ok">✓delivered</span>') : raw(' <span class="warn">waiting</span>')}`;
  return html`${x.claimedBy ? x.claimedBy : ''}`;
}

export function prCell(x: GlassDispatch): Html {
  const url = x.evidence && (x.evidence.prUrl || (x.evidence.pr && x.evidence.pr.url));
  if (!url) return raw('');
  const b = x.prBadge;
  const badge = b && html` <span class="badge ${prBadgeClass(b)}" title="observed ${b.observedAt}">${b.text}</span>`;
  const gate = x.prGate && html` <span class="badge dim" title="merge gate (pick)">${x.prGate}</span>`;
  return html`<a href="${url}" target="_blank" rel="noopener" onclick="event.stopPropagation()">PR</a>${badge}${gate}`;
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

export function kindCell(x: Pick<TendAttention, 'kind' | 'verb'>): Html {
  if (x.kind === 'question') return html`<span class="v-${x.verb}">${x.verb}</span>`;
  const tone = x.kind === 'landed' ? (x.verb === 'failed' ? 'bad' : 'ok') : KIND_TONE[x.kind] || 'dim';
  return html`<span class="badge ${tone}">${kindLabel(x.kind) || x.kind}</span>${x.kind === 'landed' && html` <span class="dim">${x.verb}</span>`}`;
}

/** Inline handlers that open a modal; the key is escaped once, here. */
export const openDispatch = (lane: string, id: string): Html => raw("showModal('dispatch','" + esc(lane + ':' + id) + "')");
export const openTrap = (trapId: string): Html => raw("showModal('trap','" + esc(trapId) + "')");
export const prOpen = (p: Pick<GlassPr, 'key'>): Html => raw("showModal('pr','" + esc(p.key) + "')");

export const prLink = (p: Pick<GlassPr, 'url' | 'number'>): Html =>
  html`<a href="${p.url}" target="_blank" rel="noopener" onclick="event.stopPropagation()">#${p.number}</a>`;

export function prChecks(p: Pick<GlassPr, 'checks'>): Html {
  const c = p.checks;
  return html`${c.passed}/${c.total} passed${c.failed ? ` · ${c.failed} failed` : ''}${c.pending ? ` · ${c.pending} pending` : ''}`;
}

export function prReview(p: Pick<GlassPr, 'review' | 'reviewDecision'>): Html {
  const r: Partial<NonNullable<GlassPr['review']>> = p.review || {};
  return html`${p.reviewDecision || ''}${r.unresolvedThreads ? ` · ${r.unresolvedThreads} unresolved` : ''}${r.changesRequested && ' · changes requested'}`;
}

export function prMerge(p: Pick<GlassPr, 'mergeStateStatus' | 'nextMergeable' | 'blockedBy'>): Html {
  const next = p.nextMergeable ? raw(' · <span class="ok">next mergeable</span>') : p.blockedBy ? ` · blocked by #${p.blockedBy}` : '';
  return html`${p.mergeStateStatus}${next}`;
}

export const watchCell = (w: GlassPr['watch']): Html => {
  const ws = watchState(w);
  return w ? html`${ws.text} · ${ws.at ? html`${ageEl(ws.at)} ago` : 'never checked'}` : html`<span class="dim">${ws.text}</span>`;
};

export interface TrapRowView {
  stale: boolean;
  listen: Html;
  hb: Html;
}

export function trapRow(t: GlassTrap): TrapRowView {
  if (!t.live)
    return {
      stale: false,
      listen: raw('<span class="dot"></span><span class="dim">signed off</span>'),
      hb: raw('<span class="dim">—</span>'),
    };
  const stale = Date.now() - Date.parse(t.heartbeatAt!) > 1800000;
  return {
    stale,
    listen: t.firstParkedAt ? raw('<span class="dot ok"></span>listening') : raw('<span class="dot warn"></span>never parked'),
    hb: html`<span class="${stale ? 'bad' : 'ok'}">${stale && 'stale '}${ageEl(t.heartbeatAt)} ago</span>`,
  };
}

export function mailCell(t: GlassTrap): Html {
  const p = t.messages.filter((m) => m.state === 'pending').length;
  return t.messages.length ? html`✉ ${t.messages.length}${p > 0 && html` <span class="warn">(${p} pending)</span>`}` : raw('');
}

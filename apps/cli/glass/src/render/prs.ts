import type { GlassPr, GlassStack } from '@lobstah/core';
import { prBadgeClass } from '../../../src/glass-diff.js';
import type { PrsInputs } from '../../../src/glass-diff.js';
import { html } from '../html.js';
import type { Html } from '../html.js';
import { ageEl, prChecks, prLink, prMerge, prOpen, prReview, table, watchCell } from './common.js';

/** The PRs tab: PRs grouped by stack, then the watches that are not PR watches. */

export function prGroups(inp: Pick<PrsInputs, 'prs' | 'stacks'>): Array<{ s: GlassStack; prs: GlassPr[] }> {
  const byStack = new Map<string, GlassPr[]>();
  for (const p of inp.prs) {
    const a = byStack.get(p.stackId) || [];
    a.push(p);
    byStack.set(p.stackId, a);
  }
  return inp.stacks.map((s) => ({ s, prs: byStack.get(s.id) || [] })).filter((g) => g.prs.length);
}

const chainText = (s: GlassStack): string => s.numbers.map((n) => '#' + n).join(' → ');
const stateText = (p: GlassPr): Html =>
  html`${p.state}${p.draft && ' · draft'}${p.state === 'MERGED' && p.mergedAt && html` · ${p.mergedAt}`}`;

export function prTable(inp: PrsInputs): Html {
  const rows: Html[] = [];
  for (const { s, prs } of prGroups(inp)) {
    rows.push(html`<tr><th colspan="8">${chainText(s)} · floor ${s.floor}${s.open ? ' · open' : ' · history'}</th></tr>`);
    for (const p of prs)
      rows.push(
        html`<tr class="rowhead" onclick="${prOpen(p)}"><td>${prLink(p)}</td><td class="grow">${p.title || ''}</td><td>${stateText(p)}</td><td>${prChecks(p)}</td><td>${prReview(p)}</td><td>${prMerge(p)}</td><td>${watchCell(p.watch)}</td><td>${p.gate || ''}</td></tr>`,
      );
  }
  return html`${table(['PR', 'title', 'state', 'checks', 'review', 'merge', 'watch', 'gate'], rows, 'no PR evidence')}${otherWatches(inp)}`;
}

export function prCards(inp: PrsInputs): Html {
  const groups = prGroups(inp);
  const card = (p: GlassPr) =>
    html`<div class="card" onclick="${prOpen(p)}"><div class="top"><b>#${p.number} ${p.title || ''}</b><span class="badge ${prBadgeClass(p.badge)}">${p.badge.text}</span></div><div class="meta">${p.repo} · ${stateText(p)} · ${prMerge(p)}</div><div class="foot"><span>${prChecks(p)}</span><span>${watchCell(p.watch)}</span>${p.gate && html`<span>gate ${p.gate}</span>`}</div></div>`;
  const body = groups.length
    ? groups.map(
        ({ s, prs }) =>
          html`<h2>${chainText(s)} · floor ${s.floor}${s.open ? '' : ' · history'}</h2><div class="cards">${prs.map(card)}</div>`,
      )
    : html`<div class="empty">no PR evidence</div>`;
  return html`${body}${otherWatches(inp)}`;
}

export function otherWatches(inp: Pick<PrsInputs, 'watches'>): Html {
  const short = (c: unknown): string => {
    const s = String(c ?? '');
    return s.length > 24 ? s.slice(0, 23) + '…' : s;
  };
  const rows = inp.watches.map(
    (w) =>
      html`<tr><td>${w.key}</td><td>${w.owner}</td><td title="${w.cursor}">${short(w.cursor)}</td><td>${w.lastCheckedAt && ageEl(w.lastCheckedAt)}</td><td>${w.lastError || ''}</td></tr>`,
  );
  return html`<h2>other watches</h2>${table(['key', 'owner', 'cursor', 'last check', 'error'], rows, 'no other watches')}`;
}

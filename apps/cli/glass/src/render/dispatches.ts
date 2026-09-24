import type { GlassDispatch } from '@lobstah/core';
import type { GlassPrefs } from '../../../src/glass-diff.js';
import { html } from '../html.js';
import type { Html } from '../html.js';
import { addrCell, ageEl, openDispatch, prCell, table } from './common.js';

/** The Dispatches tab: every dispatch, filtered, as a table or cards; optionally grouped by follow-up chain. */

export function chainRows(list: GlassDispatch[], chain: boolean): GlassDispatch[] {
  if (!chain) return list;
  const byId = new Map(list.map((x) => [x.id, x]));
  const root = (x: GlassDispatch): string => {
    let at = x;
    const seen = new Set<string>();
    while (at.followUp && byId.has(at.followUp) && !seen.has(at.id)) {
      seen.add(at.id);
      at = byId.get(at.followUp)!;
    }
    return at.id;
  };
  const groups = new Map<string, GlassDispatch[]>();
  for (const x of list) {
    const k = root(x),
      g = groups.get(k) || [];
    g.push(x);
    groups.set(k, g);
  }
  return [...groups.values()]
    .sort((a, b) => b[0]!.sort - a[0]!.sort)
    .flatMap((g) => g.sort((a, b) => (a.id === root(a) ? -1 : b.id === root(b) ? 1 : a.sort - b.sort)));
}

export function dispatchTable(list: GlassDispatch[], st: Pick<GlassPrefs, 'chain'>): Html {
  const row = (x: GlassDispatch) => {
    const fork = st.chain && x.followUp && html`<span class="dim">↳ </span>`;
    return html`<tr class="rowhead" onclick="${openDispatch(x.lane, x.id)}"><td>${fork}${x.id.slice(0, 8)}</td><td>${x.lane} / ${x.bucket}</td><td>${x.repo}</td><td class="v-${x.verb}">${x.verb}</td><td class="grow">${(x.note ?? '').slice(0, 90)}</td><td>${ageEl(x.verbAt)}</td><td>${addrCell(x)}</td><td>${prCell(x)}</td></tr>`;
  };
  return table(
    ['id', 'lane / bucket', 'repo', 'verb', 'note', 'age', 'addressed', 'pr'],
    chainRows(list, st.chain).map(row),
    'no dispatches match',
  );
}

export function dispatchCards(list: GlassDispatch[]): Html {
  if (!list.length) return html`<div class="empty">no dispatches match</div>`;
  const card = (x: GlassDispatch) =>
    html`<div class="card" onclick="${openDispatch(x.lane, x.id)}"><div class="top"><b>${x.id.slice(0, 8)}</b><span class="badge v-${x.verb}">${x.verb}</span></div><div class="meta">${x.repo} · ${x.lane} ${x.bucket} · ${ageEl(x.verbAt)}</div>${x.note && html`<div class="note">${x.note}</div>`}<div class="foot">${addrCell(x)} ${prCell(x)}</div></div>`;
  return html`<div class="cards">${list.map(card)}</div>`;
}

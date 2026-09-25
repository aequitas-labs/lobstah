import type { GlassDispatch } from '@lobstah/core';
import type { SectionInputs } from '../../../src/glass-diff.js';
import { html } from '../html.js';
import { Age, Table, addrCell, opener, prCell } from './common.js';

/** The Dispatches tab: every dispatch, filtered, as a table or cards; optionally grouped by follow-up chain. Rows are keyed by lane:id. */

export function chainRows(list: GlassDispatch[], chain: boolean | undefined): GlassDispatch[] {
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

function row(x: GlassDispatch, chain: boolean | undefined) {
  const key = x.lane + ':' + x.id;
  return html`<tr key=${key} class="rowhead" onClick=${opener('dispatch', key)}><td>${chain && x.followUp && html`<span class="dim">↳ </span>`}${x.id.slice(0, 8)}</td><td>${x.lane} / ${x.bucket}</td><td>${x.repo}</td><td class=${'v-' + x.verb}>${x.verb}</td><td class="grow">${(x.note ?? '').slice(0, 90)}</td><td>${Age(x.verbAt)}</td><td>${addrCell(x)}</td><td>${prCell(x)}</td></tr>`;
}

function card(x: GlassDispatch) {
  const key = x.lane + ':' + x.id;
  return html`<div key=${key} class="card" onClick=${opener('dispatch', key)}><div class="top"><b>${x.id.slice(0, 8)}</b><span class=${'badge v-' + x.verb}>${x.verb}</span></div><div class="meta">${x.repo} · ${x.lane} ${x.bucket}${x.verbAt && [' · ', Age(x.verbAt)]}</div>${x.note && html`<div class="note">${x.note}</div>`}<div class="foot">${addrCell(x)} ${prCell(x)}</div></div>`;
}

export function Dispatches({ inp }: { inp: SectionInputs['dispatches'] }) {
  const list = inp.list;
  if (inp.view === 'cards')
    return list.length ? html`<div class="cards">${list.map(card)}</div>` : html`<div class="empty">no dispatches match</div>`;
  return Table(
    ['id', 'lane / bucket', 'repo', 'verb', 'note', 'age', 'addressed', 'pr'],
    chainRows(list, inp.chain).map((x) => row(x, inp.chain)),
    'no dispatches match',
  );
}

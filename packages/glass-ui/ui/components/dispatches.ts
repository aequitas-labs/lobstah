import type { GlassDispatchSummary as GlassDispatch, GlassDispatchSummary } from '@lobstah/core';
import type { SectionInputs } from '../../src/glass-diff.js';
import { html } from '../html.js';
import { Card } from './card.js';
import {
  heavyPlace,
  ActivityLine,
  WorkerIndicator,
  Age,
  NamedText,
  ShowOlder,
  WaitingLine,
  Table,
  addrCell,
  dispatchContext,
  opener,
  prCell,
  prHeadCell,
  verbTone,
  verbWord,
} from './common.js';
import type { OlderControl } from './common.js';

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
  return html`<tr key=${key} class="rowhead" onClick=${opener('dispatch', key)}><td>${chain && x.followUp && html`<span class="dim">↳ </span>`}${x.id.slice(0, 8)}</td><td>${x.lane} / ${x.bucket}</td><td>${x.repo}</td><td class=${'v-' + x.verb}>${x.verb}${heavyPlace({ dispatch: x.id }) ? html`<div class="dim">${heavyPlace({ dispatch: x.id })}</div>` : ''}</td><td class="grow">${NamedText(x.note ?? '', 90)}${WaitingLine(x)}${WorkerIndicator(x)}${ActivityLine(x)}</td><td>${Age(x.verbAt)}</td><td>${addrCell(x)}</td><td>${(x.prList?.length ?? 0) > 1 || (x.evidence?.prUrls?.length ?? 0) > 1 ? prCell(x) : prHeadCell(x)}</td></tr>`;
}

/**
 * A dispatch as a card: its instruction and status chip, then its repo, the
 * trap that has it, and its age. The id, note, worker, PR and the rest are in
 * its modal; the id still finds it in search.
 */
export function dispatchCard(x: GlassDispatchSummary) {
  const key = x.lane + ':' + x.id;
  return html`<${Card}
    key=${key}
    title=${x.title || x.id.slice(0, 8)}
    titleAttr=${`${x.id.slice(0, 8)} · ${x.title}`}
    state=${{ word: verbWord(x.verb), tone: verbTone(x.verb), mark: 'chip' }}
    context=${dispatchContext(x.repo, x.for || x.claimedBy, x.verbAt)}
    onClick=${opener('dispatch', key)}
  />`;
}

export function Dispatches({ inp, more }: { inp: SectionInputs['dispatches']; more?: OlderControl }) {
  const list = inp.list;
  const older = more && html`<${ShowOlder} kind="dispatches" more=${more} />`;
  if (inp.view === 'cards')
    return [
      list.length ? html`<div class="cards">${list.map(dispatchCard)}</div>` : html`<div class="empty">no dispatches match</div>`,
      older,
    ];
  return [
    Table(
      ['id', 'lane / bucket', 'repo', 'verb', 'note', 'age', 'addressed', 'pr'],
      chainRows(list, inp.chain).map((x) => row(x, inp.chain)),
      'no dispatches match',
    ),
    older,
  ];
}

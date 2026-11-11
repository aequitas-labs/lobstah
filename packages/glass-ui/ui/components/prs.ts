import { useState } from 'preact/hooks';
import { ackPrAttention } from '../actions.js';
import type { DeckAttention } from '../../src/glass-diff.js';
import { Fragment } from 'preact';
import type { GlassPr, GlassStack } from '@lobstah/core';
import { shownPrAttention } from '../../src/glass-diff.js';
import type { PrsInputs } from '../../src/glass-diff.js';
import { html } from '../html.js';
import {
  Age,
  Table,
  opener,
  prChecks,
  prLink,
  prMerge,
  prReview,
  reviewLink,
  ShowOlder,
  stackNumbers,
  stackTitle,
  watchCell,
  RepoName,
} from './common.js';
import type { OlderControl } from './common.js';
import { LinkedText } from './links.js';
import { can } from '../backend.js';
import { Card, CardLink, PrIcon } from './card.js';

/**
 * The PRs tab: Yours first (the stacks holding a PR of the person's own,
 * `GlassPr.mine`), then every other watched PR in a section that starts
 * closed, then the watches that are not PR watches. Each group is by stack.
 * Every stack group and PR row is keyed, so a poll patches rows in place and
 * never re-creates the list.
 */

export function prGroups(inp: Pick<PrsInputs, 'prs' | 'stacks'>): Array<{ s: GlassStack; prs: GlassPr[] }> {
  const byStack = new Map<string, GlassPr[]>();
  for (const p of inp.prs) {
    const a = byStack.get(p.stackId) || [];
    a.push(p);
    byStack.set(p.stackId, a);
  }
  return inp.stacks.map((s) => ({ s, prs: byStack.get(s.id) || [] })).filter((g) => g.prs.length);
}

/** The stack groups split in two: those holding one of the person's own PRs, and the rest. */
export function splitMine(groups: Array<{ s: GlassStack; prs: GlassPr[] }>): { yours: typeof groups; others: typeof groups } {
  const yours = groups.filter((g) => g.prs.some((p) => p.mine));
  return { yours, others: groups.filter((g) => !yours.includes(g)) };
}

/** How many of the person's own open PRs need them: failed checks, a conflict, or a repair that stopped (a bad badge). */
export function prsNeedingYou(prs: readonly GlassPr[]): number {
  return prs.filter((p) => p.mine && p.state === 'OPEN' && p.badge.tone === 'bad').length;
}

/** The section after Yours: every other watched PR, closed until opened. */
const othersSection = (count: number, body: unknown) =>
  count > 0 && html`<details class="otherprs"><summary><h2>Other PRs · ${count}</h2></summary>${body}</details>`;

const chainText = (s: GlassStack, prs: GlassPr[]) => stackNumbers(s.numbers, new Map(prs.map((p) => [p.number, p.title])));
const stateText = (p: GlassPr): string =>
  p.state + (p.draft ? ' · draft' : '') + (p.state === 'MERGED' && p.mergedAt ? ' · ' + p.mergedAt : '');

function otherWatches(inp: Pick<PrsInputs, 'watches'>) {
  const short = (c: unknown): string => {
    const s = String(c ?? '');
    return s.length > 24 ? s.slice(0, 23) + '…' : s;
  };
  const rows = inp.watches.map(
    (w) =>
      html`<tr key=${w.key}><td>${w.key}</td><td>${w.owner}</td><td title=${w.cursor}>${short(w.cursor)}</td><td>${w.lastCheckedAt && Age(w.lastCheckedAt)}</td><td>${LinkedText(w.lastError)}</td></tr>`,
  );
  return [html`<h2>other watches</h2>`, Table(['key', 'owner', 'cursor', 'last check', 'error'], rows, 'no other watches')];
}

function prTable(inp: PrsInputs, older: unknown) {
  const { yours, others } = splitMine(prGroups(inp));
  const rowsOf = (groups: typeof yours) =>
    groups.flatMap(({ s, prs }) => [
      html`<tr key=${'stack:' + s.id}><th colspan="8">${stackTitle(s)}${chainText(s, prs)} · floor ${s.floor}${s.open ? ' · open' : ' · history'}<${PrAck} stack=${s} prs=${prs} attention=${inp.prAttention} />${s.readiness && html`<div class=${s.readiness.allReady ? 'ok' : 'dim'}>${s.readiness.state}</div>`}</th></tr>`,
      ...prs.map(
        (p) =>
          html`<tr key=${p.key} class="rowhead" onClick=${opener('pr', p.key)}><td>${prLink(p)}</td><td class="grow">${LinkedText(p.title)}</td><td>${stateText(p)}</td><td>${prChecks(p)}</td><td>${prReview(p)}</td><td>${prMerge(p)}</td><td>${watchCell(p.watch)}</td><td>${p.gate || ''}</td></tr>`,
      ),
    ]);
  const cols = ['PR', 'title', 'state', 'checks', 'review', 'merge', 'watch', 'gate'];
  const otherCount = others.reduce((n, g) => n + g.prs.length, 0);
  return [
    html`<h2 class="yourshead">Yours · ${yours.reduce((n, g) => n + g.prs.filter((p) => p.mine).length, 0)}</h2>`,
    Table(cols, rowsOf(yours), YOURS_EMPTY),
    othersSection(otherCount, Table(cols, rowsOf(others), '')),
    older,
    otherWatches(inp),
  ];
}

/** What Yours says when it is empty: how a PR gets there. */
const YOURS_EMPTY = 'no PRs of yours are watched: a trap’s PR shows here, and `lobstah watch add <url>` adds one you opened';

/**
 * A PR card: its title and PR icon; under them its status word on a colored
 * edge (you act on PRs); then repo #number, checks and age, with ↗ Open. Merge readiness,
 * the watch and the gate are in the PR's modal. `quiet` greys an acked one.
 */
export function prCard(p: GlassPr, quiet = false) {
  const at = p.mergedAt || p.closedAt || p.updatedAt || p.firstSeenAt || p.observedAt;
  const checks = prChecks(p);
  return html`<${Card}
    key=${p.key}
    title=${p.title ? LinkedText(p.title) : '#' + p.number}
    titleAttr=${p.title || undefined}
    icon=${PrIcon}
    state=${{ word: p.badge.text.toLowerCase(), tone: p.badge.tone, mark: 'edge' }}
    stateBelow
    context=${[RepoName(p.repo), ` #${p.number} · ${checks} · `, Age(at), ' ago']}
    contextTitle=${`${p.repo} #${p.number} · ${checks}`}
    action=${html`<${CardLink} href=${reviewLink(p.url)} />`}
    quiet=${quiet}
    cls=${quiet ? 'acked' : undefined}
    onClick=${opener('pr', p.key)}
  />`;
}

function prCards(inp: PrsInputs, older: unknown) {
  const { yours, others } = splitMine(prGroups(inp));
  const card = (p: GlassPr) => prCard(p);
  const stacksOf = (groups: typeof yours) =>
    groups.map(
      ({ s, prs }) =>
        html`<${Fragment} key=${'stack:' + s.id}><h2>${stackTitle(s)}${chainText(s, prs)} · floor ${s.floor}${s.open ? '' : ' · history'}<${PrAck} stack=${s} prs=${prs} attention=${inp.prAttention} /></h2>${s.readiness && html`<div class=${s.readiness.allReady ? 'ok' : 'dim'}>${s.readiness.state}</div>`}<div class="cards">${prs.map(card)}</div><//>`,
    );
  const otherCount = others.reduce((n, g) => n + g.prs.length, 0);
  return [
    html`<h2 class="yourshead">Yours · ${yours.reduce((n, g) => n + g.prs.filter((p) => p.mine).length, 0)}</h2>`,
    yours.length ? stacksOf(yours) : html`<div class="empty">${YOURS_EMPTY}</div>`,
    othersSection(otherCount, stacksOf(others)),
    older,
    otherWatches(inp),
  ];
}

/**
 * Ack one stack group's unacknowledged PR and stack attention, as shown: a
 * stack of several PRs says "Ack stack"; a lone PR says "Ack" and acks only
 * itself. Each item carries the state hash this page showed, so a stale
 * page never acks a newer state. Nothing pending, nothing shown.
 */
export function PrAck({ stack, prs, attention }: { stack: GlassStack; prs: GlassPr[]; attention: readonly DeckAttention[] }) {
  // Constant for the page's life, so the hooks below always run in the same order.
  if (!can('pr-ack')) return null;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = shownPrAttention(attention, prs, [stack]).filter((a) => !a.acked);
  if (!pending.length) return null;
  const label = prs.length > 1 ? 'Ack stack' : 'Ack';
  const ack = async (e: Event) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await ackPrAttention(pending);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not acknowledge PRs.');
    } finally {
      setBusy(false);
    }
  };
  return html`<span class="prack" onClick=${(e: Event) => e.stopPropagation()}><button class="btn" data-stack=${stack.id} disabled=${busy} onClick=${ack}>${busy ? 'Acknowledging…' : label}</button>${error && html`<span class="bad" role="alert">${error}</span>`}</span>`;
}

export function PRs({ inp, more }: { inp: PrsInputs; more?: OlderControl }) {
  const older = more && html`<${ShowOlder} kind="prs" more=${more} />`;
  return inp.view === 'cards' ? prCards(inp, older) : prTable(inp, older);
}

import { useState } from 'preact/hooks';
import { ackPrAttention, requestPrMerge } from '../actions.js';
import type { DeckAttention } from '../../src/glass-diff.js';
import { Fragment } from 'preact';
import type { GlassPr, GlassStack } from '@lobstah/core';
import { shownPrAttention } from '../../src/glass-diff.js';
import type { PrsInputs } from '../../src/glass-diff.js';
import { html } from '../html.js';
import {
  Age,
  Table,
  TRAP_MARK,
  WorkerAddress,
  ageText,
  namedText,
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
import { getState } from '../store.js';
import type { Children } from '../html.js';
import { Card, CardLink, PrIcon } from './card.js';
import type { CardTone } from './card.js';

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
          html`<tr key=${p.key} class="rowhead" onClick=${opener('pr', p.key)}><td>${prLink(p)}</td><td class="grow">${LinkedText(p.title)}</td><td>${stateText(p)}</td><td>${prChecks(p)}</td><td>${prReview(p)}</td><td>${prMerge(p)}${p.mergeRequest && [' · ', mergeNote(p)]} <${MergeWhenGreen} p=${p} /></td><td>${watchCell(p.watch)}</td><td>${p.gate || ''}</td></tr>`,
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

const METHOD_WORDS = { merge: 'a merge commit', squash: 'one squashed commit', rebase: 'rebased commits' } as const;

/**
 * Merge when green, on a row of yours: the button, then a second tap that
 * names what happens, then Cancel while the request stands. A PR repair
 * works a failing or conflicting PR back to green first (the boat's pass).
 */
export function MergeWhenGreen({ p }: { p: GlassPr }) {
  // Constant for the page's life, so the hooks below always run in the same order.
  if (!can('pr-merge') || !p.mine || p.state !== 'OPEN') return null;
  const [confirming, setConfirming] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const send = (cancel: boolean) => async (e: Event) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await requestPrMerge(p.key, cancel);
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not ask for the merge.');
    } finally {
      setBusy(false);
    }
  };
  const stop = (e: Event) => e.stopPropagation();
  const button = p.mergeRequest
    ? html`<button class="btn" disabled=${busy} onClick=${send(true)}>Cancel</button>`
    : confirming
      ? html`<button class="btn go" disabled=${busy} onClick=${send(false)}>Merge #${p.number} into ${p.baseRefName ?? 'its base'}${p.mergeMethod ? ` as ${METHOD_WORDS[p.mergeMethod]}` : ''}</button><button class="btn" onClick=${(
          e: Event,
        ) => {
          stop(e);
          setConfirming(false);
        }}>Keep</button>`
      : html`<button class="btn" onClick=${(e: Event) => {
          stop(e);
          setConfirming(true);
        }}>Merge when green</button>`;
  return html`<span class=${confirming && !p.mergeRequest ? 'prmerge asking' : 'prmerge'} onClick=${stop}>${button}${error && html`<span class="bad" role="alert">${error}</span>`}</span>`;
}

/** What a standing merge request says on the row's status line. */
const mergeNote = (p: GlassPr) =>
  p.mergeRequest && html`<span class="mergenote" title=${`merges as ${METHOD_WORDS[p.mergeRequest.method]}`}>merges when green</span>`;

/** The trap that has one of these dispatches (addressed to it, else claimed by it), as `wt:<id>`; none for headless work. */
export function dispatchTrap(ids: readonly (string | undefined)[]): string | undefined {
  const dispatches = getState().snapshot?.dispatches ?? [];
  for (const id of ids) {
    const x = id && dispatches.find((d) => d.id === id);
    const trap = x && [x.for, x.claimedBy].find((a) => a?.startsWith('wt:'));
    if (trap) return trap;
  }
  return undefined;
}

/** What a PR-shaped card shows: a PR card, or a review card, which is a PR asking for your review. */
export interface PrCardParts {
  key: string;
  title: Children;
  titleAttr?: string;
  /** GitHub's state for the PR, which colors its icon: open green, draft grey, merged purple, closed red. */
  prState?: 'open' | 'draft' | 'merged' | 'closed';
  /** The status chips under the title. */
  status: Children;
  /** The colored edge: red when it waits on you, amber in progress, green done. */
  tone: CardTone;
  repo: string;
  number: number;
  at?: string;
  /** The trap that has its work, as `wt:<id>`. */
  trap?: string;
  /** Last on the meta line: a PR's checks. */
  detail?: string;
  /** After the meta line's parts: a standing merge request. */
  tail?: Children;
  /** The bottom bar's buttons: only the ones that apply to this card. */
  actions: Children;
  quiet?: boolean;
  cls?: string;
  attrs?: Record<string, unknown>;
  onClick: () => void;
}

/** A status chip: a PR's GitHub state (`pr-open` …, filled in GitHub's color), or a word in a tone. A long one may shrink and carries itself as a title. */
export const StatusChip = (word: string, cls: string) =>
  html`<span class=${'gchip ' + cls + (word.length > 12 ? ' long' : '')} title=${word.length > 12 ? word : undefined}>${word}</span>`;

/**
 * The one layout for PR and review cards:
 * 1. the PR icon, colored by the PR's state, then the title;
 * 2. the status chips;
 * 3. the meta line in the gray subtitle: repo · age · #number · 🪤 trap · checks;
 * 4. a bar of the card's buttons.
 * The edge carries the tone. The card itself opens its modal.
 */
export function prShapedCard(c: PrCardParts) {
  const trap = c.trap && [`${TRAP_MARK} `, WorkerAddress(c.trap)];
  const parts: Children[] = [RepoName(c.repo), c.at && [Age(c.at), ' ago'], `#${c.number}`, trap, c.detail].filter(Boolean);
  const meta = [...parts.flatMap((part, i) => (i ? [' · ', part] : [part])), c.tail];
  const text = [c.repo, c.at && `${ageText(c.at)} ago`, `#${c.number}`, c.trap && `${TRAP_MARK} ${namedText(c.trap)}`, c.detail]
    .filter(Boolean)
    .join(' · ');
  return html`<${Card}
    key=${c.key}
    title=${c.title}
    titleAttr=${c.titleAttr}
    icon=${html`<span class=${'prstate pr-' + (c.prState ?? 'open')}>${PrIcon}</span>`}
    iconFirst
    state=${{ word: '', tone: c.tone, mark: 'edge' }}
    status=${c.status}
    context=${meta}
    contextTitle=${text}
    actions=${c.actions}
    quiet=${c.quiet}
    cls=${['prcard', c.cls].filter(Boolean).join(' ')}
    attrs=${c.attrs}
    onClick=${c.onClick}
  />`;
}

const PR_STATE_WORD = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' } as const;

/** What a PR card's Ack acks: its own unacknowledged attention, and its stack's when it is the stack's only PR. */
export function prCardPending(p: GlassPr, attention: readonly DeckAttention[], stack?: GlassStack): DeckAttention[] {
  return shownPrAttention(attention, [p], stack ? [stack] : []).filter((a) => !a.acked && (a.key === p.key || !!stack));
}

/**
 * A PR card (prShapedCard). Its chips are GitHub's state (Open, Draft,
 * Merged, Closed) and, when the badge is not green, what the badge says
 * (failed checks, conflicts, a repair). Its buttons are Merge when green on
 * an open PR of yours, Ack while it has attention to ack, and ↗ Open.
 * Merge readiness, the watch and the gate are in the PR's modal. `quiet`
 * greys an acked one; `stack` is its stack when it is the only PR in it.
 */
export function prCard(p: GlassPr, opts: { quiet?: boolean; attention?: readonly DeckAttention[]; stack?: GlassStack } = {}) {
  const state = p.badge.state;
  const pending = prCardPending(p, opts.attention ?? [], opts.stack);
  return prShapedCard({
    key: p.key,
    title: p.title ? LinkedText(p.title) : '#' + p.number,
    titleAttr: p.title || undefined,
    prState: state,
    status: [
      StatusChip(PR_STATE_WORD[state] ?? state, 'pr-' + state),
      state === 'open' && p.badge.tone !== 'ok' && StatusChip(p.badge.text.toLowerCase(), p.badge.tone),
    ],
    tone: p.badge.tone,
    repo: p.repo,
    number: p.number,
    at: p.mergedAt || p.closedAt || p.updatedAt || p.firstSeenAt || p.observedAt,
    trap: dispatchTrap(p.dispatchIds),
    detail: prChecks(p),
    tail: p.mergeRequest && [' · ', mergeNote(p)],
    actions: [
      html`<${MergeWhenGreen} p=${p} />`,
      pending.length > 0 && html`<${AckButton} pending=${pending} label="Ack" stack=${opts.stack?.id} />`,
      html`<${CardLink} href=${reviewLink(p.url)} />`,
    ],
    quiet: opts.quiet,
    cls: opts.quiet ? 'acked' : undefined,
    onClick: opener('pr', p.key),
  });
}

function prCards(inp: PrsInputs, older: unknown) {
  const { yours, others } = splitMine(prGroups(inp));
  // A lone PR's card acks its stack too; a stack of several keeps Ack stack on its heading.
  const card = (s: GlassStack, prs: GlassPr[]) => (p: GlassPr) =>
    prCard(p, { attention: inp.prAttention, stack: prs.length === 1 ? s : undefined });
  const stacksOf = (groups: typeof yours) =>
    groups.map(
      ({ s, prs }) =>
        html`<${Fragment} key=${'stack:' + s.id}><h2>${stackTitle(s)}${chainText(s, prs)} · floor ${s.floor}${s.open ? '' : ' · history'}${prs.length > 1 && html`<${PrAck} stack=${s} prs=${prs} attention=${inp.prAttention} />`}</h2>${s.readiness && html`<div class=${s.readiness.allReady ? 'ok' : 'dim'}>${s.readiness.state}</div>`}<div class="cards">${prs.map(card(s, prs))}</div><//>`,
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
  const pending = shownPrAttention(attention, prs, [stack]).filter((a) => !a.acked);
  if (!pending.length) return null;
  return html`<${AckButton} pending=${pending} label=${prs.length > 1 ? 'Ack stack' : 'Ack'} stack=${stack.id} />`;
}

/** Ack these attention items, with the state hashes this page showed. */
function AckButton({ pending, label, stack }: { pending: DeckAttention[]; label: string; stack?: string }) {
  // Constant for the page's life, so the hooks below always run in the same order.
  if (!can('pr-ack')) return null;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
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
  return html`<span class="prack" onClick=${(e: Event) => e.stopPropagation()}><button class="btn" data-stack=${stack} disabled=${busy} onClick=${ack}>${busy ? 'Acknowledging…' : label}</button>${error && html`<span class="bad" role="alert">${error}</span>`}</span>`;
}

export function PRs({ inp, more }: { inp: PrsInputs; more?: OlderControl }) {
  const older = more && html`<${ShowOlder} kind="prs" more=${more} />`;
  return inp.view === 'cards' ? prCards(inp, older) : prTable(inp, older);
}

import { ackPrAttention, requestPrMerge, requestStackMerge } from '../actions.js';
import type { DeckAttention } from '../../src/glass-diff.js';
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
import { getState, setState } from '../store.js';
import type { Children } from '../html.js';
import { ActionIcon, Card, CardLink, PrIcon, githubAvatarUrl } from './card.js';
import type { CardPerson, CardTone } from './card.js';
import { Button } from './button.js';

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
  return [html`<h2>Other watches</h2>`, Table(['key', 'owner', 'cursor', 'last check', 'error'], rows, 'no other watches')];
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
 * Merge when green, on a PR of yours: one click asks for it, and the button
 * then reads Cancel merge, one click to stop. It merges the way the repo is
 * set to (`[repos.<key>].mergeMethod`, else the pickup's method), never a
 * choice made here; the hover text names it. A PR repair works a failing or
 * conflicting PR back to green first (the boat's pass).
 */
export function MergeWhenGreen({ p }: { p: GlassPr }) {
  // Constant for the page's life, so the hooks below always run in the same order.
  if (!can('pr-merge') || !p.mine || p.state !== 'OPEN') return null;
  const send = (cancel: boolean) => async (e: Event) => {
    e.stopPropagation();
    await requestPrMerge(p.key, cancel);
  };
  const method = p.mergeRequest?.method ?? p.mergeMethod;
  const how = `#${p.number} into ${p.baseRefName ?? 'its base'}${method ? ` as ${METHOD_WORDS[method]}` : ''}`;
  const button = p.mergeRequest
    ? html`<${Button} variant="primary" class="on" aria-pressed="true" title=${`Merges ${how} once green; click to cancel`} action=${send(true)} sending="Cancelling merge…" done="Merge cancelled">${ActionIcon.merge}Cancel merge<//>`
    : html`<${Button} variant="primary" aria-pressed="false" title=${`Merges ${how} once green`} action=${send(false)} sending="Requesting merge…" done=${`Merges #${p.number} when green`}>${ActionIcon.merge}Merge when green<//>`;
  return html`<span class="prmerge" onClick=${(e: Event) => e.stopPropagation()}>${button}</span>`;
}

/** "#41, #42 and #43": a stack's numbers in words, bottom first. */
const numberList = (numbers: readonly number[]): string => {
  const words = numbers.map((n) => `#${n}`);
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : (words[0] ?? '');
};

/**
 * Merge stack when green, on a stack of your PRs: one click asks the boat to
 * merge the whole stack once every PR in it is green, and the button then
 * reads Cancel merge. The boat links a plain stack on GitHub first, then
 * GitHub merges the PRs in order, the repo's way, which the hover names.
 * Once GitHub has taken the merge it reads Merging and can't be cancelled.
 */
export function MergeStackWhenGreen({ s, prs }: { s: GlassStack; prs: GlassPr[] }) {
  // Constant for the page's life, so the hooks below always run in the same order.
  if (!can('stack-merge') || !s.mine || !s.open || prs.length < 2) return null;
  const send = (cancel: boolean) => async (e: Event) => {
    e.stopPropagation();
    await requestStackMerge(s.id, cancel);
  };
  const open = prs.filter((p) => p.state === 'OPEN');
  const method = s.mergeRequest?.method ?? open[0]?.mergeMethod;
  const how = `${numberList(open.map((p) => p.number))} into ${s.floor} in order${method ? `, as ${METHOD_WORDS[method]}` : ''}`;
  const button = s.mergeRequest?.merging
    ? html`<${Button} variant="primary" class="on" aria-pressed="true" disabled title=${`GitHub is merging ${how}`}>${ActionIcon.merge}Merging<//>`
    : s.mergeRequest
      ? html`<${Button} variant="primary" class="on" aria-pressed="true" title=${`Merges ${how}, once all are green; click to cancel`} action=${send(true)} sending="Cancelling merge…" done="Merge cancelled">${ActionIcon.merge}Cancel merge<//>`
      : html`<${Button} variant="primary" aria-pressed="false" title=${`Merges ${how}, once all are green`} action=${send(false)} sending="Requesting merge…" done=${`Merges ${numberList(open.map((p) => p.number))} when green`}>${ActionIcon.merge}Merge stack when green<//>`;
  return html`<span class="prmerge stackmerge" onClick=${(e: Event) => e.stopPropagation()}>${button}</span>`;
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

  /** After the meta line's parts: a standing merge request. */
  tail?: Children;
  /** The bottom bar's buttons: only the ones that apply to this card. */
  actions: Children;
  quiet?: boolean;
  cls?: string;
  attrs?: Record<string, unknown>;
  /** The person it is about, as the avatar chip at its top right. */
  person?: CardPerson;
  onClick: () => void;
}

/**
 * A status chip: a PR's GitHub state (`pr-open` …, filled in GitHub's color),
 * or a word in a tone. A long one may shrink and carries itself as a title;
 * `hover` replaces that title with more than the word says.
 */
export const StatusChip = (word: string, cls: string, hover?: string) =>
  html`<span class=${'gchip ' + cls + (word.length > 12 ? ' long' : '')} title=${hover ?? (word.length > 12 ? word : undefined)}>${word}</span>`;

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
  const parts: Children[] = [RepoName(c.repo), c.at && [Age(c.at), ' ago'], `#${c.number}`, trap].filter(Boolean);
  const meta = [...parts.flatMap((part, i) => (i ? [' · ', part] : [part])), c.tail];
  const text = [c.repo, c.at && `${ageText(c.at)} ago`, `#${c.number}`, c.trap && `${TRAP_MARK} ${namedText(c.trap)}`]
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
    person=${c.person}
    onClick=${c.onClick}
  />`;
}

/** A PR's author, as its card's avatar chip shows them. */
export function prAuthor(p: Pick<GlassPr, 'author'>): CardPerson | undefined {
  if (!p.author) return undefined;
  const avatarUrl = githubAvatarUrl(p.author);
  return { login: p.author, ...(avatarUrl ? { avatarUrl } : {}), role: 'author' };
}

const PR_STATE_WORD = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' } as const;

/** What a PR card's Ack acks: its own unacknowledged attention, and its stack's when it is the stack's only PR. */
export function prCardPending(p: GlassPr, attention: readonly DeckAttention[], stack?: GlassStack): DeckAttention[] {
  return shownPrAttention(attention, [p], stack ? [stack] : []).filter((a) => !a.acked && (a.key === p.key || !!stack));
}

/**
 * A PR card (prShapedCard). Its chips are GitHub's state (Open, Draft,
 * Merged, Closed) and, when the badge is not green, what the badge says
 * (failed checks, conflicts, a repair); a checks chip's hover is the checks'
 * breakdown, which the meta line no longer repeats. Its bar holds Merge when
 * green on an open PR of yours, and the Open icon at its right. Opening the
 * card or Open acks what it shows (ackOnOpen): it has no Ack button.
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
      // A checks chip ("checks 3/4") carries the breakdown as its hover; the meta line no longer repeats it.
      state === 'open' &&
        p.badge.tone !== 'ok' &&
        StatusChip(p.badge.text.toLowerCase(), p.badge.tone, /^checks\b/.test(p.badge.text) ? prChecks(p) : undefined),
    ],
    tone: p.badge.tone,
    repo: p.repo,
    number: p.number,
    at: p.mergedAt || p.closedAt || p.updatedAt || p.firstSeenAt || p.observedAt,
    trap: dispatchTrap(p.dispatchIds),
    person: prAuthor(p),
    actions: [html`<${MergeWhenGreen} p=${p} />`, html`<${CardLink} href=${reviewLink(p.url)} onOpen=${() => ackOnOpen(pending)} />`],
    quiet: opts.quiet,
    cls: opts.quiet ? 'acked' : undefined,
    onClick: () => {
      ackOnOpen(pending);
      opener('pr', p.key)();
    },
  });
}

/** A stack's members in merge order: the bottom of the stack first, as its numbers run. */
export function stackMembers(s: Pick<GlassStack, 'numbers'>, prs: readonly GlassPr[]): GlassPr[] {
  const order = new Map(s.numbers.map((n, i) => [n, i]));
  return [...prs].sort((a, b) => (order.get(a.number) ?? Infinity) - (order.get(b.number) ?? Infinity) || a.number - b.number);
}

/** When a PR last changed, as its card's age reads it. */
const prChangedAt = (p: GlassPr): string | undefined => p.mergedAt || p.closedAt || p.updatedAt || p.firstSeenAt || p.observedAt;

/** When the newest change across a stack's members happened. */
export function stackUpdatedAt(prs: readonly GlassPr[]): string | undefined {
  return prs
    .map(prChangedAt)
    .filter((at): at is string => !!at)
    .sort()
    .at(-1);
}

/**
 * A stack's one-chip summary and the tone of its edge: "ready to merge" when
 * every PR in it is, else "N failing" when some fail, else "N of M green"
 * over its open PRs; a stack with none open says "merged" or "closed".
 */
export function stackSummary(s: Pick<GlassStack, 'readiness'>, prs: readonly GlassPr[]): { text: string; tone: CardTone } {
  const open = prs.filter((p) => p.state === 'OPEN');
  if (!open.length) return prs.some((p) => p.state === 'MERGED') ? { text: 'merged', tone: 'dim' } : { text: 'closed', tone: 'dim' };
  if (s.readiness?.allReady) return { text: 'ready to merge', tone: 'ok' };
  const failing = open.filter((p) => p.badge.tone === 'bad').length;
  if (failing) return { text: `${failing} failing`, tone: 'bad' };
  const green = open.filter((p) => p.badge.tone === 'ok').length;
  return { text: `${green} of ${open.length} green`, tone: green === open.length ? 'ok' : 'warn' };
}

/** Whether this page shows a stack's members: per stack, for this page only. */
const stackOpen = (id: string): boolean => !!getState().openStacks?.[id];

/** Show or hide a stack's members. */
export function toggleStack(id: string): void {
  const open = { ...(getState().openStacks ?? {}) };
  if (open[id]) delete open[id];
  else open[id] = true;
  setState({ openStacks: open });
}

/** A stack, as a three-layer octicon (stack-16, @primer/octicons, MIT) in the text's color. */
const StackIcon = html`<svg class="pricon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor"><path d="M7.122.392a1.75 1.75 0 0 1 1.756 0l5.003 2.902c.83.481.83 1.68 0 2.162L8.878 8.358a1.75 1.75 0 0 1-1.756 0L2.119 5.456a1.251 1.251 0 0 1 0-2.162ZM8.125 1.69a.248.248 0 0 0-.25 0l-4.63 2.685 4.63 2.685a.248.248 0 0 0 .25 0l4.63-2.685ZM1.601 7.789a.75.75 0 0 1 1.025-.273l5.249 3.044a.248.248 0 0 0 .25 0l5.249-3.044a.75.75 0 0 1 .752 1.298l-5.248 3.044a1.75 1.75 0 0 1-1.756 0L1.874 8.814A.75.75 0 0 1 1.6 7.789Zm0 3.5a.75.75 0 0 1 1.025-.273l5.249 3.044a.248.248 0 0 0 .25 0l5.249-3.044a.75.75 0 0 1 .752 1.298l-5.248 3.044a1.75 1.75 0 0 1-1.756 0l-5.248-3.044a.75.75 0 0 1-.273-1.025Z" /></svg>`;

/**
 * A stack of several PRs as one card, in the PR card's layout: the stack's
 * title; its summary and how many PRs it holds; its repo and last change;
 * Ack stack while it has attention. A click opens it downward in place to
 * every member's own PR card, the bottom of the stack first; another click
 * closes it. The avatar is the top PR's author.
 */
export function StackCard({ s, prs, attention }: { s: GlassStack; prs: GlassPr[]; attention: readonly DeckAttention[] }) {
  const members = stackMembers(s, prs);
  const top = members.at(-1)!;
  const summary = stackSummary(s, prs);
  const at = stackUpdatedAt(prs);
  const open = stackOpen(s.id);
  const title = s.title || top.title || `#${top.number}`;
  const pending = shownPrAttention(attention, prs, [s]).filter((a) => !a.acked);
  // Opening the stack acks what it shows; closing it acks nothing.
  const toggle = () => {
    if (!open) ackOnOpen(pending);
    toggleStack(s.id);
  };
  return Card({
    // A stack with a title of its own carries it as the stack title, as the table and the deck do.
    title: s.title ? html`<span class="stacktitle">${LinkedText(s.title)}</span>` : LinkedText(title),
    titleAttr: title,
    icon: html`<span class="prstate pr-open">${StackIcon}</span>`,
    iconFirst: true,
    state: { word: '', tone: summary.tone, mark: 'edge' },
    status: [
      s.mergeRequest && StatusChip(s.mergeRequest.merging ? 'merging' : 'merges when green', s.mergeRequest.merging ? 'warn' : 'dim'),
      StatusChip(summary.text, summary.tone),
      StatusChip(`${members.length} PRs`, 'dim'),
    ],
    context: [RepoName(s.repo), at && [' · updated ', Age(at), ' ago']],
    contextTitle: [s.repo, at && `updated ${ageText(at)} ago`].filter(Boolean).join(' · '),
    // The Open icon (the top of the stack, as GitHub shows a stack) at the bar's right; opening the stack, or Open, acks it.
    actions: [
      html`<${MergeStackWhenGreen} s=${s} prs=${members} />`,
      html`<${CardLink} href=${reviewLink(top.url)} onOpen=${() => ackOnOpen(pending)} />`,
    ],
    person: prAuthor(top),
    cls: ['prcard stackcard', open && 'open'].filter(Boolean).join(' '),
    attrs: {
      'data-stack': s.id,
      role: 'button',
      tabindex: '0',
      'aria-expanded': String(open),
      onKeyDown: (e: KeyboardEvent) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault();
          toggle();
        }
      },
    },
    onClick: toggle,
    extra:
      open &&
      html`<div class="stackmembers" onClick=${(e: Event) => e.stopPropagation()}>${members.map((p) => prCard(p, { attention }))}</div>`,
  });
}

function prCards(inp: PrsInputs, older: unknown) {
  const { yours, others } = splitMine(prGroups(inp));
  // A stack of several PRs is one card; a lone PR is its own card, whose Ack acks its stack too.
  const stacksOf = (groups: typeof yours) =>
    html`<div class="cards">${groups.map(({ s, prs }) =>
      prs.length > 1
        ? html`<${StackCard} key=${'stack:' + s.id} s=${s} prs=${prs} attention=${inp.prAttention} />`
        : prCard(prs[0]!, { attention: inp.prAttention, stack: s }),
    )}</div>`;
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

/**
 * Opening a PR or stack card (its modal, the stack opening, or Open) acks
 * what it showed, as opening a report marks it read. Quiet: a failure leaves
 * it to ack next time, and a source that can't ack does nothing.
 */
export function ackOnOpen(pending: DeckAttention[]): void {
  if (!pending.length || !can('pr-ack')) return;
  void ackPrAttention(pending).catch(() => {});
}

/** Ack these attention items, with the state hashes this page showed. */
function AckButton({ pending, label, stack }: { pending: DeckAttention[]; label: string; stack?: string }) {
  // Constant for the page's life, so the hooks below always run in the same order.
  if (!can('pr-ack')) return null;
  const ack = async (e: Event) => {
    e.stopPropagation();
    await ackPrAttention(pending);
  };
  return html`<span class="prack" onClick=${(e: Event) => e.stopPropagation()}><${Button} data-stack=${stack} action=${ack} sending="Acknowledging…">${label}<//></span>`;
}

export function PRs({ inp, more }: { inp: PrsInputs; more?: OlderControl }) {
  const older = more && html`<${ShowOlder} kind="prs" more=${more} />`;
  return inp.view === 'cards' ? prCards(inp, older) : prTable(inp, older);
}

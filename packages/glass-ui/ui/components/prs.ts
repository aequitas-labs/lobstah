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
import { Button, type ButtonSize } from './button.js';

/** The PRs tab groups only owned PRs: authored by the viewer or opened by a trap. */
export function prGroups(inp: Pick<PrsInputs, 'prs' | 'stacks'>): Array<{ s: GlassStack; prs: GlassPr[] }> {
  const byStack = new Map<string, GlassPr[]>();
  for (const p of inp.prs) {
    if (!p.mine) continue;
    const members = byStack.get(p.stackId) ?? [];
    members.push(p);
    byStack.set(p.stackId, members);
  }
  return inp.stacks.flatMap((s) => {
    const prs = byStack.get(s.id);
    return prs?.length
      ? [
          {
            s: {
              ...s,
              open: prs.some((pr) => pr.state === 'OPEN'),
              numbers: s.numbers.filter((number) => prs.some((p) => p.number === number)),
            },
            prs,
          },
        ]
      : [];
  });
}

/** How many of the person's own open PRs need them: failed checks, a conflict, or a repair that stopped (a bad badge). */
export function prsNeedingYou(prs: readonly GlassPr[]): number {
  return prs.filter((p) => p.mine && p.state === 'OPEN' && p.badge.tone === 'bad').length;
}

const chainText = (s: GlassStack, prs: GlassPr[]) => stackNumbers(s.numbers, new Map(prs.map((p) => [p.number, p.title])));
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
  const groups = prGroups(inp);
  const rowsOf = (groups: ReturnType<typeof prGroups>) =>
    groups.flatMap(({ s, prs }) => [
      html`<tr key=${'stack:' + s.id}><th colspan="8">${stackTitle(s)}${chainText(s, prs)} · floor ${s.floor}${s.open ? ' · open' : ' · history'}<${PrAck} stack=${s} prs=${prs} attention=${inp.prAttention} />${s.readiness && html`<div class=${s.readiness.allReady ? 'ok' : 'dim'}>${s.readiness.state}</div>`}</th></tr>`,
      ...prs.map(
        (p) =>
          html`<tr key=${p.key} class="rowhead" onClick=${opener('pr', p.key)}><td>${prLink(p)}</td><td class="grow">${LinkedText(p.title)}</td><td><${PrTags} state=${p.badge.state} tags=${prBadgeTags(p)} /></td><td>${prChecks(p)}</td><td>${prReview(p)}</td><td>${prMerge(p)}${p.mergeRequest && [' · ', mergeNote(p)]} <${MergeWhenGreen} p=${p} /></td><td>${watchCell(p.watch)}</td><td>${p.gate || ''}</td></tr>`,
      ),
    ]);
  const cols = ['PR', 'title', 'state', 'checks', 'review', 'merge', 'watch', 'gate'];
  return [Table(cols, rowsOf(groups), PRS_EMPTY), older, otherWatches(inp)];
}

/** How an owned PR gets onto the PRs page. */
const PRS_EMPTY = 'no PRs of yours are watched: a trap’s PR shows here, and `lobstah watch add <url>` adds one you opened';

const METHOD_WORDS = { merge: 'a merge commit', squash: 'one squashed commit', rebase: 'rebased commits' } as const;

/**
 * Merge when green, on a PR of yours: one click asks for it, and the button
 * then reads Cancel merge, one click to stop. It merges the way the repo is
 * set to (`[repos.<key>].mergeMethod`, else the pickup's method), never a
 * choice made here; the hover text names it. A PR repair works a failing or
 * conflicting PR back to green first (the boat's pass).
 */
export function MergeWhenGreen({ p, size = 'md' }: { p: GlassPr; size?: ButtonSize }) {
  // Constant for the page's life, so the hooks below always run in the same order.
  if (!can('pr-merge') || (!p.mine && !p.mergeRequest) || p.state !== 'OPEN') return null;
  const send = (cancel: boolean) => async (e: Event) => {
    e.stopPropagation();
    await requestPrMerge(p.key, cancel);
  };
  const method = p.mergeRequest?.method ?? p.mergeMethod;
  const how = `#${p.number} into ${p.baseRefName ?? 'its base'}${method ? ` as ${METHOD_WORDS[method]}` : ''}`;
  const button = p.mergeRequest
    ? html`<${Button} size=${size} variant="primary" class="on" aria-pressed="true" title=${`Merges ${how} once green; click to cancel`} action=${send(true)} sending="Cancelling merge…" done="Merge cancelled">${ActionIcon.merge}Cancel merge<//>`
    : html`<${Button} size=${size} variant="primary" aria-pressed="false" title=${`Merges ${how} once green`} action=${send(false)} sending="Requesting merge…" done=${`Merges #${p.number} when green`}>${ActionIcon.merge}Merge when green<//>`;
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

/** Local clock time today; include the day for earlier authorizations. */
export function mergeIntentTime(at: string, now = Date.now()): string {
  const date = new Date(at);
  const today = new Date(now);
  if (!Number.isFinite(date.getTime())) return 'Time unavailable';
  const clock = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  if (date.toDateString() === today.toDateString()) return clock;
  const days = Math.abs(today.getTime() - date.getTime()) / 86_400_000;
  const day = date.toLocaleDateString(
    undefined,
    days < 7
      ? { weekday: 'short' }
      : { month: 'short', day: 'numeric', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) },
  );
  return `${day} ${clock}`;
}

const MERGE_METHOD_LABELS = { merge: 'merge commit', squash: 'squash', rebase: 'rebase' } as const;

/** One visible authorization on PR cards, PR details, and matching review rows. */
export function MergeIntent({ p }: { p?: GlassPr }) {
  const request = p?.mergeRequest;
  if (!request) return null;
  return html`<div class="merge-intent"><span class="mergenote">Merge when green</span> · ${request.summary ?? (p.state === 'MERGED' ? 'Merged' : 'Waiting on CI')}
    <div class="dim">You · ${request.by === 'chat' ? 'chat' : 'merge card'} · <time datetime=${request.at} title=${new Date(request.at).toLocaleString()}>${mergeIntentTime(request.at)}</time></div>
    <div class="dim">${MERGE_METHOD_LABELS[request.method]}</div>
    ${request.hold && html`<div>On hold · ${request.hold}</div>`}${request.note && html`<div>${request.note}</div>`}
    ${request.mergeSha && html`<div>Merge commit: <code>${request.mergeSha}</code></div>`}
  </div>`;
}

const mergeNote = (p: GlassPr) => html`<${MergeIntent} p=${p} />`;

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

/** GitHub's lifecycle and draft states, as the shared PR icon displays them. */
export type PrIconState = 'open' | 'draft' | 'merged' | 'closed';

/** The PR icon in GitHub's state color, shared by cards, rows and review headers. */
export function PrStateIcon({ state = 'open' }: { state?: PrIconState }): Children {
  return html`<span class=${'prstate pr-' + state}>${PrIcon}</span>`;
}

/** What a PR-shaped card shows: a PR card, or a review card, which is a PR asking for your review. */
export interface PrCardParts {
  key: string;
  title: Children;
  titleAttr?: string;
  /** GitHub's state for the PR, which colors its icon: open green, draft grey, merged purple, closed red. */
  prState?: PrIconState;
  /** The status chips under the title. */
  status: Children;
  /** The edge on actionable PRs: red when waiting on you, amber in progress, green when ready. */
  tone: CardTone;
  repo: string;
  number: number;
  at?: string;
  /** The trap that has its work, as `wt:<id>`. */
  trap?: string;

  /** Standing merge details below the status chips, outside the clamped meta line. */
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
export const StatusChip = (word: string, cls: string, hover?: string): Children =>
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
  const meta = parts.flatMap((part, i) => (i ? [' · ', part] : [part]));
  const text = [c.repo, c.at && `${ageText(c.at)} ago`, `#${c.number}`, c.trap && `${TRAP_MARK} ${namedText(c.trap)}`]
    .filter(Boolean)
    .join(' · ');
  return html`<${Card}
    key=${c.key}
    title=${c.title}
    titleAttr=${c.titleAttr}
    icon=${html`<${PrStateIcon} state=${c.prState} />`}
    iconFirst
    state=${c.prState === 'merged' || c.prState === 'closed' ? undefined : { word: '', tone: c.tone, mark: 'edge' }}
    status=${[c.status, c.tail]}
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

/** An additional status beside a PR's lifecycle tag, shared by cards, rows and details. */
export interface PrStatusTag {
  word: string;
  tone: CardTone;
  hover?: string;
  unread?: boolean;
}

/** The shared lifecycle and status tags for PRs, stacks and reviews. */
export function PrTags({ state, tags = [] }: { state?: PrIconState; tags?: readonly PrStatusTag[] }): Children {
  return [
    state && StatusChip(PR_STATE_WORD[state], 'pr-' + state),
    ...tags
      .filter((tag) => tag.word.toLowerCase() !== state)
      .map(
        (tag) =>
          html`<span data-review-unread=${tag.unread || undefined} aria-label=${tag.unread ? 'Needs attention' : undefined}>${StatusChip((tag.unread ? '● ' : '') + tag.word, tag.tone, tag.hover)}</span>`,
      ),
  ];
}

/** Actionable PR badges supplement the lifecycle tag; completed PRs need no duplicate status. */
export function prBadgeTags(p: GlassPr): PrStatusTag[] {
  return p.state === 'OPEN' && !p.draft && p.badge.tone !== 'ok'
    ? [{ word: p.badge.text.toLowerCase(), tone: p.badge.tone, hover: /^checks\b/.test(p.badge.text) ? prChecks(p) : undefined }]
    : [];
}

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
    status: html`<${PrTags} state=${state} tags=${prBadgeTags(p)} />`,
    tail: mergeNote(p),
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
  const prState: PrIconState = prs.some((pr) => pr.state === 'OPEN')
    ? 'open'
    : prs.some((pr) => pr.state === 'MERGED')
      ? 'merged'
      : 'closed';
  const actionable = prState === 'open';
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
    icon: html`<span class=${'prstate pr-' + prState}>${StackIcon}</span>`,
    iconFirst: true,
    state: actionable ? { word: '', tone: summary.tone, mark: 'edge' } : undefined,
    status: [
      s.mergeRequest && StatusChip(s.mergeRequest.merging ? 'merging' : 'merges when green', s.mergeRequest.merging ? 'warn' : 'dim'),
      html`<${PrTags} state=${!actionable ? prState : undefined} tags=${actionable ? [{ word: summary.text, tone: summary.tone }] : []} />`,
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
  const groups = prGroups(inp);
  // A stack of several PRs is one card; a lone PR is its own card, whose Ack acks its stack too.
  const stacksOf = (groups: ReturnType<typeof prGroups>) =>
    html`<div class="cards">${groups.map(({ s, prs }) =>
      prs.length > 1
        ? html`<${StackCard} key=${'stack:' + s.id} s=${s} prs=${prs} attention=${inp.prAttention} />`
        : prCard(prs[0]!, { attention: inp.prAttention, stack: s }),
    )}</div>`;
  return [groups.length ? stacksOf(groups) : html`<div class="empty">${PRS_EMPTY}</div>`, older, otherWatches(inp)];
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

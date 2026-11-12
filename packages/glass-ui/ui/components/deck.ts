import type { GlassPr, GlassSnapshot, GlassStack, LandedCatch, WorkerMetadata, Grant } from '@lobstah/core';
import {
  DECK_TRAPS_MAX,
  INFLIGHT_MAX,
  LANDED_MAX,
  REPORTS_MAX,
  catchCount,
  goalLine,
  prBadgeClass,
  reportPageUrl,
} from '../../src/glass-diff.js';
import type { DeckAttention, DeckInputs, GlassPrefs } from '../../src/glass-diff.js';
import { html } from '../html.js';
import type { Children } from '../html.js';
import {
  Age,
  lastPassText,
  Harness,
  NamedText,
  WorkerAddress,
  namedText,
  KIND_TONE,
  ageText,
  badgeLong,
  badgeTitle,
  NewTrap,
  opener,
  prName,
  stackNumbers,
  stackTitle,
  startCommands,
  trapNow,
  trapNowText,
  trapDisplayName,
  trapScope,
  windowAction,
  dispatchContext,
  verbState,
  VerbChip,
  verbTone,
} from './common.js';
import { GrantChip } from './session-grants.js';
import { trapCard } from './traps.js';
import { dispatchCard } from './dispatches.js';
import { Card } from './card.js';
import { getState } from '../store.js';
import { reportCard, reportMeta } from './reports.js';
import { PrAck, prCard } from './prs.js';
import { DeckDecisions } from './decisions.js';
import { LinkedText } from './links.js';
import { Todos } from './todos.js';
import type { DecisionDraft } from '../store.js';
import { visibleTabs } from '../backend.js';
import type { GlassTab } from '../../src/glass-diff.js';

/**
 * On deck: decisions (full-row cards), in flight, landed in the last 24h, reviews waiting on you (only when some are), reports, traps,
 * and open PR stacks. The dispatch, trap, and landed items follow the site-wide view;
 * decisions are always full-row cards; PRs have their own stack presentation.
 */

interface DeckItem {
  key: string;
  title: Children;
  /** Trap-only secondary context beside Open, with its stable address on the name. */
  trap?: { address: string; scope: string };
  badge?: { text: string; tone?: string; worker?: Partial<WorkerMetadata> };
  worker?: WorkerMetadata;
  meta?: Children;
  /** The meta line as text: a card clamps it to two lines and shows the rest on hover. */
  metaText?: string;
  /** A control at the right end of the card's foot line, or the row's end. */
  action?: Children;
  /** A page this item opens in a new tab, instead of `open`. */
  href?: string;
  /** A block under the card or line: a starting trap's start commands. */
  extra?: Children;
  /** The item's own card, used as is in the cards view: a trap's, a dispatch's. */
  card?: Children;
  /** The item's own row, used as is in the list view: a dispatch's two-line row. */
  row?: Children;
  open?: () => void;
  acked?: boolean;
}

type View = GlassPrefs['view'] | undefined;

/**
 * A dispatch on the deck in the list view: two lines, the same parts as its
 * card. Line 1 is its instruction and status chip; line 2 its repo and trap,
 * with its age at the right.
 */
function dispatchRow(p: {
  key: string;
  title: Children;
  titleAttr: string;
  verb: string;
  context: Children;
  /** When it took its verb. */
  at?: string;
  /** What a paused or questioning worker waits on. */
  waitingOn?: string;
  open: () => void;
}) {
  return html`<div key=${p.key} class="deckrow click" onClick=${p.open}>
    <div class="gline"><b class="gtitle" title=${p.titleAttr}>${p.title}</b><span class="gfill"></span>${VerbChip(p.verb, p.at, p.waitingOn)}</div>
    <div class="gline dim"><span class="gtext">${p.context}</span>${p.at && html`<span class="gright">${Age(p.at)} ago</span>`}</div>
  </div>`;
}

/** A landed catch's title: its dispatch's, while the snapshot still lists it; else its note's first line; else its id. */
const landedTitle = (x: LandedCatch): string =>
  getState().snapshot?.dispatches.find((d) => d.id === x.id)?.title || (x.note ?? '').split('\n')[0]!.trim() || x.id.slice(0, 8);

function deckItem(it: DeckItem, view: View) {
  const badge =
    it.badge &&
    (it.badge.worker
      ? html`<${Harness} worker=${it.badge.worker} label=${it.badge.text} cls=${'badge ' + (it.badge.tone || 'dim')} compact />`
      : html`<span class=${'badge ' + (it.badge.tone || 'dim') + badgeLong(it.badge.text)} title=${badgeTitle(it.badge.text)}>${it.badge.text}</span>`);
  const worker = it.worker && html`<${Harness} worker=${it.worker} />`;
  if (view === 'cards' && it.card) return it.card;
  if (it.href) {
    // A page of its own, in a new tab (a report).
    const cls = (view === 'cards' ? 'card' : 'deckline click') + (it.acked ? ' acked' : '');
    return view === 'cards'
      ? html`<a key=${it.key} class=${cls} href=${it.href} target="_blank" rel="noopener"><div class="top"><b>${it.title}</b>${badge}</div>${it.meta && html`<div class="meta" title=${it.metaText}>${it.meta}</div>`}</a>`
      : html`<a key=${it.key} class=${cls} href=${it.href} target="_blank" rel="noopener">${badge && [badge, ' ']}<b>${it.title}</b>${it.meta && [' ', html`<span class="dim">· ${it.meta}</span>`]}</a>`;
  }
  if (view !== 'cards' && it.row) return it.row;
  if (view === 'cards')
    return html`<div key=${it.key} class=${'card' + (it.acked ? ' acked' : '')} onClick=${it.open} style=${it.open ? undefined : 'cursor:default'}><div class="top"><b title=${it.trap?.address}>${it.title}</b>${worker}${badge}</div>${it.meta && html`<div class="meta" title=${it.metaText}>${it.meta}</div>`}${it.extra}${(it.action || it.trap?.scope) && html`<div class="foot">${it.trap?.scope && html`<span class="trap-scope" title=${it.trap.scope}>${it.trap.scope}</span>`}<span class="footact">${it.action}</span></div>`}</div>`;
  if (it.trap)
    return html`<div key=${it.key} class="deckline trap-deckline click" onClick=${it.open}><div class="trap-heading"><b title=${it.trap.address}>${it.title}</b>${badge}${it.meta && html`<span class="dim">${it.meta}</span>`}</div><div class="trap-secondary">${it.trap.scope && html`<span class="trap-scope" title=${it.trap.scope}>${it.trap.scope}</span>`}<span class="footact">${it.action}</span></div>${it.extra}</div>`;
  return html`<div key=${it.key} class=${'deckline' + (it.open ? ' click' : '') + (it.acked ? ' acked' : '')} onClick=${it.open}>${badge && [badge, ' ']}<b>${it.title}</b>${worker && [' ', worker]}${it.meta && [' ', html`<span class="dim">· ${it.meta}</span>`]}${it.action && [' ', html`<span class="dim">· </span>`, it.action]}${it.extra}</div>`;
}

const more = (n: number, tab: string) => n > 0 && html`<a class="deckmore" href=${'#' + tab}>+${n} more →</a>`;

/** What an empty deck section says, where "none" doesn't say what is missing. */
const EMPTY: Record<string, string> = { 'in flight': 'nothing in flight', reports: 'no reports yet' };

function deckBlock(title: string, items: DeckItem[], tab: GlassTab, max: number, view: View, headAction?: Children) {
  // A section for a tab this page's source does not fill is not shown, empty or otherwise.
  if (!visibleTabs().includes(tab)) return null;
  const shown = items.slice(0, max);
  const lines = shown.map((i) => deckItem(i, view));
  const body = shown.length
    ? view === 'cards'
      ? html`<div class="cards">${lines}</div>`
      : lines
    : html`<div class="empty">${EMPTY[title] ?? 'none'}</div>`;
  return html`<section><h2><a href=${'#' + tab}>${title} →</a></h2>${headAction && html`<div class="tabhead">${headAction}</div>`}${body}${more(items.length - shown.length, tab)}</section>`;
}

function deckStack(
  s: GlassStack,
  members: GlassPr[],
  standing: Map<string, DeckAttention[]>,
  view: View,
  attention: readonly DeckAttention[],
) {
  const ack = html`<${PrAck} stack=${s} prs=${members} attention=${attention} />`;
  const next = members.find((p) => p.number === s.nextNumber) || members[0];
  const chain = stackNumbers(s.numbers, new Map(members.map((p) => [p.number, p.title])));
  const nextText = next ? 'next #' + next.number : 'nothing mergeable';
  if (view === 'cards') {
    // An acked PR is greyed, as an acked report is.
    const card = (p: GlassPr) => {
      const kinds = standing.get(p.key) || [];
      return prCard(p, { quiet: kinds.length > 0 && kinds.every((a) => a.acked), attention, stack: members.length === 1 ? s : undefined });
    };
    // A lone PR's card has its own Ack; a stack of several keeps Ack stack on its line.
    return html`<div key=${s.id} class="deckstack"><div class="dim">${stackTitle(s)}${chain} · ${nextText}${members.length > 1 && ack}</div>${s.readiness && html`<div class=${s.readiness.allReady ? 'ok' : 'dim'}>${s.readiness.state}</div>`}<div class="cards">${members.map(card)}</div></div>`;
  }
  const badges = members.flatMap((p) =>
    (standing.get(p.key) || []).map(
      (a) =>
        html`<span class=${'badge ' + (KIND_TONE[a.kind] || prBadgeClass(p.badge)) + (a.acked ? ' acked' : '')}>#${p.number} ${p.badge.text}</span>`,
    ),
  );
  const spaced = badges.flatMap((b, i) => (i ? [' ', b] : [b]));
  const lone = members.length === 1 ? members[0] : undefined;
  return html`<div key=${s.id} class=${'deckline' + (next ? ' click' : '')} onClick=${next && opener('pr', next.key)}>${stackTitle(s)}${lone ? prName(lone) : html`<b>${chain}</b>`} <span class="dim">· ${nextText}</span>${badges.length > 0 && [' · ', spaced]}${ack}${s.readiness && html`<div class=${s.readiness.allReady ? 'ok' : 'dim'}>${s.readiness.state}</div>`}${!lone && members.map((p) => html`<div key=${p.key} class="deckmember dim">${prName(p)}</div>`)}</div>`;
}

function deckPrs(inp: DeckInputs, view: View) {
  if (!visibleTabs().includes('prs')) return null;
  const shown = inp.stacks.slice(0, 3);
  const standing = new Map<string, DeckAttention[]>();
  for (const a of inp.prAttention) {
    const kinds = standing.get(a.key) || [];
    kinds.push(a);
    standing.set(a.key, kinds);
  }
  const body = shown.length
    ? shown.map((s) =>
        deckStack(
          s,
          inp.prs.filter((p) => p.stackId === s.id).sort((a, b) => a.position - b.position),
          standing,
          view,
          inp.prAttention,
        ),
      )
    : html`<div class="empty">none</div>`;
  return html`<section><h2><a href="#prs">PRs →</a></h2>${body}${more(inp.stacks.length - shown.length, 'prs')}</section>`;
}

export function Deck({
  inp,
  goals = [],
  passes = [],
  grants = [],
  drafts,
  focus,
  viewedHere,
  unread,
}: {
  inp: DeckInputs;
  goals?: GlassSnapshot['goals'];
  passes?: GlassSnapshot['helmPasses'];
  grants?: Grant[];
  drafts: Record<string, DecisionDraft>;
  focus: string | null;
  viewedHere: Record<string, true>;
  unread: number;
}) {
  const shownGoals = goals.filter((g) => g.lines.length);
  const view = inp.view;
  const flight = inp.inflight.map((x): DeckItem => ({
    card: dispatchCard(x),
    row: dispatchRow({
      key: x.lane + ':' + x.id,
      title: x.title || x.id.slice(0, 8),
      titleAttr: `${x.id.slice(0, 8)} · ${x.title}`,
      verb: x.verb,
      context: dispatchContext(x.repo, x.for || x.claimedBy),
      at: x.verbAt,
      waitingOn: x.waiting?.on,
      open: opener('dispatch', x.lane + ':' + x.id),
    }),
    key: x.lane + ':' + x.id,
    title: [x.id.slice(0, 8), ' ', x.repo || ''],
    worker: x.worker,
    badge: { text: x.verb, tone: verbTone(x.verb) },
    // No time at all (no log, no queue time): drop the fragment, not render "· ago".
    meta: [
      NamedText(x.note || '', 90),
      x.verbAt && [' · ', Age(x.verbAt), ' ago'],
      (x.for || x.claimedBy) && [' · ', WorkerAddress((x.for || x.claimedBy)!)],
    ],
    metaText: [namedText(x.note || ''), x.verbAt && `${ageText(x.verbAt)} ago`, namedText(x.for || x.claimedBy || '')]
      .filter(Boolean)
      .join(' · '),
    open: opener('dispatch', x.lane + ':' + x.id),
  }));
  const landed = inp.landed.map((x): DeckItem => {
    const title = landedTitle(x);
    const trap = getState().snapshot?.dispatches.find((d) => d.id === x.id);
    const context = [
      dispatchContext(x.repo, trap?.for || trap?.claimedBy),
      x.unreported && [' ', html`<span class="badge warn unreported">unreported</span>`],
    ];
    const open = opener('dispatch', x.lane + ':' + x.id);
    return {
      card: html`<${Card}
      key=${x.key}
      title=${title}
      titleAttr=${`${x.id.slice(0, 8)} · ${title}`}
      state=${verbState(x.verb, x.at)}
      context=${[context, ' · ', Age(x.at), ' ago']}
      onClick=${open}
    />`,
      row: dispatchRow({ key: x.key, title, titleAttr: `${x.id.slice(0, 8)} · ${title}`, verb: x.verb, context, at: x.at, open }),
      key: x.key,
      title: [x.id.slice(0, 8), ' ', x.repo || '', x.unreported && [' ', html`<span class="badge warn unreported">unreported</span>`]],
      badge: { text: x.verb, tone: verbTone(x.verb) },
      meta: [NamedText(x.note || '', 90), ' · ', Age(x.at), ' ago'],
      metaText: `${namedText(x.note || '')} · ${ageText(x.at)} ago`,
      open,
    };
  });
  const reports = inp.reports.map((r): DeckItem => {
    const meta = reportMeta(r);
    return {
      card: reportCard(r),
      key: r.key,
      title: r.title,
      meta: meta.nodes,
      metaText: meta.text,
      href: reportPageUrl(r.key),
      acked: !!r.acked,
    };
  });
  const traps = inp.traps.map(({ x: t }): DeckItem => ({
    key: t.trapId,
    title: '🪤 ' + trapDisplayName(t),
    trap: { address: `wt:${t.trapId}`, scope: trapScope(t) },
    badge: t.requested
      ? { text: 'requested', tone: 'dim' }
      : t.starting
        ? { text: t.starting.failedAt ? 'start failed' : 'starting', tone: t.starting.failedAt ? 'bad' : 'warn' }
        : { text: t.live ? t.harness || 'live' : 'signed off', tone: t.live ? 'ok' : 'dim', worker: t.live ? t : undefined },
    meta: [
      html`<${GrantChip} session=${t.sessionId} grants=${grants} />`,
      html`<span class="catchn" title="catches">🦞 ${catchCount(t.totalCatches ?? 0)}</span>`,
      ' · ',
      trapNow(t),
    ],
    metaText: `🦞 ${catchCount(t.totalCatches ?? 0)} · ${trapNowText(t)}`,
    action: windowAction(t),
    extra: startCommands(t),
    card: trapCard(t),
    open: opener('trap', t.trapId),
  }));
  return [
    shownGoals.length > 0 &&
      html`<div id="daily-goals" aria-label="Today's goals">${shownGoals.map(
        (g) =>
          html`<section key=${g.grounds} class="goals-callout"><h2>Today's goals · ${g.grounds} · ${g.date}</h2><div class="dim">${lastPassText(passes.find((pass) => pass.grounds === g.grounds)?.lastPassAt)}</div><ol>${g.lines.map(
            (line, i) => {
              const goal = goalLine(line);
              return html`<li class=${goal.done ? 'done' : undefined}><label class="goal-check"><input type="checkbox" checked=${goal.done} disabled aria-label=${`Goal ${i + 1}: ${goal.text}`} title=${`Read-only; use lobstah goals ${goal.done ? 'undo' : 'done'} ${i + 1} --grounds ${g.grounds}`} /><span>${goal.done ? html`<s>${LinkedText(goal.text)}</s>` : LinkedText(goal.text)}</span></label></li>`;
            },
          )}</ol></section>`,
      )}</div>`,
    html`<div class="deckgrid"><${DeckDecisions} cards=${inp.decisions} drafts=${drafts} focus=${focus} viewedHere=${viewedHere} unread=${unread} recentRuns=${inp.recentRuns} />${deckBlock('in flight', flight, 'dispatches', INFLIGHT_MAX, view)}${deckBlock('Landed · 24h', landed, 'dispatches', LANDED_MAX, view)}${deckBlock('reports', reports, 'reports', REPORTS_MAX, view)}<${Todos} passes=${passes} todos=${inp.todos} note=${inp.todoNote} preview />${deckBlock('traps', traps, 'traps', DECK_TRAPS_MAX, view, html`<${NewTrap} />`)}${deckPrs(inp, view)}</div>`,
  ];
}

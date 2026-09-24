import { LANDED_MAX, prBadgeClass } from '../../../src/glass-diff.js';
import type { DeckAttention, DeckInputs, GlassPrefs } from '../../../src/glass-diff.js';
import type { GlassPr, GlassStack } from '@lobstah/core';
import { html, join } from '../html.js';
import type { Html } from '../html.js';
import { KIND_TONE, ageEl, kindCell, kindLabel, openDispatch, openTrap, prOpen, table, trapRow } from './common.js';

/**
 * On deck: attention, in flight, landed in the last 24h, traps, and open PR
 * stacks. The dispatch, trap, and landed items follow the site-wide view;
 * attention is always a notices table; PRs have their own stack presentation.
 */

interface DeckItem {
  title: Html;
  badge?: { text: string; tone?: string };
  meta?: Html;
  /** The inline handler that opens the item's modal. */
  open?: Html;
  acked?: boolean;
}

type View = GlassPrefs['view'] | undefined;

function deckItem(it: DeckItem, view: View): Html {
  const badge = it.badge ? html`<span class="badge ${it.badge.tone || 'dim'}">${it.badge.text}</span>` : html``;
  const click = it.open ? html` onclick="${it.open}"` : '';
  const meta = it.meta && it.meta.value ? it.meta : null;
  if (view === 'cards')
    return html`<div class="card${it.acked && ' acked'}"${click}${!it.open && ' style="cursor:default"'}><div class="top"><b>${it.title}</b>${badge}</div>${meta && html`<div class="meta">${meta}</div>`}</div>`;
  return html`<div class="deckline${it.open && ' click'}${it.acked && ' acked'}"${click}>${badge.value && html`${badge} `}<b>${it.title}</b>${meta && html` <span class="dim">· ${meta}</span>`}</div>`;
}

const more = (n: number, tab: string) => n > 0 && html`<a class="deckmore" href="#${tab}">+${n} more →</a>`;

function deckBlock(title: string, items: DeckItem[], tab: string, max: number, view: View): Html {
  const shown = items.slice(0, max);
  const lines = shown.map((i) => deckItem(i, view));
  const body = shown.length
    ? view === 'cards'
      ? html`<div class="cards">${lines}</div>`
      : join(lines)
    : html`<div class="empty">none</div>`;
  return html`<section><h2><a href="#${tab}">${title} →</a></h2>${body}${more(items.length - shown.length, tab)}</section>`;
}

function deckNotices(list: DeckAttention[]): Html {
  const shown = list.slice(0, 4);
  const rows = shown.map(
    (x) =>
      html`<tr class="rowhead${x.acked && ' acked'}" onclick="${openDispatch(x.lane, x.id)}"><td>${kindCell(x)}</td><td class="grow">${x.note || x.verb}</td><td>${x.repo || ''}</td><td>${ageEl(x.at)}</td></tr>`,
  );
  return html`<section><h2><a href="#notices">attention →</a></h2>${table(['kind', 'note', 'repo', 'age'], rows, 'none')}${more(list.length - shown.length, 'notices')}</section>`;
}

function deckStack(s: GlassStack, members: GlassPr[], standing: Map<string, DeckAttention[]>, view: View): Html {
  const next = members.find((p) => p.number === s.nextNumber) || members[0];
  const chain = s.numbers.map((n) => '#' + n).join(' → ');
  const nextText = next ? 'next #' + next.number : 'nothing mergeable';
  if (view === 'cards') {
    const card = (p: GlassPr) => {
      const kinds = standing.get(p.key) || [];
      const acked = kinds.length > 0 && kinds.every((a) => a.acked);
      const badges = kinds.length
        ? kinds.map((a) => html`<span class="badge ${KIND_TONE[a.kind] || 'dim'}">${kindLabel(a.kind)}</span>`)
        : html`<span class="badge ${prBadgeClass(p.badge)}">${p.badge.text}</span>`;
      return html`<div class="card${acked && ' acked'}" onclick="${prOpen(p)}"><div class="top"><b>#${p.number} ${p.title || ''}</b>${badges}</div><div class="meta">${p.repo} · ${p.badge.text}${acked && ' · acked'}</div></div>`;
    };
    return html`<div class="deckstack"><div class="dim">${chain} · ${nextText}</div><div class="cards">${members.map(card)}</div></div>`;
  }
  const badges = join(
    members.flatMap((p) =>
      (standing.get(p.key) || []).map(
        (a) =>
          html`<span class="badge ${KIND_TONE[a.kind] || prBadgeClass(p.badge)}${a.acked && ' acked'}">#${p.number} ${p.badge.text}</span>`,
      ),
    ),
    ' ',
  );
  const open = next && html` onclick="${prOpen(next)}"`;
  return html`<div class="deckline${next && ' click'}"${open}><b>${chain}</b> <span class="dim">· ${nextText}</span>${badges.value && html` · ${badges}`}</div>`;
}

function deckPrs(inp: DeckInputs, view: View): Html {
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
        ),
      )
    : html`<div class="empty">none</div>`;
  return html`<section><h2><a href="#prs">PRs →</a></h2>${body}${more(inp.stacks.length - shown.length, 'prs')}</section>`;
}

export function renderDeck(inp: DeckInputs): Html {
  const view = inp.view;
  const flight = inp.inflight.map((x): DeckItem => ({
    title: html`${x.id.slice(0, 8)} ${x.repo || ''}`,
    badge: { text: x.verb, tone: x.verb === 'needs-decision' || x.verb === 'blocked' ? 'bad' : 'dim' },
    meta: html`${(x.note || '').slice(0, 90)} · ${ageEl(x.verbAt)} ago${(x.for || x.claimedBy) && html` · ${x.for || x.claimedBy}`}`,
    open: openDispatch(x.lane, x.id),
  }));
  const landed = inp.landed.map((x): DeckItem => ({
    title: html`${x.id.slice(0, 8)} ${x.repo || ''}${x.unreported && html` <span class="badge warn unreported">unreported</span>`}`,
    badge: { text: x.verb, tone: x.verb === 'failed' ? 'bad' : 'ok' },
    meta: html`${(x.note || '').slice(0, 90)} · ${ageEl(x.at)} ago`,
    open: openDispatch(x.lane, x.id),
  }));
  const traps = inp.traps.map(({ x: t }): DeckItem => ({
    title: html`🪤 wt:${t.trapId}`,
    badge: { text: t.live ? t.harness || 'live' : 'signed off', tone: t.live ? 'ok' : 'dim' },
    meta: html`${t.repo || ''} · ${t.live ? trapRow(t).listen : 'stowed / ghosted'}`,
    open: openTrap(t.trapId),
  }));
  return html`<div class="deckgrid">${deckNotices(inp.attention)}${deckBlock('in flight', flight, 'dispatches', 4, view)}${deckBlock('Landed · 24h', landed, 'dispatches', LANDED_MAX, view)}${deckBlock('traps', traps, 'traps', 3, view)}${deckPrs(inp, view)}</div>`;
}

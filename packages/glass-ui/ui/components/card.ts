import type { Children } from '../html.js';
import { html } from '../html.js';

/**
 * The glass's one card: up to four lines with the same parts in the same
 * places, on the local and the hosted glass, at every width.
 *
 * - Line 1: the title, its icon right after it, and the state at the right.
 * - Line 2: the context, with the card's one action at the right.
 * - Line 3: what is happening now.
 * - Line 4, under a thin divider: where it is, with a count or time at the right.
 *
 * State is shown one of two ways. A chip (a lowercase word in a pill) is for
 * state you read; an edge (a colored left border plus the word) is for state
 * you act on. Lines 3 and 4 are left out when a card has nothing for them.
 */

export type CardTone = 'ok' | 'warn' | 'bad' | 'dim';

export interface CardState {
  /** One lowercase word or short phrase: "working", "idle", "signed off". */
  word: string;
  tone: CardTone;
  /** chip: state you read. edge: state you act on. */
  mark: 'chip' | 'edge';
}

export interface CardProps {
  title: Children;
  /** The title's hover text: the item's full name or address. */
  titleAttr?: string;
  /** A small mark after the title: a harness, a kind. */
  icon?: Children;
  state?: CardState;
  context?: Children;
  contextTitle?: string;
  /** The card's one action, at the right of line 2. */
  action?: Children;
  now?: Children;
  nowTitle?: string;
  foot?: { left: Children; right?: Children };
  /** A block after the lines: a starting trap's start commands. */
  extra?: Children;
  /** Greyed: signed off, read, done. */
  quiet?: boolean;
  onClick?: () => void;
}

export function Card(p: CardProps) {
  const mark = p.state?.mark;
  const cls = ['card gcard', mark === 'edge' && `gcard-edge ${p.state!.tone}`, p.quiet && 'dim quiet'].filter(Boolean).join(' ');
  const state =
    p.state &&
    (mark === 'chip'
      ? html`<span class=${'gchip ' + p.state.tone}>${p.state.word}</span>`
      : html`<span class=${'gword ' + p.state.tone}>${p.state.word}</span>`);
  return html`<div class=${cls} onClick=${p.onClick} style=${p.onClick ? undefined : 'cursor:default'}>
    <div class="gline gtop"><b class="gtitle" title=${p.titleAttr}>${p.title}</b>${p.icon && html`<span class="gicon">${p.icon}</span>`}<span class="gfill"></span>${state}</div>
    ${(p.context || p.action) && html`<div class="gline gcontext"><span class="gtext" title=${p.contextTitle}>${p.context}</span>${p.action && html`<span class="gaction">${p.action}</span>`}</div>`}
    ${p.now && html`<div class="gline gnow dim"><span class="gtext" title=${p.nowTitle}>${p.now}</span></div>`}
    ${p.foot && html`<div class="gline gfoot dim"><span class="gtext">${p.foot.left}</span>${p.foot.right && html`<span class="gright">${p.foot.right}</span>`}</div>`}
    ${p.extra}
  </div>`;
}

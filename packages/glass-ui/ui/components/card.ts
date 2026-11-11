import { useState } from 'preact/hooks';
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
  /** More classes for the card itself. */
  cls?: string;
  /** Attributes for the card itself: an id or data- attribute a link looks for, a role, a key handler. */
  attrs?: Record<string, unknown>;
}

/** A pull request, as a small line icon in the text's color. */
export const PrIcon = html`<svg class="pricon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" /></svg>`;

/** A card's ↗ Open (or other link) at the right of line 2: a new tab, and the card's own click never fires. */
export const CardLink = ({ href, label = '↗ Open', onOpen }: { href: string; label?: string; onOpen?: () => void }) =>
  html`<a class="btn open" href=${href} target="_blank" rel="noopener" onClick=${(e: Event) => {
    e.stopPropagation();
    onOpen?.();
  }}>${label}</a>`;

export function Card(p: CardProps) {
  const mark = p.state?.mark;
  const cls = ['card gcard', mark === 'edge' && `gcard-edge gedge-${p.state!.tone}`, p.quiet && 'dim quiet', p.cls]
    .filter(Boolean)
    .join(' ');
  // A word over 12 characters may shrink (class long, never below 12) and carries itself as a title.
  const long = !!p.state && p.state.word.length > 12;
  const state =
    p.state &&
    html`<span class=${(mark === 'chip' ? 'gchip ' : 'gword ') + p.state.tone + (long ? ' long' : '')} title=${long ? p.state.word : undefined}>${p.state.word}</span>`;
  return html`<div ...${p.attrs ?? {}} class=${cls} onClick=${p.onClick} style=${p.onClick ? undefined : 'cursor:default'}>
    <div class="gline gtop"><b class="gtitle" title=${p.titleAttr}>${p.title}</b>${p.icon && html`<span class="gicon">${p.icon}</span>`}<span class="gfill"></span>${state}</div>
    ${(p.context || p.action) && html`<div class="gline gcontext"><span class="gtext" title=${p.contextTitle}>${p.context}</span>${p.action && html`<span class="gaction">${p.action}</span>`}</div>`}
    ${p.now && html`<div class="gline gnow dim"><span class="gtext" title=${p.nowTitle}>${p.now}</span></div>`}
    ${p.foot && html`<div class="gline gfoot dim"><span class="gtext">${p.foot.left}</span>${p.foot.right && html`<span class="gright">${p.foot.right}</span>`}</div>`}
    ${p.extra}
  </div>`;
}

/**
 * A card with no details page of its own (a grant, a boat): a tap expands it
 * in place to show what left its two lines. Clicks inside what it shows
 * (buttons, a form) leave it open.
 */
export function ExpandingCard(p: CardProps & { more: Children }) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen(!open);
  const { more, ...card } = p;
  return Card({
    ...card,
    cls: [p.cls, 'gexpand', open && 'open'].filter(Boolean).join(' '),
    attrs: {
      ...p.attrs,
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
    extra: open && html`<div class="gmore" onClick=${(e: Event) => e.stopPropagation()}>${more}</div>`,
  });
}

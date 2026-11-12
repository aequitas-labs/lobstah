import { useEffect, useRef, useState } from 'preact/hooks';
import type { Children } from '../html.js';
import { html } from '../html.js';
import { Button } from './button.js';

/**
 * The glass's one card: up to four lines with the same parts in the same
 * places, on the local and the hosted glass, at every width.
 *
 * - Line 1: the title, its icon right after it, and the state at the right.
 * - Line 2: the context, with the card's one action at the right.
 * - Line 3: what is happening now.
 * - Line 4, under a thin divider: where it is, with a count or time at the right.
 * - A PR or review card instead puts status chips under the title and its
 *   buttons in a bar along the bottom (prs.ts prShapedCard).
 *
 * State is shown one of two ways. A chip (a lowercase word in a pill) is for
 * state you read; an edge (a colored left border plus the word) is for state
 * you act on. Lines 3 and 4 are left out when a card has nothing for them.
 */

export type CardTone = 'ok' | 'warn' | 'bad' | 'dim' | 'info';

export interface CardState {
  /** One lowercase word or short phrase: "working", "idle", "signed off". */
  word: string;
  tone: CardTone;
  /** chip: state you read. edge: state you act on. */
  mark: 'chip' | 'edge';
  /** Shown in place of the chip: a dispatch's verb icon in its pill, which carries the word as its name. */
  icon?: Children;
}

/** The person a card is about, shown as a small avatar chip at its top right: a PR's author, a review's asker. */
export interface CardPerson {
  login: string;
  /** Their display name, when known. */
  name?: string;
  /** Their GitHub avatar; without one, or when it can't load, the chip shows their initials. */
  avatarUrl?: string;
  /** What they are to the card, for the hover text: "author", "requested by". */
  role: string;
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
  /** The icon leads the title instead of following it: a PR card's PR icon. */
  iconFirst?: boolean;
  /**
   * Status chips on their own line under the title, leaving the title the
   * whole first line. `state` then only sets the edge; its word is not shown.
   */
  status?: Children;
  /** The card's buttons, in a bar along its bottom. A click there never opens the card. */
  actions?: Children;
  onClick?: () => void;
  /** More classes for the card itself. */
  cls?: string;
  /** Attributes for the card itself: an id or data- attribute a link looks for, a role, a key handler. */
  attrs?: Record<string, unknown>;
  /** The person it is about, as an avatar chip at the top right; their name shows only on hover. */
  person?: CardPerson;
  /** Where the card opens outside the glass, as an arrow at the far right of its top line: a report card's way out. */
  open?: CardOpen;
}

/**
 * A card's way out: a link it opens in a new tab, or a control of its own (a
 * trap's best route), drawn as the arrow. Either way it sits at the far right
 * of the top line, the same place on every card, and a click on it never
 * opens the card.
 */
export type CardOpen =
  | {
      href: string;
      label: string;
      onOpen?: () => void;
      /** Opens it in the glass instead (a report's sheet); it decides whether a click wanted a new tab after all. */
      here?: (e: Event) => void;
    }
  | { control: Children };

/** A pull request, as a small line icon in the text's color. */
export const PrIcon = html`<svg class="pricon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" /></svg>`;

/**
 * A card's Open button, last in its bottom bar and pushed to its right, the
 * same corner on every card: the open icon alone, named by its label (Open,
 * Open draft). A new tab, and the card's own click never fires.
 */
export const CardLink = ({ href, label = 'Open', onOpen }: { href: string; label?: string; onOpen?: () => void }) =>
  html`<${Button} variant="icon" class="open gopenbtn" href=${href} target="_blank" rel="noopener" aria-label=${label} title=${label} onClick=${(
    e: Event,
  ) => {
    e.stopPropagation();
    onOpen?.();
  }}>${OpenIcon}<//>`;

const actionIcon = (body: string) =>
  html`<svg class="acticon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" dangerouslySetInnerHTML=${{ __html: body }}></svg>`;

/**
 * The icons beside a card action's words, in its big button and its menu:
 * merge, draft a review, approve, request changes, publish a draft, skip,
 * and the ▾ that opens the menu. Each sits beside its words, never alone.
 */
export const ActionIcon = {
  merge: actionIcon(
    '<circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="8" r="1.6"/><path d="M4.5 5.1v5.8M4.5 5.1c0 2.4 2.4 2.9 5.4 2.9"/>',
  ),
  draft: actionIcon('<path d="M3 13.5h3.2l7-7a1.6 1.6 0 0 0-2.2-2.2l-7 7z"/><path d="M10 5.3l2.2 2.2"/>'),
  approve: actionIcon('<circle cx="8" cy="8" r="6.2"/><path d="M5.3 8.2l1.9 1.9 3.6-3.8"/>'),
  changes: actionIcon('<circle cx="8" cy="8" r="6.2"/><path d="M8 4.8v3.8M8 11.2h.01"/>'),
  publish: actionIcon('<path d="M14 2L1.8 7.2l4.8 1.8L14 2zM6.6 9l1.8 4.8L14 2"/>'),
  skip: actionIcon('<path d="M3 3.5l5.5 4.5L3 12.5zM9.5 3.5l5 4.5-5 4.5M13 3.5v9"/>'),
  caret: actionIcon('<path d="M4.5 6.5L8 10l3.5-3.5"/>'),
};

/** One of a card's other actions, in its ▾ menu. */
export interface MenuAction {
  label: string;
  icon?: Children;
  title?: string;
  disabled?: boolean;
  onClick: (e: Event) => void;
}

/**
 * A card's main action as one big button, with a ▾ that opens the rest as a
 * small menu, each with its icon beside its words. With nothing else to
 * offer it is the big button alone. The menu closes on a pick, a click
 * elsewhere, or Escape; clicks inside it never reach the card.
 */
export function SplitButton({ main, more }: { main: Children; more: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('click', away, true);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('click', away, true);
      document.removeEventListener('keydown', esc, true);
    };
  }, [open]);
  if (!more.length) return main;
  return html`<span class="split" ref=${box} onClick=${(e: Event) => e.stopPropagation()}>${main}<span class="cmenu"><${Button} variant="icon" class="splitcaret"
        aria-haspopup="menu"
        aria-expanded=${open ? 'true' : 'false'}
        aria-label="More actions"
        title="More actions"
        onClick=${() => setOpen(!open)}
      >${ActionIcon.caret}<//>${
        open &&
        html`<span class="cmenulist" role="menu">${more.map(
          (m) =>
            html`<button type="button" role="menuitem" class="cmenuitem" title=${m.title} disabled=${m.disabled} onClick=${(e: Event) => {
              setOpen(false);
              m.onClick(e);
            }}>${m.icon}<span>${m.label}</span></button>`,
        )}</span>`
      }</span></span>`;
}

/** Opening outside the glass: GitHub's Octicon "link-external" (link-external-16, @primer/octicons, MIT), in the text's color. */
export const OpenIcon = html`<svg class="openicon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor"><path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z" /></svg>`;

/** A card's open arrow at the far right of its top line: a new tab, and the card's own click never fires. */
export function OpenArrow({ open }: { open: CardOpen }) {
  if ('control' in open) return html`<span class="gopen" onClick=${(e: Event) => e.stopPropagation()}>${open.control}</span>`;
  return html`<a class="gopen" href=${open.href} target="_blank" rel="noopener" title=${open.label} aria-label=${open.label} onClick=${(
    e: Event,
  ) => {
    e.stopPropagation();
    open.onOpen?.();
    open.here?.(e);
  }}>${OpenIcon}</a>`;
}

/** A repo, as a small line icon in the text's color: GitHub's Octicon "repo" (repo-16, @primer/octicons, MIT), sized to a 12px subtitle. */
export const RepoIcon = html`<svg class="repoicon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="currentColor"><path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" /></svg>`;

/** A name's initials, at most two: "Dana Developer" is DD, "dana" is D. */
export const initials = (name: string): string =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');

/**
 * A GitHub login's avatar, served by the host both glasses allow images from.
 * A bot's login names no user avatar there, so it gets none and shows initials.
 */
export function githubAvatarUrl(login: string): string | undefined {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return undefined;
  return `https://avatars.githubusercontent.com/${login}?size=48`;
}

/**
 * An avatar image; one that can't load (offline, or blocked) shows the
 * person's initials instead. It remembers which url failed rather than
 * resetting in an effect: a page's Content-Security-Policy refuses an image
 * before the first effect runs, and a reset there would bring the broken
 * image back.
 */
export function Avatar({ url, name, size = 24, cls = 'rv-initials' }: { url?: string; name: string; size?: number; cls?: string }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  if (!url || failedUrl === url) return html`<span class=${cls} aria-hidden="true">${initials(name)}</span>`;
  return html`<img src=${url} alt="" width=${size} height=${size} loading="lazy" referrerpolicy="no-referrer" onError=${() => setFailedUrl(url)} />`;
}

/** The hover text of a person's chip: their role and login, then their name when it differs. */
export function personLabel(person: CardPerson): string {
  const name = person.name && person.name !== person.login ? ` (${person.name})` : '';
  return `${person.role}: ${person.login}${name}`;
}

/** A card's person as a round chip: their avatar, else their initials, named only on hover. */
export const PersonChip = ({ person }: { person: CardPerson }) =>
  html`<span class="gavatar" role="img" title=${personLabel(person)} aria-label=${personLabel(person)}><${Avatar} url=${person.avatarUrl} name=${person.name ?? person.login} size=${20} cls="gavatar-initials" /></span>`;

export function Card(p: CardProps) {
  const mark = p.state?.mark;
  const cls = ['card gcard', mark === 'edge' && `gcard-edge gedge-${p.state!.tone}`, p.quiet && 'dim quiet', p.cls]
    .filter(Boolean)
    .join(' ');
  // A word over 12 characters may shrink (class long, never below 12) and carries itself as a title.
  const long = !!p.state && p.state.word.length > 12;
  const icon = p.icon && html`<span class="gicon">${p.icon}</span>`;
  const state =
    p.state &&
    (p.state.icon ??
      html`<span class=${(mark === 'chip' ? 'gchip ' : 'gword ') + p.state.tone + (long ? ' long' : '')} title=${long ? p.state.word : undefined}>${p.state.word}</span>`);
  return html`<div ...${p.attrs ?? {}} class=${cls} onClick=${p.onClick} style=${p.onClick ? undefined : 'cursor:default'}>
    <div class="gline gtop">${p.iconFirst && icon}<b class="gtitle" title=${p.titleAttr}>${p.title}</b>${!p.iconFirst && icon}<span class="gfill"></span>${!p.status && state}${p.person && html`<${PersonChip} person=${p.person} />`}${p.open && html`<${OpenArrow} open=${p.open} />`}</div>
    ${p.status && html`<div class="gline gstate">${p.status}</div>`}
    ${(p.context || p.action) && html`<div class="gline gcontext"><span class="gtext" title=${p.contextTitle}>${p.context}</span>${p.action && html`<span class="gaction">${p.action}</span>`}</div>`}
    ${p.now && html`<div class="gline gnow dim"><span class="gtext" title=${p.nowTitle}>${p.now}</span></div>`}
    ${p.foot && html`<div class="gline gfoot dim"><span class="gtext">${p.foot.left}</span>${p.foot.right && html`<span class="gright">${p.foot.right}</span>`}</div>`}
    ${p.actions && html`<div class="gline gactions" onClick=${(e: Event) => e.stopPropagation()}>${p.actions}</div>`}
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

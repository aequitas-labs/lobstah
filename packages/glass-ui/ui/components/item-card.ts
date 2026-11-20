import { useId, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { WatchSurfaceItem } from '@lobstah/core';
import { attentionEdge, itemGlyphFor, lifecycleToken, orderedStatuses, statusTone } from '@lobstah/watch-types/items';
import type { WatchGlyph, WatchItem, WatchItemAction, WatchItemMetadata, WatchSourceBrand } from '@lobstah/watch-types/items';
import type { WatchAttentionTarget } from '@lobstah/watch-types/presentation';
import { html, type Children } from '../html.js';
import { ITEM_REFRESHED, acknowledgeItem, itemActionKey, showModal, watchItemAction } from '../actions.js';
import { can } from '../backend.js';
import { getState } from '../store.js';
import { Age, RepoName, TRAP_MARK, WorkerAddress, ageText, namedText } from './common.js';
import { ActionIcon, Card, CardLink, PrIcon, SplitButton } from './card.js';
import type { CardPerson, CardTone, MenuAction } from './card.js';
import { Button } from './button.js';
import { Dialog } from './dialog.js';
import { showToast } from './toast.js';
import { StatusChip, dispatchTrap } from './prs.js';

/**
 * The provider-free item card, extracted from the PR card: every source's
 * items (GitHub reviews, ume artifacts, plugin items) fill the same named
 * slots, and the host owns their order, colors and behavior.
 *
 * 1. Attention edge, from the item's canonical attention; none on a finished item.
 * 2. Lifecycle glyph, leading the title, colored by lifecycle phase.
 * 3. Title.
 * 4. Person, the avatar chip at the top right.
 * 5. Lifecycle chip, first on the status line.
 * 6. Workflow and attention status chips, after it.
 * 7. Source logo, in a centered 14px slot on the context line; its name on hover, focus or tap.
 * 8. Context metadata, joined by the host's separator.
 * 9. Primary action and its ▾ menu.
 * 10. Open, at the bar's far right.
 * 11. Seen and quiet treatment, separate from lifecycle.
 */

/** A glyph that is part of a source's brand keeps its own colors; kind glyphs take the text's color. */
export function Glyph({ glyph }: { glyph: WatchGlyph }): Children {
  const id = useId();
  switch (glyph) {
    case 'github':
      return html`<svg class="hostglyph" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="currentColor"><path d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.73 1.16 1.73 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.39-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.57 0-1.23.44-2.24 1.16-3.03-.12-.29-.5-1.43.11-2.98 0 0 .95-.3 3.08 1.16a10.7 10.7 0 0 1 5.6 0c2.14-1.46 3.08-1.16 3.08-1.16.62 1.55.23 2.69.12 2.98.72.79 1.15 1.8 1.15 3.03 0 4.33-2.63 5.28-5.14 5.56.4.35.76 1.03.76 2.08v3.11c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8Z" /></svg>`;
    case 'ume': {
      // The ume plum blossom (MIT): five petals around the plum sphere, in its own colors.
      const petal = `${id}-petal`,
        sphere = `${id}-sphere`;
      return html`<svg class="hostglyph" viewBox="0 0 512 512" width="14" height="14" aria-hidden="true">
        <defs>
          <radialGradient id=${sphere} cx="35%" cy="30%" r="0.9"><stop offset="0" stop-color="#BC7BA3" /><stop offset="0.55" stop-color="#8A4270" /><stop offset="1" stop-color="#572B47" /></radialGradient>
          <radialGradient id=${petal} cx="38%" cy="30%" r="82%"><stop offset="0%" stop-color="#EBAFC2" /><stop offset="74%" stop-color="#D97C99" /><stop offset="100%" stop-color="#CE7091" /></radialGradient>
        </defs>
        <g transform="translate(256 256) scale(1.28) translate(-256 -256)">
          <g fill=${`url(#${petal})`}>
            ${[
              [256.0, 250.0, 0],
              [261.71, 254.15, 72],
              [259.53, 260.85, 144],
              [252.47, 260.85, 216],
              [250.29, 254.15, 288],
            ].map(
              ([x, y, r]) =>
                html`<g transform=${`translate(${x} ${y}) rotate(${r})`}><path d="M 0 0 L -51.13 -52.47 A 71.4 71.4 0 1 1 51.13 -52.47 Z" /></g>`,
            )}
          </g>
          <circle cx="256" cy="256" r="64" fill=${`url(#${sphere})`} />
          <ellipse cx="238" cy="236" rx="19" ry="12" fill="#FFFFFF" opacity="0.4" transform="rotate(-28 238 236)" />
        </g>
      </svg>`;
    }
    case 'pull-request':
      return PrIcon;
    case 'document':
      return html`<svg class="hostglyph" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>`;
    case 'document-check':
      return html`<svg class="hostglyph" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.7 2.7L16 9.8" /></svg>`;
    case 'bell':
      return html`<svg class="hostglyph" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>`;
    case 'deployment':
      return html`<svg class="hostglyph" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12" /><path d="M7 8l5-5 5 5" /><path d="M5 21h14" /></svg>`;
    case 'watch':
      return html`<svg class="hostglyph" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>`;
    default:
      // The generic source glyph: a plain diamond.
      return html`<svg class="hostglyph" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M8 2.5 13.5 8 8 13.5 2.5 8z" /></svg>`;
  }
}

/** A source's logo art: its installed image, or its glyph when it has none or the image fails. */
export function SourceArt({ source }: { source: WatchSourceBrand }): Children {
  const [failed, setFailed] = useState<string>();
  const icon = source.icon;
  if ('glyph' in icon) return html`<${Glyph} glyph=${icon.glyph} />`;
  // The glass is dark only: it shows the dark variant.
  const url = icon.asset.dark;
  if (failed === url) return html`<${Glyph} glyph=${icon.fallback} />`;
  return html`<img class="hostglyph" src=${url} alt="" width="14" height="14" loading="lazy" referrerpolicy="no-referrer" onError=${() => setFailed(url)} />`;
}

/**
 * A card's source, as its logo alone in a centered 14px slot. The source's
 * name is its accessible name, and shows as a tooltip on hover, keyboard
 * focus or a tap; a tap never opens the card.
 */
export function SourceLogo({ source }: { source: WatchSourceBrand }): Children {
  const [shown, setShown] = useState(false);
  return html`<button type="button" class=${'srclogo' + (shown ? ' tip' : '')} aria-label=${source.name} data-source=${source.id}
    onClick=${(event: Event) => {
      event.stopPropagation();
      setShown(!shown);
    }}
    onKeyDown=${(event: KeyboardEvent) => event.stopPropagation()}
    onBlur=${() => setShown(false)}
    onMouseLeave=${() => setShown(false)}
  ><${SourceArt} source=${source} /><span class="srctip" aria-hidden="true">${source.name}</span></button>`;
}

/** What the shared item card shows, slot by slot; each wrapper fills it from its own data. */
export interface ItemCardParts {
  key: string;
  title: Children;
  titleAttr?: string;
  /** The leading lifecycle glyph, already colored by its phase. */
  glyph: Children;
  /** The status line: the lifecycle chip, then workflow and attention chips. */
  status: Children;
  /** The source logo, alone in the context line's leading slot. */
  source?: Children;
  /** Context values, in order; the card joins them with its separator. */
  context: Children[];
  contextTitle: string;
  /** The attention edge; none on a finished item. */
  edge?: CardTone;
  /** The bottom bar's controls, Open last. */
  actions: Children;
  quiet?: boolean;
  cls?: string;
  attrs?: Record<string, unknown>;
  person?: CardPerson;
  onClick: () => void;
}

/** The one layout for PR, review and source item cards. */
export function ItemCard(c: ItemCardParts) {
  const joined = c.context.flatMap((part, i) => (i || c.source ? [' · ', part] : [part]));
  return html`<${Card}
    key=${c.key}
    title=${c.title}
    titleAttr=${c.titleAttr}
    icon=${c.glyph}
    iconFirst
    state=${c.edge ? { word: '', tone: c.edge, mark: 'edge' } : undefined}
    status=${c.status}
    lead=${c.source}
    context=${joined}
    contextTitle=${c.contextTitle}
    actions=${c.actions}
    quiet=${c.quiet}
    cls=${['prcard', c.cls].filter(Boolean).join(' ')}
    attrs=${c.attrs}
    person=${c.person}
    onClick=${c.onClick}
  />`;
}

/** The lifecycle glyph in its phase's color: the kind glyph, or the source's variant for that phase. */
export function ItemGlyph({ item }: { item: Pick<WatchItem, 'glyph' | 'lifecycle'> }): Children {
  return html`<span class=${'prstate ' + lifecycleToken[item.lifecycle.phase]}><${Glyph} glyph=${itemGlyphFor(item.glyph, item.lifecycle.phase)} /></span>`;
}

/** Open an item where its source points: a shell view, a page hash, or a new tab. */
export function openItemTarget(target: WatchAttentionTarget | undefined): void {
  if (!target) return;
  if ('open' in target) showModal(target.open.type, target.open.key);
  else if ('hash' in target) location.hash = target.hash;
  else window.open(target.href, '_blank', 'noopener');
}

/** Follow a target from a card: a link opens a new tab; a shell target opens its view. */
export function targetHref(target: WatchAttentionTarget | undefined): string | undefined {
  if (!target) return undefined;
  if ('href' in target) return target.href;
  if ('hash' in target) return target.hash;
  return undefined;
}

/**
 * The status line, in the shared order: the lifecycle chip, then statuses
 * by category. The first workflow chip carries the unread dot. A status
 * that links reads as a link; one with a note keeps its note beside it.
 */
export function ItemStatuses({ item }: { item: WatchItem }): Children {
  const unread = !!item.notification?.unread;
  let marked = false;
  const statuses = orderedStatuses(item.statuses).map((status) => {
    const tone = statusTone[status.meaning];
    if (status.target) {
      const href = targetHref(status.target);
      // The space keeps a table cell's words apart; a card's status line spaces its parts itself.
      return [
        ' ',
        html`<a href=${href} target="_blank" rel="noopener" onClick=${(event: Event) => event.stopPropagation()}>${status.label}${status.at && [' ', Age(status.at)]}</a>`,
      ];
    }
    if (status.note)
      return html`<div class="merge-intent">${StatusChip(status.label, tone, status.detail)}<span> · ${status.note}</span></div>`;
    const dot = unread && !marked && status.category === 'workflow';
    if (dot) marked = true;
    return html`<span data-review-unread=${dot || undefined} aria-label=${dot ? 'Needs attention' : undefined}>${StatusChip((dot ? '● ' : '') + status.label, tone, status.detail)}</span>`;
  });
  return [
    StatusChip(item.lifecycle.label, lifecycleToken[item.lifecycle.phase]),
    item.lifecycle.archived && StatusChip('archived', 'dim'),
    ...statuses,
  ];
}

/** The context line's values, as a card shows them, and the same values as hover text. */
export function itemContext(metadata: readonly WatchItemMetadata[]): { parts: Children[]; text: string } {
  const parts: Children[] = [];
  const words: string[] = [];
  for (const entry of metadata) {
    if (entry.kind === 'person') continue;
    if (entry.kind === 'project') {
      parts.push(RepoName(entry.value));
      words.push(entry.value);
    } else if (entry.kind === 'time') {
      parts.push([Age(entry.value), ' ago']);
      words.push(`${ageText(entry.value)} ago`);
    } else if (entry.kind === 'owner') {
      const trap = entry.value.startsWith('dispatch:') ? dispatchTrap([entry.value.slice('dispatch:'.length)]) : entry.value;
      if (!trap) continue;
      parts.push([`${TRAP_MARK} `, WorkerAddress(trap)]);
      words.push(`${TRAP_MARK} ${namedText(trap)}`);
    } else {
      parts.push(entry.value);
      words.push(entry.value);
    }
  }
  return { parts, text: words.join(' · ') };
}

/** A refusal is toasted, except a conflict: the page already shows the item's current controls. */
const refused = (reason: string): void => {
  if (reason !== ITEM_REFRESHED) showToast(reason);
};

const GLYPH_ICON: Record<NonNullable<WatchItemAction['glyph']>, Children> = {
  merge: ActionIcon.merge,
  draft: ActionIcon.draft,
  approve: ActionIcon.approve,
  changes: ActionIcon.changes,
  publish: ActionIcon.publish,
  skip: ActionIcon.skip,
  mute: ActionIcon.mute,
  unmute: ActionIcon.unmute,
};

/** Why an effect cannot run here, or nothing when it can. */
function blocked(entry: WatchSurfaceItem, action: WatchItemAction): string | undefined {
  if (!('effect' in action.binding)) return undefined;
  if (entry.watch.status !== 'watching') return 'This source is unavailable. Its last items stay listed; release the watch to act on them.';
  if (!action.enabled) return action.reason ?? 'This action is not available now.';
  return undefined;
}

/**
 * The item's controls, in the card's bar: each primary action as a button,
 * the last primary carrying the ▾ menu of the rest, and Open at the far
 * right. A click on any of them never opens or acknowledges the card,
 * except Open, which acknowledges the notification it showed.
 */
export function ItemActions({
  entry,
  size = 'md',
  open = true,
}: {
  entry: WatchSurfaceItem;
  size?: 'md' | 'lg';
  open?: boolean;
}): Children {
  const [confirming, setConfirming] = useState<WatchItemAction>();
  const writable = can('watch-item-action');
  // An action in flight on this item, from this card or another surface (the item's detail view).
  const running = getState().itemActions?.[itemActionKey(entry)];
  const legacy = getState().reviewActions?.[entry.item.id];
  const pending =
    running?.control ??
    (legacy && entry.item.actions.find((action) => 'effect' in action.binding && action.binding.effect.action === legacy)?.id) ??
    (legacy ? '\u0000busy' : undefined);
  const controls = entry.item.actions.filter((action) => 'link' in action.binding || writable);
  const run = (action: WatchItemAction) => async (event: Event) => {
    event.stopPropagation();
    return watchItemAction(entry, action.id);
  };
  const button = (action: WatchItemAction, main: boolean) => {
    const why = blocked(entry, action);
    const icon = action.glyph && GLYPH_ICON[action.glyph];
    if (action.confirm)
      return html`<${Button} size=${size} variant=${main ? 'primary' : 'secondary'} pressed=${action.pressed} disabled=${!!why || !!pending} title=${why ?? action.title} onClick=${(
        event: Event,
      ) => {
        event.stopPropagation();
        setConfirming(action);
      }}>${icon}${action.label}<//>`;
    return html`<${Button} size=${size} variant=${main ? 'primary' : 'secondary'} pressed=${action.pressed} disabled=${!!why || (!!pending && pending !== action.id)} pending=${pending === action.id} title=${why ?? action.title} action=${run(action)} sending=${action.progress} done=${action.done} onError=${refused}>${icon}${action.label}<//>`;
  };
  const menuItem = (action: WatchItemAction): MenuAction => {
    const why = blocked(entry, action);
    const icon = action.glyph && GLYPH_ICON[action.glyph];
    return action.confirm
      ? {
          label: action.label,
          icon,
          title: why ?? action.title,
          disabled: !!why || !!pending,
          pending: pending === action.id,
          sending: action.progress,
          onClick: (event: Event) => {
            event.stopPropagation();
            setConfirming(action);
          },
        }
      : {
          label: action.label,
          icon,
          title: why ?? action.title,
          disabled: !!why || (!!pending && pending !== action.id),
          pending: pending === action.id,
          action: run(action),
          sending: action.progress,
          done: action.done,
          onError: refused,
        };
  };
  const primaries = controls.filter((action) => action.placement === 'primary');
  const menu = controls.filter((action) => action.placement === 'menu').map(menuItem);
  const opens = open ? controls.filter((action) => action.placement === 'open') : [];
  const standalone = primaries.slice(0, -1);
  const main = primaries.at(-1);
  const confirmation =
    confirming &&
    confirming.confirm &&
    createPortal(
      html`<${Dialog} title=${confirming.confirm.title} onClose=${() => setConfirming(undefined)}>
        <p>${confirming.confirm.body}</p>
        <div class="dialog-actions"><${Button} onClick=${() => setConfirming(undefined)}>Cancel<//>
        <${Button} variant="primary" pending=${pending === confirming.id} disabled=${!!blocked(entry, confirming) || !!pending} sending=${confirming.progress} onError=${refused} action=${async (
          event: Event,
        ): Promise<string | undefined> => {
          event.stopPropagation();
          const why = await watchItemAction(entry, confirming.id);
          if (!why) setConfirming(undefined);
          return why;
        }}>${confirming.confirm.label}<//></div>
      <//>`,
      document.body,
    );
  return [
    ...standalone.map((action) => button(action, true)),
    (main || menu.length > 0) &&
      html`<span class=${'rv-actions' + (!main && menu.length ? ' rv-menu-only' : '')}>${html`<${SplitButton} main=${main && button(main, true)} more=${menu} />`}${confirmation}</span>`,
    ...opens.map((action) => {
      const href = 'link' in action.binding ? targetHref(action.binding.link) : undefined;
      return (
        href &&
        html`<${CardLink} href=${href} label=${action.label} onOpen=${() => {
          if (action.acknowledges) acknowledgeItem(entry);
        }} />`
      );
    }),
  ];
}

/** The person chip from an item's person slot. */
export function itemPerson(item: WatchItem): CardPerson | undefined {
  const person = item.person;
  if (!person) return undefined;
  return {
    login: person.id,
    ...(person.name ? { name: person.name } : {}),
    ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : {}),
    role: person.role,
  };
}

/** One source item as a card: the shared slots, filled only from its normalized data. */
export function watchItemCard(
  entry: WatchSurfaceItem,
  opts: { onOpen: () => void; cls?: string; attrs?: Record<string, unknown> },
): Children {
  const { item, source } = entry;
  const context = itemContext(item.metadata);
  return ItemCard({
    key: `${entry.watch.key}:${item.id}`,
    title: item.title,
    titleAttr: item.title,
    glyph: html`<${ItemGlyph} item=${item} />`,
    status: html`<${ItemStatuses} item=${item} />`,
    source: html`<${SourceLogo} source=${source} />`,
    context: context.parts,
    contextTitle: [source.name, context.text].filter(Boolean).join(' · '),
    edge: attentionEdge(item),
    actions: html`<${ItemActions} entry=${entry} />`,
    quiet: !!item.resolved,
    cls: [opts.cls, item.notification?.seen && 'seen'].filter(Boolean).join(' '),
    attrs: {
      ...opts.attrs,
      'data-item': item.id,
      role: 'button',
      tabindex: '0',
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === 'Enter' && event.target === event.currentTarget) opts.onOpen();
      },
    },
    person: itemPerson(item),
    onClick: opts.onOpen,
  });
}

import { useId, useState } from 'preact/hooks';
import type { ReviewContext, ReviewRequestItem, ReviewRequestItemGlyph, ReviewLink, ReviewSource } from '@lobstah/core';
import {
  REVIEW_LIFECYCLE_TOKEN,
  REVIEW_STATUS_TONE,
  reviewAttentionEdge,
  reviewGlyphFor,
  safeReviewUrl,
} from '../../../core/src/review-item.js';
import { html, type Children } from '../html.js';
import { Age, RepoName, TRAP_MARK, WorkerAddress, ageText, namedText } from './common.js';
import { Card, CardLink, PrIcon } from './card.js';
import type { CardPerson } from './card.js';
import { Button } from './button.js';
import { StatusChip } from './prs.js';

/**
 * The item card: one layout for a review request from any source (a GitHub
 * PR, a ume artifact), filled from a ReviewRequestItem (core review-item.ts). The
 * slots, in order:
 *
 * 1. The attention edge; none on a finished item.
 * 2. The kind glyph, leading the title, colored by the lifecycle phase.
 * 3. The title, and the person who asked at the top right.
 * 4. The lifecycle chip, then the status chips; the first unread one carries the dot.
 * 5. The source logo, in a 14px slot before the context; its name on hover, focus or a tap.
 * 6. The context values, joined with " · ".
 * 7. The bar: the source's own controls, then its link actions, then Open at the far right.
 */

/** A glyph the glass draws. A brand glyph keeps its own colors; a kind glyph takes the text's color. */
export function Glyph({ glyph }: { glyph: ReviewRequestItemGlyph }): Children {
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
    default:
      // The generic source glyph: a plain diamond.
      return html`<svg class="hostglyph" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M8 2.5 13.5 8 8 13.5 2.5 8z" /></svg>`;
  }
}

/** A source's logo art: its HTTPS image, or its glyph when it has none or the image fails. */
export function SourceArt({ source }: { source: ReviewSource }): Children {
  const [failed, setFailed] = useState<string>();
  const icon = source.icon;
  if ('glyph' in icon) return html`<${Glyph} glyph=${icon.glyph} />`;
  if (failed === icon.image || !safeReviewUrl(icon.image, true)) return html`<${Glyph} glyph=${icon.fallback} />`;
  return html`<img class="hostglyph" src=${icon.image} alt="" width="14" height="14" loading="lazy" referrerpolicy="no-referrer" onError=${() => setFailed(icon.image)} />`;
}

/**
 * A card's source, as its logo alone in a centered 14px slot. The source's
 * name is its accessible name and shows as a tooltip on hover, keyboard
 * focus or a tap; a tap never opens the card.
 */
export function SourceLogo({ source }: { source: ReviewSource }): Children {
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

/** The kind glyph in its lifecycle phase's color. */
export function ItemGlyph({ item }: { item: Pick<ReviewRequestItem, 'glyph' | 'lifecycle'> }): Children {
  return html`<span class=${'prstate ' + REVIEW_LIFECYCLE_TOKEN[item.lifecycle.phase]}><${Glyph} glyph=${reviewGlyphFor(item.glyph, item.lifecycle.phase)} /></span>`;
}

/** The status line: the lifecycle chip, an archived chip, then the statuses in order. */
export function ItemStatuses({ item }: { item: Pick<ReviewRequestItem, 'lifecycle' | 'statuses'> }): Children {
  return [
    StatusChip(item.lifecycle.label, REVIEW_LIFECYCLE_TOKEN[item.lifecycle.phase]),
    item.lifecycle.archived && StatusChip('archived', 'dim'),
    ...item.statuses.map(
      (status) =>
        html`<span data-review-unread=${status.unread || undefined} aria-label=${status.unread ? 'Needs attention' : undefined}>${StatusChip((status.unread ? '● ' : '') + status.label, REVIEW_STATUS_TONE[status.meaning], status.detail)}</span>`,
    ),
  ];
}

/** The context line's values as the card shows them, and the same values as its hover text. */
export function itemContext(context: readonly ReviewContext[]): { parts: Children[]; text: string } {
  const parts: Children[] = [];
  const words: string[] = [];
  for (const entry of context) {
    if (entry.kind === 'project') {
      parts.push(RepoName(entry.value));
      words.push(entry.value);
    } else if (entry.kind === 'time') {
      parts.push([Age(entry.value), ' ago']);
      words.push(`${ageText(entry.value)} ago`);
    } else if (entry.kind === 'owner') {
      parts.push([`${TRAP_MARK} `, WorkerAddress(entry.value)]);
      words.push(`${TRAP_MARK} ${namedText(entry.value)}`);
    } else {
      parts.push(entry.value);
      words.push(entry.value);
    }
  }
  return { parts, text: words.join(' · ') };
}

/** The item's link actions: each primary link as a labelled button, then Open at the far right. A click never opens the card. */
export function ItemLinks({ links, onFollow }: { links: readonly ReviewLink[]; onFollow?: (link: ReviewLink) => void }): Children {
  const safe = links.filter((link) => safeReviewUrl(link.href));
  return [
    ...safe
      .filter((link) => link.placement === 'primary')
      .map(
        (link) =>
          html`<${Button} variant="primary" href=${link.href} target="_blank" rel="noopener" onClick=${(event: Event) => {
            event.stopPropagation();
            onFollow?.(link);
          }}>${link.label}<//>`,
      ),
    ...safe
      .filter((link) => link.placement === 'open')
      .map((link) => html`<${CardLink} href=${link.href} label=${link.label} onOpen=${() => onFollow?.(link)} />`),
  ];
}

/** The person chip from an item's person. */
export function itemPerson(item: Pick<ReviewRequestItem, 'person'>): CardPerson | undefined {
  const person = item.person;
  if (!person) return undefined;
  return {
    login: person.id,
    ...(person.name ? { name: person.name } : {}),
    ...(person.avatarUrl && safeReviewUrl(person.avatarUrl, true) ? { avatarUrl: person.avatarUrl } : {}),
    role: person.role,
  };
}

/** What a source adds to its item's card beyond the item's data: GitHub's review controls and merge state. */
export interface ItemCardExtras {
  /** More on the status line, after the statuses: a posted review's link, a pending merge. */
  status?: Children;
  /** The source's own controls in the bar, before the link actions. */
  controls?: Children;
  /** Runs when a link action is followed. */
  onFollow?: (link: ReviewLink) => void;
  /** A tap on the card. Unset, the card opens its target in a new tab. */
  onOpen?: () => void;
  cls?: string;
  attrs?: Record<string, unknown>;
}

/** Open an item's target in a new tab. */
const openTarget = (item: ReviewRequestItem) => () => {
  if (item.target && safeReviewUrl(item.target)) window.open(item.target, '_blank', 'noopener');
};

/** One review item as a card, filled only from its data and what its source adds. */
export function ItemCard({ item, ...extra }: { item: ReviewRequestItem } & ItemCardExtras): Children {
  const context = itemContext(item.context);
  const open = extra.onOpen ?? openTarget(item);
  const edge = reviewAttentionEdge(item);
  return html`<${Card}
    key=${item.id}
    title=${item.title}
    titleAttr=${item.title}
    icon=${html`<${ItemGlyph} item=${item} />`}
    iconFirst
    state=${edge ? { word: '', tone: edge, mark: 'edge' } : undefined}
    status=${[html`<${ItemStatuses} item=${item} />`, extra.status]}
    lead=${html`<${SourceLogo} source=${item.source} />`}
    context=${context.parts.flatMap((part, i) => (i ? [' · ', part] : [part]))}
    contextTitle=${[item.source.name, context.text].join(' · ')}
    actions=${[extra.controls, html`<${ItemLinks} links=${item.actions} onFollow=${extra.onFollow} />`]}
    quiet=${item.resolved}
    cls=${['prcard', 'itemcard', extra.cls].filter(Boolean).join(' ')}
    attrs=${{
      'data-item': item.id,
      'data-item-source': item.source.id,
      role: 'button',
      tabindex: '0',
      ...extra.attrs,
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === 'Enter' && event.target === event.currentTarget) open();
      },
    }}
    person=${itemPerson(item)}
    onClick=${open}
  />`;
}

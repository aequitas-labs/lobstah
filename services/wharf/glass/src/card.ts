import { useEffect, useState } from 'preact/hooks';
import type { GlassCard, GlassCardItem } from '../../../../packages/core/src/backend-model.js';
import { safeHref } from '../../../../apps/cli/src/glass-markdown.js';
import { LinkedText } from '../../../../apps/cli/glass/src/components/links.js';
import { json } from './api.js';
import { html, when } from './common.js';

/** How a card stands, in words: its end, or whether a person has seen it. */
export function cardState(card: GlassCard): string {
  if (card.terminal) return [card.terminal.state, card.terminal.outcome, card.terminal.by && `by ${card.terminal.by}`, when(card.terminal.at)].filter(Boolean).join(' · ');
  if (card.seen) return `seen by ${card.seen.by} · ${when(card.seen.at)}`;
  return card.quiet ? 'in progress' : 'standing';
}

/**
 * A card the wharf keeps, opened by its id. A card about a wharf record opens
 * that record's own page; a card from a boat's glass shows here as it is.
 */
export function CardDetail({ id, open, boatName }: { id: string; open: (item: GlassCardItem) => void; boatName: (id: string) => string | undefined }) {
  const [card, setCard] = useState<GlassCard>(),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    json<GlassCard>(`/api/glass/cards/${encodeURIComponent(id)}`).then(
      (c) => {
        if (!live) return;
        if (c.item) open(c.item);
        else setCard(c);
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [id]);
  if (error) return html`<div class="dim">${error}</div>`;
  if (!card) return html`<div class="dim">loading card</div>`;
  const boat = card.source.slice('boat:'.length);
  const source = card.source === 'wharf' ? 'wharf' : `boat ${boatName(boat) ?? boat}`;
  return html`<div class="sub">${card.family} · ${source}${card.grounds ? ' · ' + card.grounds : ''} · revision ${card.revision} · ${when(card.sourceAt)}</div>
    <h3>${LinkedText(card.title)}</h3>
    <div class="meta">${cardState(card)}</div>
    ${card.summary && html`<div class="note">${LinkedText(card.summary)}</div>`}
    ${card.links.map((l) => html`<div><a href=${safeHref(l.url)} target="_blank" rel="noopener">${l.label}</a></div>`)}`;
}

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicRenameSync, displayGrounds, lobstahHome, storageGrounds, uniqueTempPath } from '@lobstah/core';
import type { Config, HelmRegistration } from '@lobstah/core';
import { openCardRows, renderOpenCards } from './tend.js';
import type { TendOpenCard } from './tend.js';

/** The last Stop listing of a particular version of a card. */
interface CardListing {
  stateHash: string;
  listedAt: number;
}

/** Where a grounds' Stop listings are kept, so pacing holds across Stop processes. */
function listingsFile(grounds: string): string {
  return path.join(lobstahHome(), 'helm', '.cards', `${createHash('sha256').update(grounds).digest('hex')}.json`);
}

function readListings(file: string): Record<string, CardListing> {
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, CardListing>;
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) return stored;
  } catch {
    /* A first listing, or damaged pacing state, must not hide a card. */
  }
  return {};
}

/** A card is due at Stop when it is new, changed, or not listed within `remindSecs`. */
function isDue(card: TendOpenCard, listed: CardListing | undefined, remindMs: number, now: number): boolean {
  return (
    !listed ||
    listed.stateHash !== card.stateHash ||
    !Number.isFinite(listed.listedAt) ||
    (remindMs > 0 && now - listed.listedAt >= remindMs)
  );
}

/**
 * Tend's open-cards section for the helm's grounds, paced: only the cards due
 * at this Stop. Consume records delivery; a peek leaves pacing untouched.
 */
export function openCardsAtStop(helm: HelmRegistration, config: Config, consume: boolean, now: number = Date.now()): string {
  const grounds = storageGrounds(helm.grounds, config);
  const file = listingsFile(grounds);
  const listings = readListings(file);
  const cards = openCardRows(config, now).filter((card) => card.grounds === displayGrounds(grounds, config));
  const remindMs = (config.remindSecs ?? 900) * 1000;
  const due = cards.filter((card) => isDue(card, listings[card.key], remindMs, now));
  if (due.length === 0) return '';
  if (consume) {
    const next = Object.fromEntries(cards.flatMap((card) => (listings[card.key] ? [[card.key, listings[card.key]]] : [])));
    for (const card of due) next[card.key] = { stateHash: card.stateHash, listedAt: now };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = uniqueTempPath(file);
    fs.writeFileSync(temporary, JSON.stringify(next));
    atomicRenameSync(temporary, file);
  }
  return renderOpenCards(due);
}

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicRenameSync, displayGrounds, lobstahHome, storageGrounds, uniqueTempPath } from '@lobstah/core';
import type { Config, HelmRegistration } from '@lobstah/core';
import { answeredCardRows, openCardRows, renderAnsweredCards, renderOpenCards, renderWaitingCards } from './tend.js';
import type { TendAnsweredCard, TendOpenCard } from './tend.js';

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

/** The helm grounds' open cards that tend lists, less the ones a human-wait line already covers. */
function groundsOpenCards(grounds: string, config: Config, now: number): TendOpenCard[] {
  return openCardRows(config, now).filter((card) => card.grounds === displayGrounds(grounds, config) && !card.waitingDispatches?.length);
}

/** The answered cards awaiting the helm's ack in its grounds, or placed in no grounds. */
function groundsAnsweredCards(grounds: string, config: Config, now: number): TendAnsweredCard[] {
  return answeredCardRows(config, now).filter((card) => card.grounds === undefined || card.grounds === displayGrounds(grounds, config));
}

/**
 * Whether cards alone should block this Stop: an open card is new, changed or
 * not listed within `remindSecs`, or an answered card awaits the helm's ack.
 * Peeking never records a listing.
 */
export function cardsDueAtStop(helm: HelmRegistration, config: Config, now: number = Date.now()): boolean {
  const grounds = storageGrounds(helm.grounds, config);
  if (groundsAnsweredCards(grounds, config, now).length > 0) return true;
  const listings = readListings(listingsFile(grounds));
  const remindMs = (config.remindSecs ?? 900) * 1000;
  return groundsOpenCards(grounds, config, now).some((card) => isDue(card, listings[card.key], remindMs, now));
}

/**
 * Tend's open-cards section for the helm's grounds: every open card, so a card
 * missing from the list was answered. Pacing decides only whether cards alone
 * block a Stop (see `cardsDueAtStop`); `record` marks every listed card as
 * delivered for that pacing. Answered cards awaiting the helm's ack follow:
 * each blocks every turn end until `man ack`.
 */
export function openCardsAtStop(helm: HelmRegistration, config: Config, record: boolean, now: number = Date.now()): string {
  const grounds = storageGrounds(helm.grounds, config);
  const cards = groundsOpenCards(grounds, config, now);
  if (record) recordListings(grounds, cards, now);
  return [renderOpenCards(cards), renderAnsweredCards(groundsAnsweredCards(grounds, config, now))].filter(Boolean).join('\n');
}

/** Record this Stop's listing of `cards`; cards no longer open drop out of the pacing file. */
function recordListings(grounds: string, cards: readonly TendOpenCard[], now: number): void {
  const file = listingsFile(grounds);
  const next: Record<string, CardListing> = Object.fromEntries(cards.map((card) => [card.key, { stateHash: card.stateHash, listedAt: now }]));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = uniqueTempPath(file);
  fs.writeFileSync(temporary, JSON.stringify(next));
  atomicRenameSync(temporary, file);
}

/** Human waits remain visible at Stop without blocking the helm's turn. */
export function waitingCardsAtStop(helm: HelmRegistration, config: Config): string {
  return renderWaitingCards(openCardRows(config).filter(card => card.grounds === displayGrounds(helm.grounds, config)));
}

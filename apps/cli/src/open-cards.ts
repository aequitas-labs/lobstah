import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  ageLabel,
  atomicRenameSync,
  groundsList,
  lobstahHome,
  standingDecisions,
  storageGrounds,
  storedDescriptor,
  uniqueTempPath,
} from '@lobstah/core';
import type { Config, DecisionMeta, HelmRegistration } from '@lobstah/core';
import { decisionHash } from '@lobstah/glass-ui';
import { glassPort, glassUrl } from './glass-lifecycle.js';

/** The last Stop listing of a particular version of a card. */
interface CardListing {
  stateHash: string;
  listedAt: number;
}

/** Explicit card ownership wins; older cards fall back to their dispatch or the only grounds. */
function cardBelongsToHelm(card: DecisionMeta, helm: HelmRegistration, config: Config): boolean {
  const descriptor = card.dispatch ? storedDescriptor(card.dispatch, card.lane ?? 'work') : undefined;
  const grounds = card.grounds ?? descriptor?.target?.grounds;
  if (grounds) return storageGrounds(grounds, config) === storageGrounds(helm.grounds, config);
  const repo = card.repo ?? descriptor?.repo;
  if (repo) return helm.repos.includes(repo);
  const scopes = groundsList(config);
  return scopes.length === 1 && scopes[0]!.name === storageGrounds(helm.grounds, config);
}

/** List due open cards as data only; consume records delivery, while peeks leave pacing untouched. */
export function openCardsAtStop(helm: HelmRegistration, config: Config, consume: boolean, now: number = Date.now()): string {
  const grounds = storageGrounds(helm.grounds, config);
  const file = path.join(lobstahHome(), 'helm', '.cards', `${createHash('sha256').update(grounds).digest('hex')}.json`);
  let listings: Record<string, CardListing> = {};
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, CardListing>;
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) listings = stored;
  } catch {
    /* A first listing, or damaged pacing state, must not hide a card. */
  }
  const cards = standingDecisions(now).filter((card) => cardBelongsToHelm(card, helm, config));
  const remindMs = (config.remindSecs ?? 900) * 1000;
  const due = cards.filter((card) => {
    const listed = listings[card.key];
    return (
      !listed ||
      listed.stateHash !== card.stateHash ||
      !Number.isFinite(listed.listedAt) ||
      (remindMs > 0 && now - listed.listedAt >= remindMs)
    );
  });
  if (due.length === 0) return '';
  if (consume) {
    const next = Object.fromEntries(cards.flatMap((card) => (listings[card.key] ? [[card.key, listings[card.key]]] : [])));
    for (const card of due) next[card.key] = { stateHash: card.stateHash, listedAt: now };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = uniqueTempPath(file);
    fs.writeFileSync(temporary, JSON.stringify(next));
    atomicRenameSync(temporary, file);
  }
  const base = glassUrl(glassPort());
  return [
    'Open cards:',
    ...due.map(
      (card) =>
        `- ${card.run ? 'run' : 'card'} ${card.key.replace(/^decision:/, '')} · ${card.title.replace(/\s+/g, ' ')} · ${ageLabel(Math.max(0, now - Date.parse(card.askedAt)))} · ${base}/${decisionHash(card.key)}`,
    ),
  ].join('\n');
}

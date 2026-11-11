import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicRenameSync, lobstahHome, readMirrorStatus, uniqueTempPath } from '@lobstah/core';
import type { Config, TendAttention, WharfAttentionList } from '@lobstah/core';
import { decisionHash, reportPageUrl } from '@lobstah/glass-ui';

/**
 * Every boat's items on this Mac's pet. Each mirror boat puts the items its
 * pet walks on the wharf (ownAttentionList, from the mirror's pass), and a
 * boat granted `attention` reads the others' lists into this cache
 * (`~/.lobstah/wharf-attention.json`). `lobstah attention --json` adds them
 * (otherBoatsAttention), so the pet walks what the hosted glass shows.
 * A click on one acks it on the boat that owns it, through the wharf.
 */

/** Other boats' lists, as this boat's daemon last read them from its mirror's wharf. */
export interface OtherBoats {
  wharf: string;
  /** When the daemon last read them. */
  at: string;
  boats: Array<WharfAttentionList & { attention: unknown[] }>;
}

export const otherBoatsPath = (): string => path.join(lobstahHome(), 'wharf-attention.json');

export function readOtherBoats(): OtherBoats | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(otherBoatsPath(), 'utf8')) as OtherBoats;
    return value && typeof value.wharf === 'string' && Array.isArray(value.boats) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeOtherBoats(value: OtherBoats): void {
  const file = otherBoatsPath(), tmp = uniqueTempPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  atomicRenameSync(tmp, file);
}

export function forgetOtherBoats(): void {
  fs.rmSync(otherBoatsPath(), { force: true });
}

/** Another boat's item key: `@<boat id>/<the boat's own key>`. */
export const boatItemKey = (boat: string, key: string): string => `@${boat}/${key}`;

export function parseBoatItemKey(key: string): { boat: string; key: string } | undefined {
  const m = /^@([A-Za-z0-9_-]{1,128})\/(.+)$/.exec(key);
  return m ? { boat: m[1]!, key: m[2]! } : undefined;
}

/**
 * The list this boat puts on the wharf: the items its own pet walks, without
 * their ages (an age changes every second; the list should change only when
 * an item does), and never another boat's item.
 */
export function ownAttentionList(items: readonly unknown[]): Array<Record<string, unknown>> {
  return items.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const { ageSecs: _age, ...item } = raw as Record<string, unknown>;
    return typeof item.key === 'string' && !parseBoatItemKey(item.key) && item.boat === undefined ? [item] : [];
  });
}

/** Where a click on another boat's item opens: the hosted glass at it, when the wharf has named its glass. */
function hostedAt(glass: string, item: TendAttention): string | undefined {
  if (item.glass) return item.glass;
  if (item.kind === 'decision' || item.kind === 'question') return `${glass}/${decisionHash(item.key)}`;
  if (item.kind === 'report') return `${glass}${reportPageUrl(item.key)}`;
  return undefined;
}

/**
 * Other boats' items for this Mac's pet, from the cache, or none when this
 * Mac mirrors to no wharf (or a different one). Each note starts with its
 * boat's name. A PR or a stack that this boat or an earlier boat also
 * walks walks once. An item of a wharf grounds this boat views itself
 * (hostedAttention) walks once, from this boat's own view.
 */
export function otherBoatsAttention(config: Config, local: readonly Pick<TendAttention, 'key' | 'grounds' | 'wharf'>[], now: number = Date.now()): TendAttention[] {
  const wharf = config.glass.mirror;
  if (!wharf) return [];
  const cache = readOtherBoats();
  if (!cache || cache.wharf !== wharf) return [];
  const glass = readMirrorStatus()?.glass;
  const seen = new Set(local.map((a) => a.key));
  const viewed = new Set(local.filter((a) => a.grounds !== undefined).map((a) => `${a.grounds}@${a.wharf}`));
  const out: TendAttention[] = [];
  for (const boat of cache.boats) {
    for (const raw of boat.attention) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const item = raw as TendAttention;
      if (typeof item.key !== 'string' || typeof item.stateHash !== 'string' || typeof item.kind !== 'string') continue;
      if (item.grounds !== undefined && viewed.has(`${item.grounds}@${item.wharf}`)) continue;
      const shared = item.key.startsWith('pr:') || item.key.startsWith('stack:');
      if (shared && seen.has(item.key)) continue;
      if (shared) seen.add(item.key);
      const since = Date.parse(item.standingSince ?? item.at ?? '');
      const link = glass ? hostedAt(glass, item) : item.glass;
      out.push({
        ...item,
        key: boatItemKey(boat.boat, item.key),
        note: `[${boat.name}] ${item.note ?? item.verb}`,
        ageSecs: Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 1000)) : 0,
        boat: { id: boat.boat, name: boat.name },
        ...(link ? { glass: link } : {}),
      });
    }
  }
  return out;
}

/**
 * Mark another boat's item acked in the cache, so it stops walking on this
 * Mac at once. The owning boat's next list carries the ack itself.
 */
export function markOtherBoatAcked(key: string, ack: { at: string; by: string }): void {
  const ref = parseBoatItemKey(key);
  const cache = readOtherBoats();
  if (!ref || !cache) return;
  for (const boat of cache.boats) {
    if (boat.boat !== ref.boat) continue;
    boat.attention = boat.attention.map((raw) => (raw && typeof raw === 'object' && (raw as { key?: unknown }).key === ref.key ? { ...(raw as object), acked: ack } : raw));
  }
  writeOtherBoats(cache);
}

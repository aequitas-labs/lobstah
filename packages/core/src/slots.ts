import { activeIds } from './queue.js';
import { readSessionClaim } from './soak.js';
import type { Lane } from './types.js';

/** A trap is an interactive session, not a daemon-spawned runner. */
export function isTrapCatch(id: string, lane: Lane): boolean {
  return readSessionClaim(id, lane)?.by.startsWith('wt:') ?? false;
}

export interface SlotUsage {
  headless: number;
  traps: number;
}

export function slotUsage(lane: Lane): SlotUsage {
  let ids: string[];
  try { ids = activeIds(lane); } catch { return { headless: 0, traps: 0 }; }
  const traps = ids.filter((id) => isTrapCatch(id, lane)).length;
  return { headless: ids.length - traps, traps };
}

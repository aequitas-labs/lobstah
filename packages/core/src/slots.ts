import { activeIds } from './queue.js';
import { readSessionClaim } from './soak.js';
import { readStatusLog } from './status.js';
import { TERMINAL_VERBS } from './types.js';
import type { Lane } from './types.js';

/** A trap is an interactive session, not a daemon-spawned runner. */
export function isTrapCatch(id: string, lane: Lane): boolean {
  return readSessionClaim(id, lane)?.by.startsWith('wt:') ?? false;
}

/**
 * The worker's last report is `done` or `failed`. A finished dispatch can
 * still sit in `active/` while its runner exits; it holds no slot.
 */
export function isFinished(id: string, lane: Lane): boolean {
  const verb = readStatusLog(id, lane).at(-1)?.verb;
  return verb !== undefined && TERMINAL_VERBS.includes(verb);
}

export interface SlotUsage {
  headless: number;
  traps: number;
}

/** Active dispatches that hold a slot. A finished dispatch is not counted. */
export function slotUsage(lane: Lane): SlotUsage {
  let ids: string[];
  try { ids = activeIds(lane); } catch { return { headless: 0, traps: 0 }; }
  ids = ids.filter((id) => !isFinished(id, lane));
  const traps = ids.filter((id) => isTrapCatch(id, lane)).length;
  return { headless: ids.length - traps, traps };
}

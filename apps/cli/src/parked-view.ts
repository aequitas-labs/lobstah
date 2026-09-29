import { ageLabel, parkedDispatches } from '@lobstah/core';
import type { ParkedDispatch } from '@lobstah/core';

/** One parked dispatch on one line: `6a1f0c2e waiting on review for 1h https://…`. */
export function parkedText(p: ParkedDispatch): string {
  const what = p.waiting ? `waiting on ${p.waiting.on}` : 'paused';
  return `${p.id.slice(0, 8)} ${what} for ${ageLabel(p.parkedSecs * 1000)}${p.waiting?.link ? ` ${p.waiting.link}` : ''}${p.trap ? ' (trap)' : ''}`;
}

/**
 * The parked part of a slot line: `parked: 2, no slot (6a1f0c2e waiting on
 * review for 1h …)`, or undefined when nothing is parked.
 */
export function parkedSummary(parked: ParkedDispatch[] = parkedDispatches()): string | undefined {
  if (parked.length === 0) return undefined;
  return `parked: ${parked.length}, no slot (${parked.map(parkedText).join('; ')})`;
}

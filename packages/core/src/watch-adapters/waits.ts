import { parsePrRef } from '../pr.js';
import type { StatusEntry } from '../types.js';

/** The compatibility wait distinguishes forge reviews from documents in their own tool. */
export function quietSourceWait(entry: Pick<StatusEntry, 'waitingOn' | 'link'>): boolean {
  return entry.waitingOn === 'review' && entry.link !== undefined && !parsePrRef(entry.link);
}

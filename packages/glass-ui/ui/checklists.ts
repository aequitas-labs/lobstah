import type { ChecklistProgress } from '../../core/src/checklist-types.js';
import type { GlassRead, GlassVerdict, GlassWrite } from './answers.js';

/** Where a document's checklist progress is read and ticked: part of each glass backend. */
export interface ChecklistSource {
  /** The document's stored progress. */
  load(key: string): Promise<GlassRead<ChecklistProgress>>;
  /** Tick or untick one item; the answer is the stored progress after it. */
  tick(key: string, item: string, checked: boolean, token: string): Promise<GlassWrite<ChecklistProgress & GlassVerdict>>;
}

let current: ChecklistSource | undefined;

/** Set by setBackend: the page's checklist source, or none when its source stores no checklist progress. */
export function setChecklistSource(source: ChecklistSource | undefined): void {
  current = source;
}

/** Whether this page stores checklist progress. Without it, a document's tasks show as written and read-only. */
export const hasChecklistSource = (): boolean => current !== undefined;

/** The page's checklist source. Only a document with a key and tasks asks for it. */
export function checklistSource(): ChecklistSource {
  if (!current) throw new Error('The glass has no checklist source; call setBackend before starting it.');
  return current;
}

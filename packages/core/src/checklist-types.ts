/** A task's stable identity, visible label and current saved state. */
export interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
}

/** Saved document progress; closed decisions cannot be edited. */
export interface ChecklistProgress {
  items: ChecklistItem[];
  readOnly: boolean;
}


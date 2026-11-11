import * as fs from 'node:fs';
import * as path from 'node:path';
import { archivedDecisionDir, atomicRenameSync, decisionDir, readArchivedDecision, readDecision, readDecisionAnswer, readDecisionDetail, readReport, readReportMarkdown, reportDir, uniqueTempPath } from '@lobstah/core';
import type { ChecklistProgress } from '@lobstah/core';
import { markdownTasks, parseMarkdown } from '@lobstah/glass-ui';

/** A missing document, changed task, or closed card cannot accept a tick. */
export class ChecklistError extends Error {
  constructor(message: string, public readonly status: number = 400) { super(message); }
}

/** Resolve only an existing card or report's own store and Markdown. */
function checklistDocument(key: string): { directory: string; markdown: string; readOnly: boolean } {
  if (key.startsWith('decision:')) {
    const active = readDecision(key);
    if (!active && !readArchivedDecision(key)) throw new ChecklistError('Card not found.', 404);
    return { directory: (active ? decisionDir(key) : archivedDecisionDir(key))!, markdown: readDecisionDetail(key) ?? '', readOnly: !active || !!readDecisionAnswer(key) };
  }
  if (!key.startsWith('report:') || !readReport(key)) throw new ChecklistError('Report not found.', 404);
  return { directory: reportDir(key)!, markdown: readReportMarkdown(key) ?? '', readOnly: false };
}

/** Load only boolean overrides; task identity prevents old ticks moving to changed text. */
function savedTicks(directory: string): Record<string, boolean> {
  try {
    const stored: unknown = JSON.parse(fs.readFileSync(path.join(directory, 'checklist.json'), 'utf8'));
    if (stored && typeof stored === 'object' && !Array.isArray(stored))
      return Object.fromEntries(Object.entries(stored).filter(([, checked]) => typeof checked === 'boolean'));
  } catch { /* An unedited document uses its Markdown defaults. */ }
  return {};
}

/** Read current task progress without answering or acknowledging the document. */
export function readChecklist(key: string): ChecklistProgress {
  const document = checklistDocument(key);
  const ticks = savedTicks(document.directory);
  return {
    readOnly: document.readOnly,
    items: markdownTasks(parseMarkdown(document.markdown)).map(({ id, text, checked }) => ({ id, text, checked: ticks[id] ?? checked })),
  };
}

/** Set one task, atomically preserving other ticks; never emit a decision-answer event. */
export function setChecklistTick(key: string, item: string, checked: boolean): ChecklistProgress {
  const document = checklistDocument(key);
  const progress = readChecklist(key);
  if (progress.readOnly) throw new ChecklistError('Closed cards are read-only.', 409);
  if (!progress.items.some((task) => task.id === item)) throw new ChecklistError('This task changed. Reload the document.', 409);
  const ticks = savedTicks(document.directory);
  // Drop stale identities whenever the document is edited.
  const updatedTicks = Object.fromEntries(progress.items.filter((task) => task.id in ticks).map((task) => [task.id, ticks[task.id]]));
  updatedTicks[item] = checked;
  const file = path.join(document.directory, 'checklist.json');
  const temporary = uniqueTempPath(file);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(updatedTicks)}\n`);
    atomicRenameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return readChecklist(key);
}

/** Human-readable CLI progress, including the Markdown's initially checked tasks. */
export function checklistSummary(key: string): string {
  const progress = readChecklist(key);
  return [`${progress.items.filter((item) => item.checked).length}/${progress.items.length} checked${progress.readOnly ? ' (read-only)' : ''}`,
    ...progress.items.map((item) => `- [${item.checked ? 'x' : ' '}] ${item.text}`)].join('\n');
}

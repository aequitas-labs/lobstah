import type { HelmPassView, TodoView } from '@lobstah/core';
import { useState } from 'preact/hooks';
import { scheduleTodo } from '../actions.js';
import { html } from '../html.js';
import { Age, lastPassText } from './common.js';
import { LinkedText } from './links.js';
import { can } from '../backend.js';
import { Button } from './button.js';
import { RecheckAll } from './recheck-all.js';

/** The times the box offers in one click. They go through the same parser as anything typed. */
const SCHEDULE_PRESETS: ReadonlyArray<{ label: string; until: string }> = [
  { label: '+2h', until: '2h' },
  { label: 'Tomorrow 09:00', until: 'tomorrow 09:00' },
];
/** A goal day starts at this local hour, as it does for goals and the done-today list. */
const GOAL_DAY_START_HOUR = 4;
/** Within this many days, a due time names the weekday alone. */
const WEEKDAY_ONLY_DAYS = 6;

/** A future due time for its chip: `Fri 09:00`, or `Nov 20 09:00` further out. */
function dueText(at: string): string {
  const due = new Date(at);
  const clock = due.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const near = due.getTime() - Date.now() < WEEKDAY_ONLY_DAYS * 86400_000;
  const day = near
    ? due.toLocaleDateString(undefined, { weekday: 'short' })
    : due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day} ${clock}`;
}

/** Whether an instant falls in the current goal day, in the browser's zone. */
function inGoalDay(at: string): boolean {
  const goalDay = (ms: number) => new Date(ms - GOAL_DAY_START_HOUR * 3600_000).toDateString();
  return goalDay(Date.parse(at)) === goalDay(Date.now());
}

/** What an open todo is waiting for, or what woke it. */
function TodoChips({ todo }: { todo: TodoView }) {
  const overdue =
    todo.overdue &&
    (todo.firedBy
      ? html` <span class="badge warn">fired: ${todo.firedBy}</span>`
      : html` <span class="badge warn">overdue ${todo.dueAt ? Age(todo.dueAt) : ''}</span>`);
  return html`${overdue}${!todo.overdue && todo.dueAt && html` <span class="badge dim">due ${dueText(todo.dueAt)}</span>`}${todo.every && html` <span class="badge dim">every ${todo.every}</span>`}${todo.lastDoneAt && inGoalDay(todo.lastDoneAt) && html` <span class="badge ok">done today</span>`}${!todo.firedBy && todo.waitingOn && html` <span class="badge dim">waiting on ${todo.waitingOn}</span>`}${todo.snoozes && html` <span class="badge dim">snoozed ${todo.snoozes}×</span>`}${todo.stale && html` <span class="badge warn">stale</span>`}`;
}

/** Set a time on a todo, or move one: a button that opens a small box on the row. */
function TodoSchedule({ todo }: { todo: TodoView }) {
  const [open, setOpen] = useState(false);
  const [until, setUntil] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const label = todo.dueAt || todo.overdue ? 'Snooze' : 'Set a time';
  if (!open)
    return html`<${Button} class="todo-schedule-open" type="button" onClick=${() => (setRefusal(null), setOpen(true))}>${label}<//>`;
  const save = async (e: Event) => {
    e.preventDefault();
    const reason = await scheduleTodo(todo.groundsKey, todo.id, until);
    setRefusal(reason ?? null);
    if (!reason) {
      setOpen(false);
      setUntil('');
    }
  };
  return html`<form class="todo-schedule" onSubmit=${save}>
    <label class="dim">${label} #${todo.id} until</label>
    ${SCHEDULE_PRESETS.map((preset) => html`<${Button} type="button" onClick=${() => setUntil(preset.until)}>${preset.label}<//>`)}
    <input type="text" name="until" placeholder="thu 14:00" aria-label=${`${label} todo ${todo.id} until`} value=${until} onInput=${(e: Event) => setUntil((e.target as HTMLInputElement).value)} />
    <${Button} type="submit" disabled=${!until.trim()}>Save<//>
    <${Button} type="button" onClick=${() => setOpen(false)}>Cancel<//>
    ${refusal && html`<span class="bad">${refusal}</span>`}
  </form>`;
}

/**
 * Keep the server's order and read-only checklist. Every count is of open
 * todos: the Deck shows the first five open with More for the rest, and the
 * ones done today (listed until 04:00) stay out of it, as a quiet line on the
 * Deck and a closed Done today section on the page.
 */
export function Todos({
  todos,
  note,
  passes = [],
  preview = false,
}: {
  todos: TodoView[];
  note?: string;
  passes?: HelmPassView[];
  preview?: boolean;
}) {
  const open = todos.filter((t) => !t.done);
  const doneToday = todos.filter((t) => t.done);
  if (preview && !open.length && !doneToday.length && !passes.length) return null;
  const shown = preview ? open.slice(0, 5) : open;
  const grounds = new Set(todos.map((t) => t.grounds)).size > 1;
  const shownPasses = passes;
  const row = (t: TodoView) =>
    html`<li key=${`todo:${t.grounds}:${t.id}`} class=${t.done ? 'todo-check done' : 'todo-check'}><input type="checkbox" checked=${!!t.done} disabled aria-label=${`Todo ${t.id}: ${t.text}`} title=${t.done ? 'Done today; it drops off when the day rolls over (04:00)' : `Read-only; use lobstah todo done ${t.id} --grounds ${t.grounds}`} /><div class="todo-content"><span class="todo-text">${t.done ? html`<s>${LinkedText(t.text)}</s>` : LinkedText(t.text)}</span><span class="dim">${grounds ? t.grounds + ' · ' : ''}#${t.id} · added ${preview ? [Age(t.createdAt), ' ago'] : html`<time datetime=${t.createdAt} title=${t.createdAt}>${new Date(t.createdAt).toLocaleString()}</time>`}</span>${!t.done && html`<${TodoChips} todo=${t} />`}${!t.done && !preview && can('todo-schedule') && html`<div class="todo-actions"><${TodoSchedule} todo=${t} /></div>`}</div></li>`;
  return html`<section class="todos"><div class="todo-heading"><h2>${preview ? 'Todos' : 'TODOs'}</h2>${shownPasses.length === 1 && html`<${RecheckAll} pass=${shownPasses[0]} />`}</div>${shownPasses.map((pass) => html`<div class="todo-pass"><span class="dim">${shownPasses.length > 1 ? pass.grounds + ' · ' : ''}${lastPassText(pass.lastPassAt)}</span>${shownPasses.length > 1 && html`<${RecheckAll} pass=${pass} />`}</div>`)}${note && html`<div class="dim">${LinkedText(note)}</div>`}${!open.length && html`<div class="empty">No open TODOs</div>`}<ul class="todo-checklist">${shown.map(row)}</ul>${preview && open.length > 5 && html`<a class="deckmore" href="#todos">More (${open.length - 5})</a>`}${
    doneToday.length > 0 &&
    (preview
      ? html`<a class="dim todo-done-today" href="#todos">${doneToday.length} done today</a>`
      : html`<details class="todo-done-today"><summary class="dim">Done today (${doneToday.length})</summary><ul class="todo-checklist">${doneToday.map(row)}</ul></details>`)
  }</section>`;
}

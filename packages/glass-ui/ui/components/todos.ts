import type { HelmPassView, TodoView } from '@lobstah/core';
import { useRef, useState } from 'preact/hooks';
import type { Children } from '../html.js';
import { html } from '../html.js';
import { Age, lastPassText } from './common.js';
import { LinkedText } from './links.js';
import { can } from '../backend.js';
import { Button } from './button.js';
import { RecheckAll } from './recheck-all.js';
import { ITEM_ICON } from './icons.js';
import { TodoSnooze, todoDueText } from './todo-snooze.js';
import { SectionHead } from './section-head.js';
/** A goal day starts at this local hour, as it does for goals and the done-today list. */
const GOAL_DAY_START_HOUR = 4;
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
  return html`${overdue}${!todo.overdue && todo.dueAt && html` <span class="badge dim">due ${todoDueText(todo.dueAt)}</span>`}${todo.every && html` <span class="badge dim">every ${todo.every}</span>`}${todo.lastDoneAt && inGoalDay(todo.lastDoneAt) && html` <span class="badge ok">done today</span>`}${!todo.firedBy && todo.waitingOn && html` <span class="badge dim">waiting on ${todo.waitingOn}</span>`}${todo.snoozes && html` <span class="badge dim">snoozed ${todo.snoozes}×</span>`}${todo.stale && html` <span class="badge warn">stale</span>`}`;
}

/** Read-only work with Snooze available by its clock or a sideways phone swipe. */
function TodoRow({ todo, preview, grounds }: { todo: TodoView; preview: boolean; grounds: boolean }): Children {
  const [snoozing, setSnoozing] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const available = !todo.done && can('todo-schedule');
  const open = (): void => {
    setRevealed(false);
    setSnoozing(true);
  };
  const close = (): void => {
    setSnoozing(false);
    anchor.current?.querySelector<HTMLButtonElement>('button')?.focus();
  };
  const swipeStart = (event: TouchEvent): void => {
    const touch = event.touches[0];
    const target = event.target as Element | null;
    swipe.current = available && touch && !target?.closest('button, input, a') ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const swipeEnd = (event: TouchEvent): void => {
    const start = swipe.current,
      touch = event.changedTouches[0];
    swipe.current = null;
    if (!start || !touch) return;
    const horizontal = touch.clientX - start.x,
      vertical = touch.clientY - start.y;
    if (Math.abs(horizontal) < 60 || Math.abs(horizontal) <= Math.abs(vertical) * 1.5) return;
    event.preventDefault();
    setRevealed(horizontal < 0);
  };
  return html`<li class=${'todo-check' + (todo.done ? ' done' : '') + (revealed ? ' snooze-revealed' : '')} onTouchStart=${swipeStart} onTouchEnd=${swipeEnd}>
    ${revealed && html`<div class="todo-swipe-action"><${Button} class="todo-swipe-snooze" onClick=${open}>${ITEM_ICON.snooze}Snooze<//></div>`}
    <div class="todo-row-body"><input type="checkbox" checked=${!!todo.done} disabled aria-label=${`Todo ${todo.id}: ${todo.text}`} title=${todo.done ? 'Done today; it drops off when the day rolls over (04:00)' : `Read-only; use lobstah todo done ${todo.id} --grounds ${todo.grounds}`} /><div class="todo-content"><span class="todo-text">${todo.done ? html`<s>${LinkedText(todo.text)}</s>` : LinkedText(todo.text)}</span><span class="dim">${grounds ? todo.grounds + ' · ' : ''}#${todo.id} · added ${preview ? [Age(todo.createdAt), ' ago'] : html`<time datetime=${todo.createdAt} title=${todo.createdAt}>${new Date(todo.createdAt).toLocaleString()}</time>`}</span>${!todo.done && html`<${TodoChips} todo=${todo} />`}</div>${available && html`<div class="todo-actions" ref=${anchor}><${Button} variant="icon" class="todo-schedule-open" label="Snooze" pressed=${snoozing} aria-expanded=${snoozing ? 'true' : 'false'} onClick=${open}>${ITEM_ICON.snooze}<//></div>`}</div>
    ${snoozing && html`<${TodoSnooze} todo=${todo} anchor=${anchor.current} onClose=${close} />`}
  </li>`;
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
  const row = (todo: TodoView): Children =>
    html`<${TodoRow} key=${`todo:${todo.grounds}:${todo.id}`} todo=${todo} preview=${preview} grounds=${grounds} />`;
  return html`<section class="todos">${preview ? html`<${SectionHead} title="Todos" count=${open.length} href="#todos" action=${shownPasses.length === 1 && html`<${RecheckAll} pass=${shownPasses[0]} />`} />` : html`<div class="todo-heading"><h2>TODOs</h2>${shownPasses.length === 1 && html`<${RecheckAll} pass=${shownPasses[0]} />`}</div>`}${shownPasses.map((pass) => html`<div class="todo-pass"><span class="dim">${shownPasses.length > 1 ? pass.grounds + ' · ' : ''}${lastPassText(pass.lastPassAt)}</span>${shownPasses.length > 1 && html`<${RecheckAll} pass=${pass} />`}</div>`)}${note && html`<div class="dim">${LinkedText(note)}</div>`}${!open.length && html`<div class="empty">No open TODOs</div>`}<ul class="todo-checklist">${shown.map(row)}</ul>${preview && open.length > 5 && html`<a class="deckmore" href="#todos">+${open.length - 5} more →</a>`}${
    doneToday.length > 0 &&
    (preview
      ? html`<a class="dim todo-done-today" href="#todos">${doneToday.length} done today</a>`
      : html`<details class="todo-done-today"><summary class="dim">Done today (${doneToday.length})</summary><ul class="todo-checklist">${doneToday.map(row)}</ul></details>`)
  }</section>`;
}

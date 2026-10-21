import type { TodoView } from '@lobstah/core';
import { html } from '../html.js';
import { Age } from './common.js';
import { LinkedText } from './links.js';

/** Keep the server's order and read-only checklist; the full page shows open items. */
export function Todos({ todos, note, preview = false }: { todos: TodoView[]; note?: string; preview?: boolean }) {
  const list = preview ? todos : todos.filter((t) => !t.done);
  if (preview && !list.length) return null;
  const shown = preview ? list.slice(0, 5) : list;
  const grounds = new Set(list.map((t) => t.grounds)).size > 1;
  return html`<section class="todos"><h2>${preview ? 'Todos' : 'TODOs'}</h2>${note && html`<div class="dim">${LinkedText(note)}</div>`}${!list.length && html`<div class="empty">No open TODOs</div>`}<ul class="todo-checklist">${shown.map(
    (t) =>
      html`<li key=${`todo:${t.grounds}:${t.id}`} class=${t.done ? 'todo-check done' : 'todo-check'}><input type="checkbox" checked=${!!t.done} disabled aria-label=${`Todo ${t.id}: ${t.text}`} title=${t.done ? 'Done today; it drops off when the day rolls over (04:00)' : `Read-only; use lobstah todo done ${t.id} --grounds ${t.grounds}`} /><div class="todo-content"><span class="todo-text">${t.done ? html`<s>${LinkedText(t.text)}</s>` : LinkedText(t.text)}</span><span class="dim">${grounds ? t.grounds + ' · ' : ''}#${t.id} · added ${preview ? [Age(t.createdAt), ' ago'] : html`<time datetime=${t.createdAt} title=${t.createdAt}>${new Date(t.createdAt).toLocaleString()}</time>`}</span>${!t.done && t.stale && html` <span class="badge warn">stale</span>`}</div></li>`,
  )}</ul>${preview && list.length > 5 && html`<a class="deckmore" href="#todos">More (${list.length - 5})</a>`}</section>`;
}

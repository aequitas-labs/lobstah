import type { TodoView } from '@lobstah/core';
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { scheduleTodo } from '../actions.js';
import type { Children } from '../html.js';
import { html } from '../html.js';
import { Button } from './button.js';
import { Dialog } from './dialog.js';
import { showToast } from './toast.js';

/** Presets use the server's time parser, just like a typed time. */
const SNOOZE_PRESETS: ReadonlyArray<{ label: string; until: string }> = [
  { label: '+2h', until: '2h' },
  { label: 'Tomorrow 09:00', until: 'tomorrow 09:00' },
];

/** A resolved due time in the browser's zone, shared by the row and its save confirmation. */
export function todoDueText(at: string): string {
  const due = new Date(at);
  const clock = due.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const near = due.getTime() - Date.now() < 6 * 86400_000;
  const day = near
    ? due.toLocaleDateString(undefined, { weekday: 'short' })
    : due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day} ${clock}`;
}

/** One snooze editor: anchored on desktop, a shared Dialog sheet below 700px. */
export function TodoSnooze({ todo, anchor, onClose }: { todo: TodoView; anchor: HTMLElement | null; onClose: () => void }): Children {
  const [phone, setPhone] = useState(window.innerWidth < 700);
  const [until, setUntil] = useState('');
  const formBox = useRef<HTMLFormElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const title = `Snooze #${todo.id} until`;
  useEffect(() => {
    const resize = (): void => setPhone(window.innerWidth < 700);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useLayoutEffect(() => {
    if (phone || !box.current || !anchor) return;
    const position = (): void => {
      const popup = box.current;
      if (!popup) return;
      const trigger = anchor.getBoundingClientRect();
      const bounds = popup.getBoundingClientRect();
      popup.style.left = `${Math.max(12, Math.min(trigger.right - bounds.width, window.innerWidth - bounds.width - 12))}px`;
      popup.style.top = `${trigger.bottom + bounds.height + 8 < window.innerHeight - 12 ? trigger.bottom + 8 : Math.max(12, trigger.top - bounds.height - 8)}px`;
    };
    position();
    box.current.querySelector<HTMLInputElement>('input')?.focus();
    const outside = (event: Event): void => {
      const target = event.target as Node | null;
      if (target && !box.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('scroll', position, true);
      window.removeEventListener('resize', position);
    };
  }, [phone, anchor]);
  const save = async (): Promise<string | undefined> => {
    const reason = await scheduleTodo(todo.groundsKey, todo.id, until, (dueAt) =>
      showToast(`Snoozed #${todo.id} until ${todoDueText(dueAt)}`),
    );
    if (!reason) onClose();
    return reason;
  };
  // Enter uses the same Button action as a click, including its pending and refusal state.
  const submit = (event: Event): void => {
    event.preventDefault();
    formBox.current?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
  };
  const form = html`<form class="todo-snooze-form" ref=${formBox} onSubmit=${submit}>
    <div class="todo-snooze-presets">${SNOOZE_PRESETS.map((preset) => html`<${Button} size=${phone ? 'lg' : 'md'} type="button" onClick=${() => setUntil(preset.until)}>${preset.label}<//>`)}</div>
    <div class="todo-snooze-time"><input type="text" name="until" placeholder="thu 14:00" aria-label=${title} value=${until} onInput=${(event: Event) => setUntil((event.target as HTMLInputElement).value)} />
    <${Button} variant="primary" size=${phone ? 'lg' : 'md'} type="submit" action=${save} sending="Snoozing…" disabled=${!until.trim()}>Snooze<//></div>
  </form>`;
  return createPortal(
    phone
      ? html`<${Dialog} title=${title} onClose=${onClose} cls="todo-snooze-sheet">${form}<//>`
      : html`<div class="todo-snooze-popover" role="dialog" aria-label=${title} ref=${box}><h3>${title}</h3>${form}</div>`,
    document.body,
  );
}

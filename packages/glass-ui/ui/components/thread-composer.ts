import { useState } from 'preact/hooks';
import { html } from '../html.js';
import { getState } from '../store.js';
import { can } from '../backend.js';
import { closeMessage, openMessage, sendMessage } from '../thread-actions.js';
import { Dialog } from './dialog.js';
import { Composer } from './composer.js';
import { Button } from './button.js';
import { HelmIcon } from './icons.js';
import { unreadOrder } from '../actions.js';

export function MessageButton() {
  if (!can('thread-message')) return null;
  const dismissed = getState().alertDismissed;
  const alert = unreadOrder().some((card) => !dismissed.includes(card.key));
  return html`<${Button} variant="icon" size="lg" class=${'message-fab' + (alert ? ' above-alert' : '')} label="Message the helm" onClick=${() => openMessage()}>${HelmIcon}<//>`;
}
export function ThreadComposer({ id }: { id: string }) {
  const key = `thread:${id}`,
    state = getState();
  return html`<${Composer} allowFiles draftKey=${key} draft=${state.drafts[key]} accept=${state.snapshot?.answerLimits?.extensions.join(',') ?? ''} label="Add to this thread" onSend=${() => sendMessage(key, { id })} done="Message sent" />`;
}
export function MessageSheet() {
  const state = getState(),
    context = state.messageSheet;
  const grounds = [
    ...new Set([...(state.snapshot?.helms ?? []).map((h) => h.grounds), ...(state.snapshot?.backends ?? []).map((b) => b.grounds)]),
  ];
  const [selected, choose] = useState(context?.grounds ?? grounds[0] ?? 'home');
  if (!context) return null;
  const key = `message:${selected}:${context.about ?? ''}`;
  return html`<${Dialog} title="Message the helm" icon=${HelmIcon} onClose=${closeMessage}>
    ${!context.about && grounds.length > 1 && html`<label>Helm <select aria-label="Helm" value=${selected} onChange=${(e: Event) => choose((e.currentTarget as HTMLSelectElement).value)}>${grounds.map((g) => html`<option key=${g}>${g}</option>`)}</select></label>`}
    ${context.about && html`<p class="dim">About ${context.about.slice(0, 8)}</p>`}
    <${Composer} allowFiles draftKey=${key} draft=${state.drafts[key]} accept=${state.snapshot?.answerLimits?.extensions.join(',') ?? ''} label="Your message" onSend=${() => sendMessage(key, context.about ? { about: context.about } : { grounds: selected })} done="Message sent" />
  <//>`;
}

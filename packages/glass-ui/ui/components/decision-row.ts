import { html, type Children } from '../html.js';

/** The compact decision card, shared by decisions and conversation summaries. */
export function DecisionRow({
  title,
  label,
  state = 'read',
  focused = false,
  prefix,
  context,
  meta,
  boat,
  status,
  preview,
  attrs,
  onOpen,
}: {
  title: Children;
  label: string;
  state?: 'unread' | 'read' | 'answered';
  focused?: boolean;
  prefix?: Children;
  context?: Children;
  meta?: Children;
  boat?: Children;
  status?: Children;
  preview?: string;
  attrs?: Record<string, unknown>;
  onOpen: () => void;
}) {
  return html`<li class=${'drow ' + state + (focused ? ' focus' : '')} ...${attrs}>
    <button type="button" class="dopen" onClick=${onOpen} aria-label=${label}>
      ${prefix}<b class="dtitle">${title}</b>${context}
      ${preview && html`<span class="dpreview" title=${preview}>${preview}</span>`}
      <span class="dmeta dim">${meta}</span>${boat && html`<span class="dboat dim">${boat}</span>`}${status}
    </button>
  </li>`;
}

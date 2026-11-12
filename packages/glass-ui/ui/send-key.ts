import { html } from './html.js';

/**
 * Ctrl+Enter sends from a glass text box that has a Send button, as the
 * button does; on a Mac, ⌘+Enter does too. Plain Enter keeps adding a
 * newline. The box decides whether Send is enabled; this only reads keys.
 */

/** A touch screen with no mouse or keyboard to speak of: no hotkey numbers, no keyboard legend, no send hint. */
export const touchOnly = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia('(hover: none) and (pointer: coarse)').matches;

/** Whether this page runs on a Mac (or an iPad or iPhone with a keyboard), where ⌘ is the modifier. */
export function isMac(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(nav.userAgentData?.platform || nav.platform || '');
}

/**
 * Whether a keydown is the send shortcut: Enter with Ctrl, or with ⌘ on a
 * Mac, and no other modifier. A held key's repeats and a key that ends an
 * IME composition never count, so one press sends once.
 */
export function isSendKey(e: KeyboardEvent): boolean {
  if (e.key !== 'Enter' || e.repeat || e.isComposing || e.keyCode === 229 || e.altKey || e.shiftKey) return false;
  return e.ctrlKey !== e.metaKey && (e.ctrlKey || isMac());
}

/**
 * A text box's keydown handler: the send shortcut sends when `enabled()`
 * says Send is enabled, through the same path as the button, and never
 * types a newline. Every other key is the box's own.
 */
export const onSendKey =
  (enabled: () => boolean, send: () => void) =>
  (e: KeyboardEvent): void => {
    if (!isSendKey(e)) return;
    e.preventDefault();
    if (enabled()) send();
  };

/** The quiet hint beside Send: "⌘↵ to send" on a Mac, "Ctrl+↵ to send" elsewhere. */
export const SendHint = () => html`<span class="sendhint" aria-hidden="true">${isMac() ? '⌘↵ to send' : 'Ctrl+↵ to send'}</span>`;

/** What a box's `aria-keyshortcuts` names, beside any key of its own. */
export const sendShortcut = (): string => (isMac() ? 'Meta+Enter Control+Enter' : 'Control+Enter');

import { useState } from 'preact/hooks';
import type { Children } from '../html.js';
import { html } from '../html.js';
import { showToast } from './toast.js';

/**
 * The glass's one button, the atom every control on every page is built
 * from: the local glass, the hosted glass and its Boats page alike.
 *
 * - `secondary` (the default): a quiet bordered button, its words in grey.
 * - `primary`: the one main action of a card, dialog or row, in the text's color.
 * - `danger`: filled red, for what can't be undone (Stop, Revoke).
 * - `icon`: an icon alone, a square, named by its label for screen readers and on hover.
 *
 * Touch pointers keep `md` at 32px and `lg` at 40px. Fine pointers use 26px
 * and 32px. The pointer, not viewport width, selects the size.
 * Molecules (the split button, the copy button, an option card, a segmented
 * control) are built from it and add only layout.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'icon';
export type ButtonSize = 'md' | 'lg';

export type ButtonAction = (event: Event) => Promise<string | undefined | void> | string | undefined | void;

/**
 * The classes a button wears: `btn`, its variant, its size when not `md`,
 * then any role classes. For an element that can't be a Button (a file
 * picker's label, a button a ref must reach).
 */
export const buttonClass = (variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', extra?: string | false | null): string =>
  ['btn', `btn-${variant}`, size === 'lg' && 'btn-lg', extra].filter(Boolean).join(' ');

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A link that looks like a button: renders an `<a>`. */
  href?: string;
  /** The button's name, for an icon alone: its aria-label, and its title unless one is given. */
  label?: string;
  /** A toggle that is on: `aria-pressed` and the pressed look. */
  pressed?: boolean;
  /** Role classes the page and its tests find it by (`open`, `runbtn`); never sizes or colors. */
  class?: string | false;
  type?: 'button' | 'submit';
  /** An async action: disables this button, shows progress and reports its result. */
  action?: ButtonAction;
  /** The short label to show while `action` is running. */
  sending?: string;
  /** Keep the action's normal label beside the progress icon while it runs. */
  preserveLabel?: boolean;
  /** Replace the hover text while `action` is running. */
  pendingTitle?: string;
  /** The caller owns error presentation when false. */
  showError?: boolean;
  /** The success message to announce after `action` completes. */
  done?: string;
  onClick?: (event: Event) => void;
  children?: Children;
  [attr: string]: unknown;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  href,
  label,
  pressed,
  class: extra,
  type = 'button',
  action,
  sending = 'Sending…',
  preserveLabel = false,
  pendingTitle,
  showError = true,
  done,
  onClick,
  children,
  ...rest
}: ButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { disabled, ...attributes } = rest;
  const cls = buttonClass(variant, size, [extra, pressed && 'on'].filter(Boolean).join(' ') || undefined);
  const named = label ? { 'aria-label': label, title: (rest.title as string | undefined) ?? label } : {};
  const toggle = pressed === undefined ? {} : { 'aria-pressed': pressed ? 'true' : 'false' };
  const run = action
    ? async (event: Event) => {
        event.preventDefault();
        if (busy || disabled) return;
        setBusy(true);
        setError(undefined);
        try {
          const refusal = await action(event);
          if (refusal) setError(refusal);
          else if (done) showToast(done);
        } catch (error) {
          setError(error instanceof Error ? error.message : 'The action could not be completed.');
        } finally {
          setBusy(false);
        }
      }
    : undefined;
  const spinner = html`<span class="runicon" aria-hidden="true"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><g class="runspin"><circle cx="8" cy="8" r="6" stroke-opacity="0.3"/><path d="M8 2a6 6 0 0 1 6 6"/></g><circle class="rundot" cx="8" cy="8" r="4" fill="currentColor" stroke="none"/></svg></span>`;
  const buttonChildren = busy ? html`${spinner}${preserveLabel ? children : sending}` : children;
  const title = busy && pendingTitle ? pendingTitle : ((attributes.title as string | undefined) ?? (named.title as string | undefined));
  const control =
    href !== undefined
      ? html`<a class=${cls} href=${href} ...${named} ...${attributes} title=${title} aria-busy=${busy ? 'true' : undefined} onClick=${onClick}>${buttonChildren}</a>`
      : html`<button type=${type} class=${cls} ...${named} ...${toggle} ...${attributes} title=${title} disabled=${disabled || busy} aria-busy=${busy ? 'true' : undefined} onClick=${action ? run : onClick}>${buttonChildren}</button>`;
  return href !== undefined ? control : html`${control}${showError && error && html`<span class="bad" role="alert">${error}</span>`}`;
}

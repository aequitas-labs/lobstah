import type { Children } from '../html.js';
import { html } from '../html.js';

/**
 * The glass's one button, the atom every control on every page is built
 * from: the local glass, the hosted glass and its Boats page alike.
 *
 * - `secondary` (the default): a quiet bordered button, its words in grey.
 * - `primary`: the one main action of a card, dialog or row, in the text's color.
 * - `danger`: filled red, for what can't be undone (Stop, Revoke).
 * - `icon`: an icon alone, a square, named by its label for screen readers and on hover.
 *
 * Every size is set here and nowhere else: `md` is 32px tall with 12px words
 * (the default, everywhere), and `lg` is 40px with 14px words, kept for the
 * decision dock and a run card's row, where a thumb does the work.
 * Molecules (the split button, the copy button, an option card, a segmented
 * control) are built from it and add only layout.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'icon';
export type ButtonSize = 'md' | 'lg';

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
  children,
  ...rest
}: ButtonProps) {
  const cls = buttonClass(variant, size, [extra, pressed && 'on'].filter(Boolean).join(' ') || undefined);
  const named = label ? { 'aria-label': label, title: (rest.title as string | undefined) ?? label } : {};
  const toggle = pressed === undefined ? {} : { 'aria-pressed': pressed ? 'true' : 'false' };
  return href !== undefined
    ? html`<a class=${cls} href=${href} ...${named} ...${rest}>${children}</a>`
    : html`<button type=${type} class=${cls} ...${named} ...${toggle} ...${rest}>${children}</button>`;
}

import { h } from 'preact';
import htm from 'htm';
import type { ComponentChildren } from 'preact';

/**
 * htm bound to Preact's h: tagged-template markup that builds virtual DOM,
 * no build-time JSX. Interpolated text is text, never markup, so nothing
 * here needs escaping.
 *
 * Empty strings are dropped from children: Preact compares a text node's
 * props with `oldProps || {}`, so an empty text node is rewritten on every
 * render — a DOM mutation for nothing. An empty text node renders nothing
 * anyway, so null is the same page.
 */
type Child = ComponentChildren;
const clean = (c: Child): Child => (Array.isArray(c) ? c.map(clean) : c === '' ? null : c);
const hh = (type: Parameters<typeof h>[0], props: Record<string, unknown> | null, ...children: Child[]) =>
  h(type as never, props as never, ...children.map(clean));

export const html = htm.bind(hh);

/** Anything a component can return or nest. */
export type Children = ComponentChildren;

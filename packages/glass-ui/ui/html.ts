import { h } from 'preact';
import htm from 'htm';
import type { ComponentChildren, VNode } from 'preact';
import { isExternalHref } from '../src/glass-links.js';

/**
 * htm bound to Preact's h: tagged-template markup that builds virtual DOM,
 * no build-time JSX. Interpolated text is text, never markup, so nothing
 * here needs escaping.
 *
 * Empty strings are dropped from children: Preact compares a text node's
 * props with `oldProps || {}`, so an empty text node is rewritten on every
 * render — a DOM mutation for nothing. An empty text node renders nothing
 * anyway, so null is the same page.
 *
 * Every `<a>` either glass renders comes through here, so this is where a
 * link that leaves the glass gets its new tab and its ↗ mark (see
 * `externalLinkProps`).
 */
type Child = ComponentChildren;
type Props = Record<string, unknown>;
const clean = (c: Child): Child => (Array.isArray(c) ? c.map(clean) : c === '' ? null : c);
const hh = (type: Parameters<typeof h>[0], props: Props | null, ...children: Child[]) =>
  h(type as never, (type === 'a' && props ? externalLinkProps(props, children) : props) as never, ...children.map(clean));

export const html = htm.bind(hh);

/** Anything a component can return or nest. */
export type Children = ComponentChildren;

/** The ↗ a label may already show, as "↗ Open" does. */
const ARROW = '↗';

/**
 * A link's props, made to open in a new tab when its href leaves the glass
 * (`isExternalHref` against this page's origin). It also gets the
 * `extlink` class, which glass.css draws as a ↗ after the label, unless the
 * label already shows ↗. An in-app link (a hash route, a relative path,
 * this origin's report page) keeps the props it was written with.
 */
export function externalLinkProps(props: Props, children: Child[]): Props {
  const origin = globalThis.location?.origin;
  if (typeof props.href !== 'string' || !origin || !isExternalHref(props.href, origin)) return props;
  const marked = labelShowsArrow(children) ? props.class : [props.class, 'extlink'].filter(Boolean).join(' ');
  return { ...props, class: marked, target: '_blank', rel: 'noopener noreferrer' };
}

/** Whether a link's label, at any depth, already has the ↗ in its text. */
function labelShowsArrow(children: Child): boolean {
  if (typeof children === 'string') return children.includes(ARROW);
  if (Array.isArray(children)) return children.some(labelShowsArrow);
  if (children && typeof children === 'object' && 'props' in children)
    return labelShowsArrow((children as VNode<{ children?: Child }>).props.children);
  return false;
}

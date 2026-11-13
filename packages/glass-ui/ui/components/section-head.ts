import { html } from '../html.js';
import type { Children } from '../html.js';

/** A shared deck section heading or page title, with an optional list link, count, and trailing action. */
export function SectionHead({
  title,
  count,
  href,
  action,
  badge,
  page = false,
  id,
}: {
  title: string;
  count?: number;
  href?: string;
  action?: Children;
  badge?: Children;
  page?: boolean;
  id?: string;
}): Children {
  const tag = page ? 'h1' : 'h2';
  const details = [
    title,
    badge,
    count !== undefined && [' ', html`<span class="section-count">· ${count}</span>`],
    href && html`<span aria-hidden="true"> →</span>`,
  ];
  return html`<div class=${'section-head' + (page ? ' page-head' : '')} id=${id}>
    <${tag}>${href ? html`<a href=${href}>${details}</a>` : details}</${tag}>
    ${action && html`<div class="section-action">${action}</div>`}
  </div>`;
}

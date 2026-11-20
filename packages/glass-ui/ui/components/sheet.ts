import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { html } from '../html.js';
import { LinkedText } from './links.js';
import { buttonClass } from './button.js';

/**
 * A full-page sheet over the glass, as a report and a conversation open: a bar
 * with Back and the title, then the page, scrolling on its own so the tab
 * underneath keeps its place. Back takes focus each time `page` changes.
 */
export function Sheet({
  page,
  title,
  titleId,
  cls,
  onBack,
  children,
}: {
  page: string;
  title: string;
  titleId: string;
  cls?: string;
  onBack: () => void;
  children: ComponentChildren;
}) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    back.current?.focus();
  }, [page]);
  return html`<div class=${'rsheet' + (cls ? ' ' + cls : '')} role="dialog" aria-modal="true" aria-labelledby=${titleId}>
    <div class="rbar"><button type="button" class=${buttonClass('secondary', 'md', 'rback')} ref=${back} onClick=${onBack}>‹ Back</button><b id=${titleId} class="rbartitle">${LinkedText(title)}</b></div>
    <div class="rbody">${children}</div>
  </div>`;
}

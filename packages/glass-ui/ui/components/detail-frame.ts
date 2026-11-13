import { useEffect, useRef } from 'preact/hooks';
import { html, type Children } from '../html.js';
import { closeModal } from '../actions.js';
import { Button } from './button.js';

/** One scrollable detail body: centered on desktop, full screen with a Back bar on a phone. */
export function DetailFrame({
  identity,
  open,
  children,
  footer,
}: {
  identity: Children;
  open?: Children;
  children: Children;
  footer?: Children;
}) {
  const back = useRef<HTMLElement>(null);
  useEffect(() => {
    const focused = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    back.current?.querySelector<HTMLButtonElement>(innerWidth < 700 ? '.detail-back' : '.detail-close')?.focus();
    return () => {
      document.body.style.overflow = overflow;
      if (focused && document.contains(focused)) focused.focus?.();
    };
  }, []);
  return html`<section ref=${back} class="detail-frame" onKeyDown=${(event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const controls = [
      ...(back.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, textarea, select, [tabindex="0"]') ?? []),
    ].filter((node) => !node.hidden && getComputedStyle(node).display !== 'none');
    const first = controls[0],
      last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }} role="dialog" aria-modal="true" aria-label="Details">
    <div class="detail-bar"><${Button} class="detail-back" onClick=${closeModal}>‹ Back<//><div class="detail-bar-identity">${identity}</div><div class="detail-open">${open}</div><${Button} variant="icon" class="detail-close" label="Close" onClick=${closeModal}>×<//></div>
    <div class="detail-scroll"><div class="detail-identity">${identity}</div>${children}</div>
    ${footer && html`<div class="detail-actions">${footer}</div>`}
  </section>`;
}

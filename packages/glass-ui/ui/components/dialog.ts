import { useEffect, useRef } from 'preact/hooks';
import type { Children } from '../html.js';
import { html } from '../html.js';
import { usePhoneBack } from '../overlay-history.js';
import { Button } from './button.js';

/**
 * A dialog, the molecule New trap and Settings open in: a centered modal on
 * a desktop, a sheet rising from the bottom on a phone. Which one is
 * glass.css's: the phone breakpoint every phone layout uses (under 700px).
 * Its title heads it beside a close button; Escape, the close button or a tap
 * on the scrim around it closes it. It takes focus when it opens.
 */
export function Dialog({
  title,
  icon,
  onClose,
  cls,
  id: elementId,
  children,
}: {
  title: string;
  icon?: Children;
  onClose: () => void;
  cls?: string;
  id?: string;
  children: Children;
}): Children {
  const box = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  usePhoneBack(onClose);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    box.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        const controls = [
          ...(box.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
          ) ?? []),
        ];
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first || !last) {
          e.preventDefault();
          box.current?.focus();
        } else if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === box.current)) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.body.style.overflow = overflow;
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
    };
  }, []);
  const id = 'dialog-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return html`<div class="dialog-scrim" onClick=${(e: Event) => e.target === e.currentTarget && onClose()}>
    <div id=${elementId} class=${['dialog', cls].filter(Boolean).join(' ')} role="dialog" aria-modal="true" aria-labelledby=${id} tabindex="-1" ref=${box} onClick=${(e: Event) => e.stopPropagation()}>
      <div class="dialog-head" onTouchStart=${(event: TouchEvent) => {
        const point = event.touches[0];
        touch.current = innerWidth < 700 && point ? { x: point.clientX, y: point.clientY } : null;
      }} onTouchEnd=${(event: TouchEvent) => {
        const start = touch.current,
          end = event.changedTouches[0];
        touch.current = null;
        if (start && end && end.clientY - start.y > 60 && end.clientY - start.y > Math.abs(end.clientX - start.x) * 1.5) onClose();
      }}><h3 id=${id}>${icon}${title}</h3><${Button} variant="icon" class="dialog-close" label="close" onClick=${onClose}>×<//></div>
      <div class="dialog-body">${children}</div>
    </div>
  </div>`;
}

import { useEffect, useRef } from 'preact/hooks';
import { closeLightbox, stepLightbox } from '../actions.js';
import { html } from '../html.js';
import { usePhoneBack } from '../overlay-history.js';
import type { Lightbox } from '../store.js';
import { Button } from './button.js';

/** Images from one card, report or description, stepped by swipe or arrow keys. */
export function LightboxView({ box }: { box: Lightbox | null }) {
  const root = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  usePhoneBack(closeLightbox, !!box);
  useEffect(() => {
    if (!box) return;
    const back = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    root.current?.querySelector<HTMLButtonElement>('.lbclose')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const controls = [...(root.current?.querySelectorAll<HTMLElement>('button, a[href]') ?? [])];
        const first = controls[0],
          last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
      if (event.key === 'Escape') {
        event.stopImmediatePropagation();
        closeLightbox();
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        stepLightbox(event.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.body.style.overflow = overflow;
      if (back && document.contains(back)) back.focus();
    };
  }, [!!box]);
  if (!box) return null;
  const multiple = (box.images?.length ?? 0) > 1;
  return html`<div ref=${root} id="lightbox" class="lightbox" role="dialog" aria-modal="true" aria-label=${box.name} onClick=${(
    event: Event,
  ) => {
    if (event.target === event.currentTarget) closeLightbox();
  }}
    onTouchStart=${(event: TouchEvent) => {
      const point = event.touches[0];
      touch.current = multiple && point ? { x: point.clientX, y: point.clientY } : null;
    }}
    onTouchEnd=${(event: TouchEvent) => {
      const start = touch.current,
        end = event.changedTouches[0];
      touch.current = null;
      if (!start || !end) return;
      const dx = end.clientX - start.x,
        dy = end.clientY - start.y;
      if (Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy) * 1.5) stepLightbox(dx < 0 ? 1 : -1);
    }}>
    <div class="lbcontrols">${multiple && html`<span class="lbcount" aria-live="polite">${(box.index ?? 0) + 1} of ${box.images!.length}</span>`}<${Button} variant="icon" class="lbclose" label="Close image" onClick=${closeLightbox}>×<//></div>
    ${multiple && html`<${Button} variant="icon" class="lbprev" label="Previous image" onClick=${() => stepLightbox(-1)}>‹<//><${Button} variant="icon" class="lbnext" label="Next image" onClick=${() => stepLightbox(1)}>›<//>`}
    <img class="lbimg" src=${box.src} alt=${box.name} referrerpolicy="no-referrer" />
    <a class="lboriginal" href=${box.src} target="_blank" rel="noopener noreferrer">open original · ${box.name}</a>
  </div>`;
}

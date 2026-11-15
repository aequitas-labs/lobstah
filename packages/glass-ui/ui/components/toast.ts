import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { html, type Children } from '../html.js';
import { Button } from './button.js';

type ToastMessage = { id: number; message: string };
type ToastListener = (message: string) => void;

const listeners = new Set<ToastListener>();
let nextId = 0;

/** Announce a completed action in the glass's shared, non-blocking toast area. */
export function showToast(message: string): void {
  for (const listener of listeners) listener(message);
}

/** Shared timing, touch dismissal and desktop close control for every toast. */
export function Toast({
  children,
  onDismiss,
  duration = 2500,
  class: extra = '',
}: {
  children: Children;
  onDismiss: () => void;
  duration?: number | null;
  class?: string;
}): Children {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useLayoutEffect(() => {
    if (duration === null) return;
    const timer = setTimeout(() => dismiss.current(), duration);
    return () => clearTimeout(timer);
  }, [duration]);

  const gesture = useRef<{ id: number; x: number; y: number; horizontal?: boolean }>();
  const suppressClick = useRef(false);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = (event: PointerEvent) => {
    suppressClick.current = false;
    if (event.pointerType !== 'touch' || gesture.current) return;
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const move = (event: PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    const x = event.clientX - g.x;
    const y = event.clientY - g.y;
    if (g.horizontal === undefined && Math.max(Math.abs(x), Math.abs(y)) > 8) {
      g.horizontal = Math.abs(x) > Math.abs(y);
      if (g.horizontal) (event.currentTarget as HTMLElement).setPointerCapture?.(g.id);
    }
    if (!g.horizontal) return;
    suppressClick.current = true;
    setDragging(true);
    setOffset(x);
  };
  const finish = (event: PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    gesture.current = undefined;
    setDragging(false);
    setOffset(0);
    if (event.type === 'pointerup' && g.horizontal && Math.abs(event.clientX - g.x) >= 80) dismiss.current();
  };

  return html`<div
    class=${['glass-toast', extra, dragging && 'dragging'].filter(Boolean).join(' ')}
    role="status"
    aria-live="polite"
    style=${{ transform: `translateX(${offset}px)` }}
    onPointerDown=${start}
    onPointerMove=${move}
    onPointerUp=${finish}
    onPointerCancel=${finish}
    onLostPointerCapture=${(event: PointerEvent) => {
      if (event.target === event.currentTarget) finish(event);
    }}
    onClickCapture=${(event: MouseEvent) => {
      if (suppressClick.current && event.detail !== 0) {
        event.preventDefault();
        event.stopPropagation();
      }
    }}
  ><div class="toast-content">${children}</div><span class="toast-close"><${Button} variant="icon" class="dx" label="Dismiss notification" onClick=${onDismiss}>×<//></span></div>`;
}

/** Shared dismissal behavior preserves the notice and feedback's original positions. */
export function ToastHost({ children }: { children?: Children }): Children {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  useLayoutEffect(() => {
    const receive = (message: string) => {
      const id = ++nextId;
      setToasts((current) => [...current, { id, message }]);
    };
    listeners.add(receive);
    return () => {
      listeners.delete(receive);
    };
  }, []);
  return html`<div class="glass-toasts">${children}<div class="toast-feedback">${toasts.map(
    (toast) =>
      html`<${Toast} key=${toast.id} onDismiss=${() => setToasts((current) => current.filter((item) => item.id !== toast.id))}>${toast.message}<//>`,
  )}</div></div>`;
}

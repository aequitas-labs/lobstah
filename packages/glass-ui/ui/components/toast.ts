import { useLayoutEffect, useState } from 'preact/hooks';
import { html, type Children } from '../html.js';

type ToastMessage = { id: number; message: string };
type ToastListener = (message: string) => void;

const listeners = new Set<ToastListener>();
let nextId = 0;

/** Announce a completed action in the glass's shared, non-blocking toast area. */
export function showToast(message: string): void {
  for (const listener of listeners) listener(message);
}

/** The glass-wide live region keeps success feedback visible when an action closes its card. */
export function ToastHost(): Children {
  const [toast, setToast] = useState<ToastMessage>();
  useLayoutEffect(() => {
    const receive = (message: string) => {
      const id = ++nextId;
      setToast({ id, message });
    };
    listeners.add(receive);
    return () => {
      listeners.delete(receive);
    };
  }, []);
  return toast && html`<div class="glass-toast" role="status" aria-live="polite">${toast.message}</div>`;
}

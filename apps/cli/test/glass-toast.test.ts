import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { html } from '../../../packages/glass-ui/ui/html.js';
import { showToast, Toast, ToastHost } from '../../../packages/glass-ui/ui/components/toast.js';

let window: Window;
let root: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  window = new Window();
  vi.stubGlobal('document', window.document);
  root = window.document.createElement('div') as unknown as HTMLDivElement;
  window.document.body.appendChild(root as never);
});
afterEach(async () => {
  act(() => render(null, root));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await window.happyDOM.close();
});
const toast = () => root.querySelector<HTMLElement>('.glass-toast')!;
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
function pointer(type: string, x: number, y = 10, id = 1) {
  act(() =>
    toast().dispatchEvent(
      new window.PointerEvent(type, {
        bubbles: true,
        pointerType: 'touch',
        pointerId: id,
        clientX: x,
        clientY: y,
      }) as unknown as Event,
    ),
  );
}
function notice() {
  const dismiss = vi.fn();
  const open = vi.fn();
  act(() => render(html`<${Toast} duration=${null} onDismiss=${dismiss}><button onClick=${open}>5 new decisions</button><//>`, root));
  return { dismiss, open };
}

describe('Glass toasts', () => {
  it('dismisses a confirmation after 2.5 seconds', () => {
    act(() => render(html`<${ToastHost} />`, root));
    act(() => showToast('Answer sent'));
    advance(2499);
    expect(toast().textContent).toContain('Answer sent');
    advance(1);
    expect(toast()).toBeNull();
  });

  it('stacks confirmations and gives each its own lifetime without resetting earlier timers', () => {
    act(() => render(html`<${ToastHost} />`, root));
    act(() => showToast('Answer sent'));
    advance(1000);
    act(() => showToast('Snoozed #1'));
    advance(1499);
    expect(root.querySelectorAll('.glass-toast')).toHaveLength(2);
    advance(1);
    expect(root.querySelectorAll('.glass-toast')).toHaveLength(1);
    expect(toast().textContent).toContain('Snoozed #1');
    advance(1000);
    expect(toast()).toBeNull();
  });

  it('keeps action notices until acted on or dismissed with the close button', () => {
    const { dismiss, open } = notice();
    advance(60_000);
    expect(toast().textContent).toContain('5 new decisions');
    act(() => root.querySelector<HTMLButtonElement>('.toast-content button')!.click());
    expect(open).toHaveBeenCalledOnce();
    expect(dismiss).not.toHaveBeenCalled();
    act(() => root.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!.click());
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it.each([-100, 100])('dismisses a touch swipe of %i pixels', (distance) => {
    const { dismiss, open } = notice();
    pointer('pointerdown', 150);
    pointer('pointermove', 150 + distance);
    expect(toast().style.transform).toBe(`translateX(${distance}px)`);
    pointer('pointerup', 150 + distance);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });

  it('also lets a swipe dismiss a confirmation before its timer expires', () => {
    act(() => render(html`<${ToastHost} />`, root));
    act(() => showToast('Answer sent'));
    pointer('pointerdown', 150);
    pointer('pointermove', 50);
    pointer('pointerup', 50);
    expect(toast()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps swiping when capture moves from a child button to the toast', () => {
    const { dismiss } = notice();
    pointer('pointerdown', 150);
    pointer('pointermove', 50);
    act(() => root.querySelector('.toast-content button')!.dispatchEvent(new window.PointerEvent('lostpointercapture', { bubbles: true, pointerId: 1 }) as unknown as Event));
    pointer('pointerup', 50);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('follows a short swipe, snaps back, and suppresses the swipe click while allowing the next tap', () => {
    const { dismiss, open } = notice();
    pointer('pointerdown', 150);
    pointer('pointermove', 120);
    expect(toast().style.transform).toBe('translateX(-30px)');
    pointer('pointerup', 120);
    expect(toast().style.transform).toBe('translateX(0px)');
    act(() =>
      root
        .querySelector('.toast-content button')!
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 }) as unknown as Event),
    );
    expect(dismiss).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    pointer('pointerdown', 150);
    pointer('pointerup', 150);
    act(() => root.querySelector<HTMLButtonElement>('.toast-content button')!.click());
    expect(open).toHaveBeenCalledOnce();
  });

  it('leaves vertical scrolling and canceled or unrelated pointers alone', () => {
    const { dismiss } = notice();
    pointer('pointerdown', 150);
    pointer('pointermove', 100, 150);
    pointer('pointerup', 0, 200);
    expect(dismiss).not.toHaveBeenCalled();
    pointer('pointerdown', 150);
    pointer('pointermove', 50);
    pointer('pointercancel', 50);
    expect(toast().style.transform).toBe('translateX(0px)');
    expect(dismiss).not.toHaveBeenCalled();
    pointer('pointerdown', 150);
    pointer('pointermove', 0, 10, 2);
    pointer('pointerup', 0, 10, 2);
    expect(dismiss).not.toHaveBeenCalled();
    pointer('pointerup', 150);
  });
});

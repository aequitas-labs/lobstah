import { Window } from 'happy-dom';
import type { GlassSnapshot } from '@lobstah/core';

/**
 * Load a spyglass page into happy-dom: /data answers with the snapshot the
 * test holds, the clock is pinned, localStorage and the URL hash are the
 * test's. The page's own script runs exactly as it ships.
 */
export interface GlassDom {
  window: Window;
  document: Window['document'];
  /** Swap the snapshot /data serves next. */
  serve(d: GlassSnapshot): void;
  /** How many times the page fetched /data. */
  fetches(): number;
  /** The poll intervals (ms) the page currently holds. */
  intervals(): number[];
  /** Hide or show the tab (visibilitychange). */
  hide(hidden: boolean): Promise<void>;
  /** Let the page's pending fetch, render, and timers settle. */
  settle(): Promise<void>;
  /** Fire the page's poll interval once and let it render. */
  poll(): Promise<void>;
  /** Navigate to a tab (#hash) and let it render. */
  go(hash: string): Promise<void>;
  /** Call one of the page's window functions (showModal, closeModal, setView…). */
  call(name: string, ...args: unknown[]): Promise<void>;
  $(sel: string): Element | null;
  $$(sel: string): Element[];
  close(): Promise<void>;
}

export interface GlassDomOptions {
  now: number;
  hash?: string;
  search?: string;
  prefs?: Record<string, unknown>;
  hidden?: boolean;
}

export async function loadGlass(page: string, snapshot: GlassSnapshot, opts: GlassDomOptions): Promise<GlassDom> {
  const window = new Window({
    url: `http://127.0.0.1:7777/${opts.search ?? ''}${opts.hash ?? ''}`,
    width: 1280,
    height: 800,
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      navigator: { userAgent: 'glass-test' },
    },
  } as ConstructorParameters<typeof Window>[0]);
  let current = snapshot;
  let count = 0;
  const w = window as unknown as Record<string, unknown> & { Date: DateConstructor; setInterval: unknown };
  w.fetch = async () => {
    count++;
    const body = JSON.parse(JSON.stringify(current));
    return { json: async () => body };
  };
  // The page probes one sprite with `new Image()`. Resolve it immediately in
  // the DOM shim; there is no HTTP server for /lob-sprite.png in these tests.
  // This keeps image loading deterministic on slow Windows runners.
  w.Image = class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  };
  // Pin the page's clock: ages and staleness are computed from Date.now().
  w.Date.now = () => opts.now;
  // Polls run when the test says so, never on a real interval; the harness
  // only records which intervals the page holds.
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  w.setInterval = (fn: () => void, ms: number) => {
    intervals.set(nextId, { fn, ms });
    return nextId++;
  };
  w.clearInterval = (id: number) => {
    intervals.delete(id);
  };
  if (opts.hidden) Object.defineProperty(window.document, 'hidden', { value: true, configurable: true });
  if (opts.prefs) window.localStorage.setItem('spyglass', JSON.stringify(opts.prefs));
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await window.happyDOM.waitUntilComplete();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  window.document.write(page);
  await settle();
  const call = async (name: string, ...args: unknown[]) => {
    (w[name] as (...a: unknown[]) => unknown)(...args);
    await settle();
  };
  return {
    window,
    document: window.document,
    serve: (d) => {
      current = d;
    },
    fetches: () => count,
    intervals: () => [...intervals.values()].map((i) => i.ms),
    hide: async (hidden: boolean) => {
      Object.defineProperty(window.document, 'hidden', { value: hidden, configurable: true });
      window.document.dispatchEvent(new window.Event('visibilitychange'));
      await settle();
    },
    settle,
    poll: async () => {
      // Fire the page's own poll interval, as the 2s timer would.
      if (!intervals.size) throw new Error('the page holds no poll interval');
      for (const { fn } of intervals.values()) fn();
      await settle();
    },
    go: async (hash) => {
      window.location.hash = hash;
      await settle();
    },
    call,
    $: (sel) => window.document.querySelector(sel) as unknown as Element | null,
    $$: (sel) => [...window.document.querySelectorAll(sel)] as unknown as Element[],
    close: async () => {
      await window.happyDOM.abort();
      await window.happyDOM.close();
    },
  };
}

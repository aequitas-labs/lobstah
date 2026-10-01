import { Window } from 'happy-dom';
import type { GlassFullSnapshot, GlassOlderKind } from '@lobstah/core';
import { olderPage, pollBody } from '../src/glass-poll.js';

/**
 * Load a spyglass page into happy-dom: /data answers with the snapshot the
 * test holds, slimmed as the server slims it (glass-poll.ts), with its ETag
 * and beats; /data/dispatch/<id> and /data/older answer from the same
 * snapshot. The clock is pinned, localStorage and the URL hash are the
 * test's. The page's own script runs exactly as it ships.
 */
export interface GlassDom {
  window: Window;
  document: Window['document'];
  /** Swap the snapshot /data serves next. */
  serve(d: GlassFullSnapshot): void;
  /** How many times the page fetched /data. */
  fetches(): number;
  /** How many of those /data fetches answered 304. */
  notModified(): number;
  /** The /data/dispatch/ and /data/older URLs the page fetched, in order. */
  dataFetches(): string[];
  /** The /report/ URLs the page fetched, in order. */
  reportFetches(): string[];
  /** URLs the page opened with window.open, with target and features. */
  opened(): Array<[string, string | undefined, string | undefined]>;
  /** URLs the page navigated to with location.replace. */
  replaced(): string[];
  /** The POSTs the page made, in order, other than its presence calls. */
  posts(): Array<{ url: string; headers: Record<string, string>; body: string }>;
  /** The page's presence calls (`/api/presence?page=…&vis=…`), in order. */
  presence(): string[];
  /** Queue a show the page's next presence call receives, as the server hands one over. */
  queueShow(show: { id: string; hash: string }): void;
  /** URLs the page navigated to with location.assign. */
  assigned(): string[];
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
  /** Simulate the window scroll position; happy-dom has no layout engine. */
  setScroll(y: number): void;
  /** Calls made by the page to scrollTo, for distinguishing entry from polls. */
  scrolls(): number[];
  /** Call one of the page's window functions (showModal, closeModal, setView…). */
  call(name: string, ...args: unknown[]): Promise<void>;
  $(sel: string): Element | null;
  $$(sel: string): Element[];
  close(): Promise<void>;
}

export interface GlassDomOptions {
  now: number;
  /** The page path, e.g. `/report/<key>`; the default is `/`. */
  path?: string;
  hash?: string;
  search?: string;
  prefs?: Record<string, unknown>;
  hidden?: boolean;
  initialScroll?: number;
  /** Other URLs the page fetches (a report's markdown), by path; any other /report/ path is a 404. */
  files?: Record<string, string>;
  /** Serve /data whole, without an ETag, as the server did before it slimmed the poll: the legacy page reads whole dispatches. */
  whole?: boolean;
  /** Answers a POST the page makes (an answer to a decision); the default is a 404. */
  post?: (url: string, init: { headers: Record<string, string>; body: string }) => { status: number; body: unknown };
}

export async function loadGlass(page: string, snapshot: GlassFullSnapshot, opts: GlassDomOptions): Promise<GlassDom> {
  const window = new Window({
    url: `http://127.0.0.1:7777${opts.path ?? '/'}${opts.search ?? ''}${opts.hash ?? ''}`,
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
  let unchanged = 0;
  const dataFetched: string[] = [];
  const w = window as unknown as Record<string, unknown> & { Date: DateConstructor; setInterval: unknown };
  let scrollY = opts.initialScroll ?? 0;
  const scrolls: number[] = [];
  Object.defineProperty(window, 'scrollY', { get: () => scrollY, configurable: true });
  w.scrollTo = (_x: number, y: number) => {
    scrollY = y;
    scrolls.push(y);
  };
  const fetched: string[] = [];
  const posted: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const presenceCalls: string[] = [];
  let queuedShow: { id: string; hash: string } | null = null;
  w.fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    if (init?.method === 'POST' && typeof url === 'string' && url.startsWith('/api/presence?')) {
      presenceCalls.push(url);
      const show = queuedShow;
      queuedShow = null;
      return { ok: true, status: 200, json: async () => ({ ok: true, show }) };
    }
    if (init?.method === 'POST') {
      const req = { url, headers: init.headers ?? {}, body: init.body ?? '' };
      posted.push(req);
      const res = opts.post ? opts.post(url, req) : { status: 404, body: { reason: 'not found' } };
      return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.body };
    }
    if (typeof url === 'string' && url.startsWith('/report/')) {
      fetched.push(url);
      const file = opts.files?.[url];
      return {
        ok: file !== undefined,
        status: file !== undefined ? 200 : 404,
        text: async () => file ?? 'not found',
        json: async () => JSON.parse(file ?? 'null'),
      };
    }
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => JSON.parse(JSON.stringify(body)),
    });
    if (typeof url === 'string' && url.startsWith('/data/dispatch/')) {
      dataFetched.push(url);
      const id = decodeURIComponent(url.slice('/data/dispatch/'.length));
      const x = current.dispatches.find((d) => d.id === id);
      return x ? json(200, x) : json(404, { error: 'not found' });
    }
    if (typeof url === 'string' && url.startsWith('/data/older?')) {
      dataFetched.push(url);
      const q = new URLSearchParams(url.slice(url.indexOf('?') + 1));
      return json(200, olderPage(current, q.get('kind') as GlassOlderKind, Number(q.get('offset')), Number(q.get('limit')), opts.now));
    }
    count++;
    if (opts.whole) return json(200, current);
    const p = pollBody(current, opts.now);
    const headers = { etag: `W/"${p.hash}"`, 'x-lobstah-beats': encodeURIComponent(JSON.stringify(p.beats)) };
    if (init?.headers?.['if-none-match'] === headers.etag) {
      unchanged++;
      return json(304, null, headers);
    }
    return json(200, JSON.parse(p.body), headers);
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
  // New tabs and navigations are recorded, never followed. happy-dom follows
  // an in-page link through window.open(url, '_self'): that one passes through.
  const opened: Array<[string, string | undefined, string | undefined]> = [];
  const open = (w.open as (...a: unknown[]) => unknown).bind(window);
  w.open = (url: string, target?: string, features?: string) => {
    if (target !== '_blank') return open(url, target, features);
    opened.push([url, target, features]);
    return null;
  };
  const replaced: string[] = [];
  Object.defineProperty(window.location, 'replace', { value: (url: string) => void replaced.push(url), configurable: true });
  const assigned: string[] = [];
  Object.defineProperty(window.location, 'assign', { value: (url: string) => void assigned.push(url), configurable: true });
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
    notModified: () => unchanged,
    dataFetches: () => [...dataFetched],
    reportFetches: () => [...fetched],
    opened: () => [...opened],
    replaced: () => [...replaced],
    posts: () => [...posted],
    presence: () => [...presenceCalls],
    queueShow: (show) => {
      queuedShow = show;
    },
    assigned: () => [...assigned],
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
    setScroll: (y) => {
      scrollY = y;
    },
    scrolls: () => [...scrolls],
    call,
    $: (sel) => window.document.querySelector(sel) as unknown as Element | null,
    $$: (sel) => [...window.document.querySelectorAll(sel)] as unknown as Element[],
    close: async () => {
      await window.happyDOM.abort();
      await window.happyDOM.close();
    },
  };
}

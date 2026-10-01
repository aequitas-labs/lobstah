import { reportFromHash, reportPageUrl, validShowHash } from '../../src/glass-diff.js';

/**
 * Presence: this page tells the glass server it is open, so the desktop pet
 * can show an item here instead of opening a new tab (glass-presence.ts).
 * The glass page reports with every 2 s poll (poll.ts); a report's page on
 * its own 2 s timer. While hidden, either sends a heartbeat every 30 s. The
 * server reads the user agent from the request. A show queued for this page
 * comes back in the answer; each show id applies once.
 */

export const HIDDEN_HEARTBEAT_MS = 30_000;
const PAGE_KEY = 'lobstah-glass-page';
const SHOWN_KEY = 'lobstah-glass-shown';
const SHOWN_MAX = 20;

/** The page id survives this tab's navigations (a report's page and back) in sessionStorage. */
function newPageId(): string {
  try {
    const known = sessionStorage.getItem(PAGE_KEY);
    if (known && /^[A-Za-z0-9_-]{8,64}$/.test(known)) return known;
  } catch {
    // no sessionStorage: a fresh id per load
  }
  let id = '';
  try {
    id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    while (id.length < 24) id += Math.random().toString(36).slice(2);
    id = id.slice(0, 24);
  }
  try {
    sessionStorage.setItem(PAGE_KEY, id);
  } catch {
    // kept in memory only
  }
  return id;
}

let pageId: string | null = null;
const id = (): string => (pageId ??= newPageId());

let shownInMemory: string[] = [];
function shown(): string[] {
  try {
    const list = JSON.parse(sessionStorage.getItem(SHOWN_KEY) ?? '[]') as unknown;
    if (Array.isArray(list)) return list.filter((x): x is string => typeof x === 'string');
  } catch {
    // fall back to memory
  }
  return shownInMemory;
}
function remember(showId: string): void {
  shownInMemory = [...shown(), showId].slice(-SHOWN_MAX);
  try {
    sessionStorage.setItem(SHOWN_KEY, JSON.stringify(shownInMemory));
  } catch {
    // memory holds it
  }
}

/**
 * Apply a show the server handed over: move this page to its hash, once per
 * show id. Returns true when it applied. The hash is checked as
 * `location.hash` is read; anything else is ignored.
 */
export function applyShow(show: unknown): boolean {
  if (!show || typeof show !== 'object') return false;
  const { id: showId, hash } = show as { id?: unknown; hash?: unknown };
  if (typeof showId !== 'string' || !showId || !validShowHash(hash)) return false;
  if (shown().includes(showId)) return false;
  remember(showId);
  if (hash === '') return true;
  const report = reportFromHash(hash);
  if (report !== null) {
    if (location.pathname !== reportPageUrl(report)) location.assign(reportPageUrl(report));
  } else if (location.pathname !== '/') {
    location.assign(`/${hash}`);
  } else if (location.hash !== hash) {
    location.hash = hash;
  }
  return true;
}

let inflight = false;

/** Tell the server this page is open, and apply any show it holds for us. */
export async function sendPresence(): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const vis = document.hidden ? 'hidden' : 'visible';
    const r = await fetch(`/api/presence?page=${id()}&vis=${vis}`, { method: 'POST', cache: 'no-store' });
    if (!r.ok) return;
    applyShow(((await r.json()) as { show?: unknown } | null)?.show);
  } catch {
    // the next poll or heartbeat tries again
  } finally {
    inflight = false;
  }
}

/**
 * Report presence now and on visibility changes, heartbeat every 30 s while
 * hidden, and say goodbye on pagehide. `visibleEveryMs` adds a timer while
 * visible, for a page with no poll of its own.
 */
export function startPresence(visibleEveryMs?: number): void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let timerMs = 0;
  const sync = () => {
    const want = document.hidden ? HIDDEN_HEARTBEAT_MS : (visibleEveryMs ?? 0);
    if (want === timerMs) return;
    if (timer) clearInterval(timer);
    timer = want ? setInterval(() => void sendPresence(), want) : null;
    timerMs = want;
  };
  document.addEventListener('visibilitychange', () => {
    sync();
    void sendPresence();
  });
  window.addEventListener('pagehide', () => {
    try {
      navigator.sendBeacon?.(`/api/presence?page=${id()}&vis=gone`);
    } catch {
      // the page ages out instead
    }
  });
  sync();
  void sendPresence();
}

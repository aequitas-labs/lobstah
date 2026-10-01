import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lobstahHome } from '@lobstah/core';
import { validShowHash } from './glass-diff.js';

export { validShowHash };

/**
 * Which glass pages are open, and where: the hand-off point that lets the
 * desktop pet show an item in a glass someone already has open instead of
 * opening a new tab.
 *
 * Each page reports itself with its polls (`POST /api/presence`): a page id,
 * whether it is visible, and (from the request) its user agent. A hidden page
 * sends a slow heartbeat. The local-only `POST /api/show` queues a hash for
 * the page most likely in front of the person; that page sets `location.hash`
 * on its next presence call. The pet then brings the page's app forward.
 */

/**
 * A page counts as open this long after it was last seen. A hidden page
 * heartbeats every 30 s, and Chrome runs a page hidden for 5 minutes only
 * once a minute; three minutes covers both.
 */
export const PRESENCE_RECENT_MS = 180_000;
/** A visible page polls every 2 s: one seen this recently is on screen. */
export const PRESENCE_VISIBLE_MS = 10_000;
/** Page ids are the page's own random token. */
export const PAGE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_PAGES = 64;
const UA_MAX = 512;

/** The app a glass page runs in, as far as its user agent tells. */
export type GlassHost = 'claude' | 'chrome' | 'edge' | 'firefox' | 'safari' | 'electron' | 'other';

/**
 * The app behind a user agent. The Claude desktop app is Electron: its
 * user agent carries `Claude/<version>`, and its Browser pane drops only the
 * `Electron/<version>` token. Arc and Brave send Chrome's user agent and read
 * as `chrome`. Any other Electron app is `electron`.
 */
export function glassHost(userAgent: string): GlassHost {
  if (/\bClaude\/\d/.test(userAgent)) return 'claude';
  if (/\bElectron\/\d/.test(userAgent)) return 'electron';
  if (/\bEdg\/\d/.test(userAgent)) return 'edge';
  if (/\bFirefox\/\d/.test(userAgent)) return 'firefox';
  if (/\b(?:Chrome|Chromium|CriOS)\/\d/.test(userAgent)) return 'chrome';
  if (/\bVersion\/\d.*\bSafari\/\d/.test(userAgent)) return 'safari';
  return 'other';
}

export interface GlassPage {
  id: string;
  visible: boolean;
  userAgent: string;
  host: GlassHost;
  seenAt: number;
}

/** A queued show, as the page receives it: it applies each id once. */
export interface GlassShow {
  id: string;
  hash: string;
}

/** What `POST /api/show` answers, and `lobstah glass show --json` prints. */
export interface ShowResult {
  /** A page was seen recently and the show waits for it. */
  delivered: boolean;
  id?: string;
  page?: string;
  host?: GlassHost;
  visible?: boolean;
  seenAgoMs?: number;
  userAgent?: string;
}

export class GlassPresence {
  private readonly pages = new Map<string, GlassPage>();
  private readonly shows = new Map<string, GlassShow>();

  constructor(private readonly clock: () => number = Date.now) {}

  /**
   * A page's poll or heartbeat. Returns the show queued for it, once: the
   * show leaves the queue as it is handed over.
   */
  seen(id: string, visible: boolean, userAgent: string): GlassShow | null {
    const now = this.clock();
    this.prune(now);
    const ua = userAgent.slice(0, UA_MAX);
    this.pages.delete(id);
    this.pages.set(id, { id, visible, userAgent: ua, host: glassHost(ua), seenAt: now });
    while (this.pages.size > MAX_PAGES) this.pages.delete(this.pages.keys().next().value!);
    const show = this.shows.get(id);
    if (!show) return null;
    this.shows.delete(id);
    return show;
  }

  /** A page that closed (its pagehide beacon). */
  gone(id: string): void {
    this.pages.delete(id);
    this.shows.delete(id);
  }

  /**
   * The page a show goes to: the most recently seen page that is on screen,
   * else the most recently seen page. Undefined when none was seen recently.
   */
  target(): GlassPage | undefined {
    const now = this.clock();
    this.prune(now);
    const recent = [...this.pages.values()].sort((a, b) => b.seenAt - a.seenAt);
    return recent.find((p) => p.visible && now - p.seenAt <= PRESENCE_VISIBLE_MS) ?? recent[0];
  }

  /** Queue `hash` for the page in front. One show waits per page; a newer one replaces it. */
  show(hash: string): ShowResult {
    const page = this.target();
    if (!page) return { delivered: false };
    const now = this.clock();
    const id = randomBytes(9).toString('base64url');
    this.shows.set(page.id, { id, hash });
    return {
      delivered: true,
      id,
      page: page.id,
      host: page.host,
      visible: page.visible && now - page.seenAt <= PRESENCE_VISIBLE_MS,
      seenAgoMs: now - page.seenAt,
      userAgent: page.userAgent,
    };
  }

  private prune(now: number): void {
    for (const [id, p] of this.pages) if (now - p.seenAt > PRESENCE_RECENT_MS) this.pages.delete(id);
    // A show waits only as long as its page counts as open.
    for (const id of this.shows.keys()) if (!this.pages.has(id)) this.shows.delete(id);
  }
}

// MARK: - the show secret

/** The secret a local `POST /api/show` carries: user-only (0600), under the lobstah home. */
export const showSecretPath = (): string => path.join(lobstahHome(), 'state', 'glass-show.secret');
const SECRET_RE = /^[0-9a-f]{64}$/;

/** The secret when the file holds one and, off Windows, only its owner can read it. */
export function readShowSecret(): string | undefined {
  try {
    const file = showSecretPath();
    if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o077) !== 0) return undefined;
    const secret = fs.readFileSync(file, 'utf8').trim();
    return SECRET_RE.test(secret) ? secret : undefined;
  } catch {
    return undefined;
  }
}

/** The secret, created user-only on first use. The CLI creates it; the glass only reads it. */
export function ensureShowSecret(): string {
  const existing = readShowSecret();
  if (existing) return existing;
  const file = showSecretPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const secret = randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, secret, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // Another caller created it first, or it is unreadable: keep a good one, else replace it.
    const raced = readShowSecret();
    if (raced) return raced;
    fs.writeFileSync(file, secret, { mode: 0o600 });
  }
  fs.chmodSync(file, 0o600);
  return secret;
}

/** True when `supplied` is the show secret. */
export function showSecretMatches(supplied: unknown): boolean {
  const secret = readShowSecret();
  if (!secret || typeof supplied !== 'string' || supplied.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(secret));
}

// MARK: - the client

/**
 * Ask the glass on `port` to show `hash` in an open page. Rejects when the
 * glass does not answer, or refuses the request.
 */
export function requestShow(port: number, hash: string, timeoutMs = 2000): Promise<ShowResult> {
  const secret = ensureShowSecret();
  const body = JSON.stringify({ hash });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/show',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-lobstah-show-secret': secret },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let parsed: (ShowResult & { reason?: string }) | undefined;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ShowResult & { reason?: string };
          } catch {
            parsed = undefined;
          }
          if (res.statusCode === 200 && parsed && typeof parsed.delivered === 'boolean') return resolve(parsed);
          reject(new Error(`the glass on port ${port} refused the show (${res.statusCode}${parsed?.reason ? `: ${parsed.reason}` : ''})`));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`the glass on port ${port} did not answer within ${timeoutMs} ms`)));
    req.on('error', (e) => reject((e as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? new Error(`no glass is running on port ${port}`) : e));
    req.end(body);
  });
}

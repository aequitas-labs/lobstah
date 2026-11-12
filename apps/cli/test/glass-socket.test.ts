import { gzipSync } from 'node:zlib';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { GlassFullSnapshot, GlassSnapshot } from '@lobstah/core';
import { GLASS_CSS, GLASS_SCRIPT } from '../../../services/wharf/src/glass-page.generated.js';
import { pollBody } from '../src/glass-poll.js';
import { encodeFrame } from '../../../packages/core/src/wharf-socket.js';
import { acceptanceFleet, NOW } from './fixtures/glass-snapshots.js';
import { snapshot as wharfAccount } from './fixtures/wharf-glass.js';

/**
 * The hosted glass on its socket (lobstah.2): a boat's pushed snapshot shows
 * with no request, the page polls on no timer while the socket is open,
 * relayed reads go out and come back on the socket, and a reconnect resumes
 * from the cursor and reads what changed during the drop.
 */

const NORTH = { boat: 'boat-north', name: 'north' };

/** The north boat's glass, with its one decision titled `title`. */
function northFleet(title: string): GlassSnapshot {
  const d: GlassFullSnapshot = acceptanceFleet();
  d.decisions = [{ key: 'decision:n0000000', dispatch: d.dispatches[0]!.id, lane: 'work', title, detail: '', options: ['main'], attachments: [], askedBy: 'helm', askedAt: new Date(NOW - 60_000).toISOString(), stateHash: title }];
  d.attention.push({ kind: 'decision', key: 'decision:n0000000', stateHash: title, id: d.dispatches[0]!.id, lane: 'work', verb: 'decision', ageSecs: 60, at: new Date(NOW - 60_000).toISOString(), standingSince: new Date(NOW - 60_000).toISOString(), note: title });
  d.viewer = { onMachine: false, windowFocus: false, machine: '', device: 'desktop' };
  const { focusToken: _token, ...body } = JSON.parse(pollBody(d, NOW).body) as GlassSnapshot;
  return body as GlassSnapshot;
}

/** A socket the test drives: it opens, delivers messages and records what the page sends. */
class FakeSocket {
  readyState = 0;
  binaryType = 'blob';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string, public protocol?: string) {
    FakeSocket.made.push(this);
  }
  static made: FakeSocket[] = [];
  send(data: string) {
    this.sent.push(String(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(data: unknown) {
    this.onmessage?.({ data });
  }
}

interface Page {
  doc: Document;
  settle(): Promise<void>;
  /** Every request the page made to the wharf, in order. */
  requests: string[];
  /** Run every timer the page holds now, once. */
  tick(): Promise<void>;
}

const windows: Window[] = [];
afterEach(async () => {
  await Promise.all(windows.map((w) => w.happyDOM.close()));
  windows.length = 0;
  FakeSocket.made.length = 0;
});

async function hosted(hash = '#deck'): Promise<Page> {
  const window = new Window({
    url: 'https://glass.test/' + hash,
    width: 1280,
    height: 800,
    settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  } as ConstructorParameters<typeof Window>[0]);
  windows.push(window);
  const w = window as unknown as Record<string, unknown> & { Date: DateConstructor };
  w.Date.now = () => NOW;
  w.WebSocket = FakeSocket;
  // The page unpacks pushed gzip with the platform's streams.
  w.Blob = Blob;
  w.Response = Response;
  w.DecompressionStream = DecompressionStream;
  const timers = new Map<number, () => unknown>();
  let nextTimer = 1;
  w.setInterval = (fn: () => unknown) => (timers.set(nextTimer, fn), nextTimer++);
  w.clearInterval = (id: number) => void timers.delete(id);
  const requests: string[] = [];
  w.fetch = async (input: string) => {
    const path = String(input);
    requests.push(path);
    if (path === '/api/glass') return Response.json({ ...wharfAccount, requests: [], documents: [], workers: [] });
    if (path === '/api/glass/dispatches') return Response.json([]);
    if (path === '/api/glass/mirror' || path.startsWith('/api/glass/mirror?'))
      return Response.json({ boats: [{ ...NORTH, etag: 'n'.repeat(64), bytes: 1, at: new Date(NOW - 5_000).toISOString(), snapshot: northFleet('Which base?') }] });
    return Response.json({ error: 'not found' }, { status: 404 });
  };
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      await window.happyDOM.waitUntilComplete();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  window.document.write(`<!doctype html><html><head><style>${GLASS_CSS}</style></head><body><script>${GLASS_SCRIPT}</script></body></html>`);
  await settle();
  const tick = async () => {
    for (const fn of [...timers.values()]) fn();
    await settle();
  };
  return { doc: window.document as unknown as Document, settle, requests, tick };
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const socket = () => FakeSocket.made.at(-1)!;
const snapshotFrame = (title: string) =>
  encodeFrame({ t: 'snapshot', boat: NORTH.boat, name: NORTH.name, at: new Date(NOW).toISOString(), etag: title.padEnd(64, 'x') }, gzipSync(JSON.stringify(northFleet(title)))).buffer;

describe('the hosted glass on its socket', () => {
  it('opens lobstah.2 and resumes; a boat’s pushed snapshot shows with no request', async () => {
    const page = await hosted();
    expect(socket().protocol).toBe('lobstah.2');
    socket().open();
    await page.settle();
    expect(JSON.parse(socket().sent[0]!)).toEqual({ t: 'resume' });
    expect(text(page.doc.querySelector('#deck'))).toContain('Which base?');
    const before = page.requests.length;
    socket().deliver(snapshotFrame('Which base now?'));
    await page.settle();
    expect(text(page.doc.querySelector('#deck'))).toContain('Which base now?');
    expect(page.requests.slice(before)).toEqual([]);
  });

  it('polls on no timer while the socket is open, and polls again once it drops', async () => {
    const page = await hosted();
    socket().open();
    await page.settle();
    const before = page.requests.length;
    // A minute of timers: thirty 2 s polls, two pings.
    for (let i = 0; i < 30; i++) await page.tick();
    expect(page.requests.slice(before)).toEqual([]);
    expect(socket().sent.filter((m) => m === 'ping').length).toBeGreaterThan(0);
    socket().close();
    await page.settle();
    expect(page.requests.length).toBeGreaterThan(before);
  });

  it('relays a read on the socket and shows the boat’s answer, with no HTTP relay', async () => {
    const page = await hosted('#dispatches');
    socket().open();
    await page.settle();
    const before = page.requests.length;
    const row = page.doc.querySelector('#dispatches tr.rowhead') as unknown as HTMLElement;
    row.click();
    // Not settle(): the page holds the call's answer timer until the answer comes.
    const sentCall = () => socket().sent.map((m) => (m.startsWith('{') ? JSON.parse(m) : {})).find((m) => m.t === 'call');
    for (let i = 0; i < 200 && !sentCall(); i++) await new Promise((r) => setTimeout(r, 5));
    const call = sentCall();
    expect(call).toMatchObject({ t: 'call', boat: NORTH.boat });
    expect(call.read).toMatch(/^\/data\/dispatch\//);
    const job = northFleet('Which base?').dispatches.find((d) => call.read === `/data/dispatch/${encodeURIComponent(d.id)}`)!;
    const detail = { ...job, brief: 'Brief read from the boat over the socket', attachments: [], messageAttachments: [], log: [], inbox: [] };
    socket().deliver(encodeFrame({ t: 'answer', id: call.id, status: 200, contentType: 'application/json' }, new TextEncoder().encode(JSON.stringify(detail))).buffer);
    await page.settle();
    expect(text(page.doc.querySelector('#modalbox'))).toContain('Brief read from the boat over the socket');
    expect(page.requests.slice(before).filter((r) => r.includes('/mirror/relay'))).toEqual([]);
  });

  it('after a drop, reconnects from its cursor and reads what the wharf recorded meanwhile', async () => {
    const page = await hosted();
    const first = socket();
    first.open();
    first.deliver(JSON.stringify({ t: 'hello', protocol: 'lobstah.2', cursor: 'g.7' }));
    await page.settle();
    first.close();
    await page.settle();
    await page.tick(); // the page's reconnect timer
    const second = socket();
    expect(second).not.toBe(first);
    second.open();
    await page.settle();
    expect(JSON.parse(second.sent[0]!)).toEqual({ t: 'resume', after: 'g.7' });
    const before = page.requests.length;
    second.deliver(JSON.stringify({ t: 'event', events: [{ cursor: 'g.8', kind: 'queued', dispatchId: 'job', at: new Date(NOW).toISOString() }], cursor: 'g.8' }));
    await page.settle();
    expect(page.requests.slice(before)).toContain('/api/glass');
  });
});

import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { GlassFullSnapshot, GlassSnapshot } from '@lobstah/core';
import { GLASS_CSS, GLASS_SCRIPT } from '../../../services/wharf/src/glass-page.generated.js';
import { pollBody } from '../src/glass-poll.js';
import { mergeMirror, MIRROR_STALE_MS } from '../../../packages/glass-ui/ui/mirror-merge.js';
import { mirrorReadAllowed } from '../../../packages/core/src/backend-model.js';
import { acceptanceFleet, NOW } from './fixtures/glass-snapshots.js';
import { snapshot as wharfAccount } from './fixtures/wharf-glass.js';

/**
 * The hosted glass on several mirror boats: one fleet, with no picker. Each
 * row says its boat; each call goes to the row's boat only; an asleep boat's
 * rows are read-only; ↗ Open shows only for the boat this browser runs on.
 */

const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';
const NORTH = { boat: 'boat-north', name: 'north', port: 4949, id: 'mirror-north' };
const SOUTH = { boat: 'boat-south', name: 'south', port: 4950, id: 'mirror-south' };

/** One boat's glass: the acceptance fleet, its ids and trap made its own. */
function boatFleet(tag: 'n' | 's'): GlassFullSnapshot {
  const d = acceptanceFleet();
  const swap = (id: string) => `${tag}${id.slice(1)}`;
  d.dispatches = d.dispatches.map((x) => ({ ...x, id: swap(x.id), ...(x.followUp ? { followUp: swap(x.followUp) } : {}) }));
  d.traps = d.traps.map((t) => ({ ...t, trapId: `${tag}-${t.trapId}`, live: true, catches: t.catches.map(swap) }));
  d.attention = d.attention.map((a) => ({ ...a, id: swap(a.id), key: a.key.replace(a.id, swap(a.id)) }));
  d.decisions = [{ key: `decision:${tag}0000000`, dispatch: d.dispatches[0]!.id, lane: 'work', title: `${tag} base?`, detail: '', options: ['main', 'feature'], attachments: [], askedBy: 'helm', askedAt: new Date(NOW - 60_000).toISOString(), stateHash: tag }];
  d.attention.push({ kind: 'decision', key: `decision:${tag}0000000`, stateHash: tag, id: d.dispatches[0]!.id, lane: 'work', verb: 'decision', ageSecs: 60, at: new Date(NOW - 60_000).toISOString(), standingSince: new Date(NOW - 60_000).toISOString(), note: `${tag} base?` });
  d.reviewSetup = { enabled: true, mode: 'notify', publish: false, running: true, identity: 'reviewer', perRepo: { web: { mode: 'on-demand', publish: true, overridden: true } } };
  d.reports = [{ key: `report:work:${d.dispatches[0]!.id}`, dispatch: d.dispatches[0]!.id, lane: 'work', title: `${tag} findings`, author: `${tag}-crab`, filedAt: new Date(NOW - 60_000).toISOString(), stateHash: tag, bytes: 40, attachments: [] }];
  d.viewer = { onMachine: false, windowFocus: false, machine: '', device: 'desktop' };
  return d;
}

/** A report's markdown, as its boat's glass serves it. */
const reportMarkdown = (tag: 'n' | 's') => `# ${tag} findings\n\nThe ${tag} boat found the cause.\n`;

/** What a boat puts: its /data body, without the page token, with where its glass listens. */
const put = (tag: 'n' | 's', boat: typeof NORTH): GlassSnapshot => {
  const { focusToken: _token, ...body } = JSON.parse(pollBody(boatFleet(tag), NOW).body) as GlassSnapshot;
  return { ...body, mirror: { port: boat.port, id: boat.id } };
};

interface Hosted {
  doc: Document;
  settle: () => Promise<void>;
  relayed: Array<{ boat: string; read?: string; write?: { kind: string; payload: Record<string, unknown> } }>;
  focused: string[];
  /** Every call the page made off the wharf's own origin. */
  offOrigin: string[];
  /** Run the page's poll timer once, as its 2 s interval would. */
  tick: () => Promise<void>;
}

const windows: Window[] = [];
afterEach(async () => {
  await Promise.all(windows.map((w) => w.happyDOM.close()));
  windows.length = 0;
});

/** The hosted glass on two mirror boats; `onBoat` is the boat whose glass answers the loopback probe, if any. */
async function hosted(hash: string, opts: { onBoat?: typeof NORTH; southAt?: number; boats?: Array<[typeof NORTH, 'n' | 's']>; relay?: (call: Hosted['relayed'][number]) => Response | Promise<Response> | undefined } = {}): Promise<Hosted> {
  const window = new Window({
    url: 'https://glass.test/' + hash,
    width: 1280,
    height: 800,
    settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true, navigator: { userAgent: DESKTOP } },
  } as ConstructorParameters<typeof Window>[0]);
  windows.push(window);
  const w = window as unknown as Record<string, unknown> & { Date: DateConstructor };
  w.Date.now = () => NOW;
  w.WebSocket = class { close() {} };
  const timers: Array<() => unknown> = [];
  w.setInterval = (fn: () => unknown) => (timers.push(fn), timers.length);
  w.clearInterval = () => {};
  const relayed: Hosted['relayed'] = [];
  const focused: string[] = [];
  const offOrigin: string[] = [];
  const boats = opts.boats ?? [[NORTH, 'n'], [SOUTH, 's']];
  w.fetch = async (input: string, init: RequestInit = {}) => {
    const path = String(input);
    if (/^[a-z]+:/i.test(path)) offOrigin.push(path);
    if (path.startsWith('http://127.0.0.1:')) {
      const port = Number(new URL(path).port);
      const boat = boats.find(([b]) => b.port === port)?.[0];
      if (!opts.onBoat || boat !== opts.onBoat) throw new TypeError('Failed to fetch');
      if (path.endsWith('/api/mirror/probe')) return Response.json({ ok: true, mirror: boat.id, token: 'focus-token', windowFocus: true });
      focused.push(path.slice(path.indexOf('/api/mirror/focus/') + '/api/mirror/focus/'.length));
      return Response.json({ focused: true });
    }
    if (path === '/api/glass') return Response.json({ ...wharfAccount, requests: [], documents: [], workers: [] });
    if (path === '/api/glass/dispatches') return Response.json([]);
    if (path === '/api/glass/mirror' || path.startsWith('/api/glass/mirror?')) {
      return Response.json({ boats: boats.map(([b, tag]) => ({ boat: b.boat, name: b.name, etag: tag.repeat(64), bytes: 1, at: new Date(b === SOUTH && opts.southAt !== undefined ? opts.southAt : NOW - 5_000).toISOString(), snapshot: put(tag, b) })) });
    }
    if (path === '/api/glass/mirror/relay') {
      const call = JSON.parse(String(init.body)) as Hosted['relayed'][number];
      relayed.push(call);
      const custom = opts.relay?.(call);
      if (custom) return custom;
      if (call.read?.startsWith('/data/dispatch/')) {
        const id = decodeURIComponent(call.read.slice('/data/dispatch/'.length));
        const [, tag] = boats.find(([b]) => b.boat === call.boat)!;
        const found = boatFleet(tag).dispatches.find((d) => d.id === id);
        return found ? Response.json(found) : Response.json({ error: 'not on this boat' }, { status: 404 });
      }
      const report = call.read && /^\/report\/([^/]+)\/(meta|md)$/.exec(call.read);
      if (report) {
        const [, tag] = boats.find(([b]) => b.boat === call.boat)!;
        const found = boatFleet(tag).reports.find((r) => r.key === decodeURIComponent(report[1]!));
        if (!found) return Response.json({ error: 'not on this boat' }, { status: 404 });
        return report[2] === 'meta' ? Response.json(found) : new Response(reportMarkdown(tag), { headers: { 'Content-Type': 'text/markdown' } });
      }
      if (call.write) return Response.json({ ok: true, id: 'request-1' }, { status: 201 });
      return Response.json({ error: 'not found' }, { status: 404 });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  };
  const settle = async () => {
    for (let i = 0; i < 8; i++) {
      await window.happyDOM.waitUntilComplete();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  window.document.write(`<!doctype html><html><head><style>${GLASS_CSS}</style></head><body><script>${GLASS_SCRIPT}</script></body></html>`);
  await settle();
  const tick = async () => {
    for (const fn of timers) fn();
    await settle();
  };
  return { doc: window.document as unknown as Document, settle, relayed, focused, offOrigin, tick };
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('two mirror boats in one fleet', () => {
  it('lists both boats’ rows together on the deck and every list, each labelled with its boat, with no picker', async () => {
    const h = await hosted('#dispatches');
    const rows = Array.from(h.doc.querySelectorAll('#dispatches tr.rowhead')).map(text);
    expect(rows.some((r) => r.includes('north ·'))).toBe(true);
    expect(rows.some((r) => r.includes('south ·'))).toBe(true);
    expect(rows.filter((r) => r.startsWith('n')).length).toBe(rows.filter((r) => r.startsWith('s')).length);
    const deck = text(h.doc.querySelector('#page-deck')) || text((await hosted('#deck')).doc.querySelector('#page-deck'));
    expect(deck).toContain('n base?');
    expect(deck).toContain('s base?');
    expect(h.doc.querySelector('select[aria-label*="boat" i]')).toBeNull();
    // The header names each boat and how fresh its snapshot is.
    const chips = Array.from(h.doc.querySelectorAll('.chip')).map(text);
    expect(chips.some((c) => c.startsWith('north · mirrored'))).toBe(true);
    expect(chips.some((c) => c.startsWith('south · mirrored'))).toBe(true);
  });

  it("shows review settings and repo scope as text, and only this device's settings behind the gear", async () => {
    const h = await hosted('#reviews', { boats: [[NORTH, 'n']] });
    const controls = () => h.doc.querySelector('#reviews .rv-controls');
    expect(text(controls())).toContain('Review mode · default: Notify');
    expect(text(controls())).toContain('Publish: off');
    expect(controls()?.querySelector('select, input, button')).toBeNull();
    const repo = h.doc.querySelector('#f-repo') as HTMLSelectElement;
    repo.value = 'web';
    repo.dispatchEvent(new h.doc.defaultView!.Event('change', { bubbles: true }));
    await h.settle();
    expect(text(controls())).toContain('Review mode · web: On-demand');
    expect(text(controls())).toContain('Publish: on');
    (h.doc.querySelector('#gearbtn') as HTMLElement).click();
    await h.settle();
    // Device settings link to the boats' Configuration without showing helm chat here.
    expect(h.doc.querySelector('.settings-dialog')).not.toBeNull();
    expect(h.doc.querySelector('[data-helm-chat]')).toBeNull();
    expect(text(h.doc.querySelector('.settings-config a'))).toBe('Configuration');
    const choose = async (setting: string, value: string) => {
      const button = Array.from(h.doc.querySelectorAll(`.settings [aria-label="${setting}"] button`)).find(button => text(button) === value)!;
      (button as HTMLElement).click();
      await h.settle();
    };
    await choose('view', 'cards');
    await choose('lobs', 'off');
    expect(JSON.parse(h.doc.defaultView!.localStorage.getItem('spyglass')!)).toMatchObject({ view: 'cards', lobs: false });
    expect(h.doc.querySelectorAll('#lobs .lob')).toHaveLength(0);
    expect(h.doc.querySelector('.settings')?.querySelector('input, select, textarea')).toBeNull();
    expect(h.relayed.filter(c => c.write?.kind === 'review-mode' || c.write?.kind === 'helm-chat')).toEqual([]);
  });

  it("reads an open job's detail from its boat once while the boat's snapshot is unchanged, not on every poll", async () => {
    const h = await hosted('#dispatches');
    const southRow = Array.from(h.doc.querySelectorAll('#dispatches tr.rowhead')).find((r) => text(r).startsWith('s'))!;
    (southRow as unknown as HTMLElement).click();
    await h.settle();
    for (let i = 0; i < 5; i++) await h.tick();
    expect(h.relayed.filter((c) => c.read?.startsWith('/data/dispatch/'))).toHaveLength(1);
  });

  it('never stacks detail reads of a slow boat, and says it is busy instead of showing a raw 429', async () => {
    let answer: (r: Response) => void = () => {};
    let busy = false;
    const h = await hosted('#dispatches', {
      relay: (call) => {
        if (!call.read?.startsWith('/data/dispatch/')) return undefined;
        if (busy) return Response.json({ error: 'mirror rate limit' }, { status: 429 });
        return new Promise<Response>((resolve) => (answer = resolve));
      },
    });
    const southRow = Array.from(h.doc.querySelectorAll('#dispatches tr.rowhead')).find((r) => text(r).startsWith('s'))!;
    (southRow as unknown as HTMLElement).click();
    await h.settle();
    // The boat has not answered: polls come and go, and no second read is sent.
    for (let i = 0; i < 5; i++) await h.tick();
    expect(h.relayed.filter((c) => c.read?.startsWith('/data/dispatch/'))).toHaveLength(1);
    busy = true;
    answer(Response.json({ error: 'mirror rate limit' }, { status: 429 }));
    await h.settle();
    const modal = text(h.doc.querySelector('.modal, #overlay'));
    expect(modal).toContain('Busy right now. Retrying…');
    expect(modal).not.toContain('429');
  });

  it('opens a row’s detail from its own boat, and sends a card’s answer to its own boat only', async () => {
    const h = await hosted('#dispatches');
    const southRow = Array.from(h.doc.querySelectorAll('#dispatches tr.rowhead')).find((r) => text(r).startsWith('s'))!;
    (southRow as unknown as HTMLElement).click();
    await h.settle();
    expect(h.relayed.filter((c) => c.read?.startsWith('/data/dispatch/')).map((c) => c.boat)).toEqual([SOUTH.boat]);
    const d = await hosted('#decision/' + encodeURIComponent('decision:n0000000'));
    const option = Array.from(d.doc.querySelectorAll('.dmodal .dopt')).find((b) => text(b).includes('main'))!;
    (option as unknown as HTMLElement).click();
    await d.settle();
    (d.doc.querySelector('.dmodal .dsend') as unknown as HTMLElement).click();
    await d.settle();
    const answers = d.relayed.filter((c) => c.write?.kind === 'decision-answer');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ boat: NORTH.boat, write: { payload: { key: 'decision:n0000000', option: 'main' } } });
  });

  it('shows an asleep boat’s age in the header and its rows read-only', async () => {
    const h = await hosted('#dispatches', { southAt: NOW - MIRROR_STALE_MS - 60_000 });
    const south = Array.from(h.doc.querySelectorAll('.chip')).map(text).find((c) => c.startsWith('south'))!;
    expect(south).toMatch(/south · mirrored 3m ago · asleep/);
    const rows = Array.from(h.doc.querySelectorAll('#dispatches tr.rowhead')).map(text);
    expect(rows.some((r) => r.includes('south (asleep) ·'))).toBe(true);
    // On a phone, the helm pill's dot turns amber while a boat is asleep.
    expect(Array.from(h.doc.querySelectorAll('.helmpill .hdot')).map((dot) => dot.className)).toEqual(['hdot warn', 'hdot warn']);
    const awake = await hosted('#dispatches');
    expect(Array.from(awake.doc.querySelectorAll('.helmpill .hdot')).map((dot) => dot.className)).toEqual(['hdot ok', 'hdot ok']);
    // Its card refuses an answer before anything is sent.
    const d = await hosted('#decision/' + encodeURIComponent('decision:s0000000'), { southAt: NOW - MIRROR_STALE_MS - 60_000 });
    (Array.from(d.doc.querySelectorAll('.dmodal .dopt'))[0] as unknown as HTMLElement).click();
    await d.settle();
    (d.doc.querySelector('.dmodal .dsend') as unknown as HTMLElement)?.click();
    await d.settle();
    expect(d.relayed.filter((c) => c.write)).toEqual([]);
    expect(text(d.doc.querySelector('.dmodal'))).toContain('asleep');
  });
});

describe('a report on the hosted glass', () => {
  it('opens a boat’s report on its own page, read from that boat through the relay', async () => {
    const key = boatFleet('s').reports[0]!.key;
    const h = await hosted('report/' + encodeURIComponent(key));
    expect(text(h.doc.querySelector('main.reportview h1'))).toBe('s findings');
    expect(text(h.doc.querySelector('main.reportview'))).toContain('The s boat found the cause.');
    const reads = h.relayed.filter((c) => c.read).map((c) => ({ boat: c.boat, read: c.read }));
    expect(reads).toEqual([
      { boat: SOUTH.boat, read: `/report/${encodeURIComponent(key)}/meta` },
      { boat: SOUTH.boat, read: `/report/${encodeURIComponent(key)}/md` },
    ]);
    // The boat relays only the reads it lists: these are two of them.
    for (const { read } of reads) expect(mirrorReadAllowed(read!), read).toBe(true);
    // Showing it acks it on its own boat, as the local glass does.
    expect(h.relayed.filter((c) => c.write).map((c) => ({ boat: c.boat, write: c.write }))).toEqual([
      { boat: SOUTH.boat, write: { kind: 'report-viewed', payload: { key } } },
    ]);
  });

  it('says so when no boat lists the report', async () => {
    const h = await hosted('report/' + encodeURIComponent('report:work:gone'));
    expect(text(h.doc.querySelector('main.reportview'))).toContain('report not found');
    expect(h.relayed).toEqual([]);
  });
});

describe('↗ Open from the hosted glass', () => {
  it('shows only on the trap rows of the boat this browser runs on, and asks that boat’s glass, never the wharf', async () => {
    const h = await hosted('#traps', { onBoat: NORTH });
    const rows = Array.from(h.doc.querySelectorAll('#page-traps tr.rowhead, #page-traps .card'));
    const open = rows.filter((r) => r.querySelector('button.open'));
    expect(open.length).toBeGreaterThan(0);
    for (const r of open) expect(text(r)).toContain('north');
    expect(rows.some((r) => text(r).includes('south') && !r.querySelector('button.open') && text(r).includes('Running on south'))).toBe(true);
    (open[0]!.querySelector('button.open') as unknown as HTMLElement).click();
    await h.settle();
    expect(h.focused).toHaveLength(1);
    expect(h.focused[0]).toMatch(/^n-/);
    // The probe and focus are the page's only calls off the wharf, each to a boat's glass port on
    // 127.0.0.1: the one loopback source the wharf's connect-src allows (services/wharf/src/glass-page.ts).
    expect(h.offOrigin.length).toBeGreaterThan(0);
    for (const url of h.offOrigin) expect(url, url).toMatch(/^http:\/\/127\.0\.0\.1:(4949|4950)\/api\/mirror\/(probe|focus\/[^/]+)$/);
    expect(h.relayed.filter((c) => c.write?.kind === 'focus')).toEqual([]);
  });

  it('shows no ↗ Open where no boat’s glass answers, only where each trap runs', async () => {
    const h = await hosted('#traps');
    expect(h.doc.querySelector('#page-traps button.open')).toBeNull();
    const page = text(h.doc.querySelector('#page-traps'));
    expect(page).toContain('Running on north');
    expect(page).toContain('Running on south');
  });
});

describe('an account with no mirror boat', () => {
  it('shows the tabs the wharf has always shown', async () => {
    const h = await hosted('#deck', { boats: [] });
    const tabs = Array.from(h.doc.querySelectorAll('#tabs a')).map((a) => a.getAttribute('data-tab'));
    expect(tabs).toEqual(['deck', 'dispatches', 'traps', 'boats', 'reviews', 'reports']);
  });
});

describe('mergeMirror', () => {
  const viewer = { onMachine: false, windowFocus: false, machine: '', device: 'desktop' as const };
  const sources = () => [
    { boat: NORTH.boat, name: 'north', at: new Date(NOW).toISOString(), etag: 'n', snapshot: put('n', NORTH) },
    { boat: SOUTH.boat, name: 'south', at: new Date(NOW).toISOString(), etag: 's', snapshot: put('s', SOUTH) },
  ];

  it('leaves one boat’s snapshot as its glass shows it', () => {
    const [north] = sources();
    const { snapshot } = mergeMirror([north!], NOW, viewer);
    const { mirror: _mirror, ...expected } = north!.snapshot;
    expect(snapshot).toEqual({ ...expected, viewer: { ...viewer, machine: 'north' } });
  });

  it('routes each row’s key to its boat, takes labels back off, and refuses a call naming two boats', () => {
    const { router, snapshot } = mergeMirror(sources(), NOW, viewer);
    const southRow = snapshot.dispatches.find((d) => d.id.startsWith('s'))!;
    expect(southRow.repo?.startsWith('south · ')).toBe(true);
    expect(router.resolve(southRow.id)).toEqual({ boat: SOUTH.boat, value: southRow.id });
    expect(router.resolve({ repo: southRow.repo })).toEqual({ boat: SOUTH.boat, value: { repo: southRow.repo!.slice('south · '.length) } });
    const northRow = snapshot.dispatches.find((d) => d.id.startsWith('n'))!;
    expect(router.resolve({ a: northRow.id, b: southRow.id }).ambiguous).toBe(true);
    expect(router.resolve({ nothing: 'here' }).boat).toBeUndefined();
  });

  it("keeps each boat's done-today todos marked done, so the hosted glass counts open ones only", () => {
    const todo = (id: number, done: boolean) => ({ grounds: 'home', groundsKey: 'fleet', id, text: `Task ${id}`, createdAt: new Date(NOW).toISOString(), done, stale: false, overdue: false });
    const withTodos = sources().map((s, i) => ({ ...s, snapshot: { ...s.snapshot, todos: [todo(1 + i * 10, false), todo(2 + i * 10, false), todo(3 + i * 10, true), todo(4 + i * 10, true), todo(5 + i * 10, true)] } }));
    const { snapshot } = mergeMirror(withTodos, NOW, viewer);
    expect(snapshot.todos!.filter((t) => !t.done)).toHaveLength(4);
    expect(snapshot.todos!.filter((t) => t.done)).toHaveLength(6);
  });

  it("lists both boats' recent runs, each labelled with its boat, and never their finished runs as decisions", () => {
    const ran = (key: string) => ({ key, title: `Run ${key.slice(-1)}`, state: 'succeeded' as const, exitCode: 0, finishedAt: new Date(NOW - 600_000).toISOString(), repo: 'lobstah' });
    const withRuns = sources().map((s, i) => ({ ...s, snapshot: { ...s.snapshot, recentRuns: [ran(`decision:0000000${i}`)] } }));
    const { snapshot, router } = mergeMirror(withRuns, NOW, viewer);
    expect(snapshot.recentRuns?.map((r) => r.repo)).toEqual(['north · lobstah', 'south · lobstah']);
    expect(router.resolve('decision:00000001').boat).toBe(SOUTH.boat);
    expect(snapshot.decisions?.some((d) => d.key === 'decision:00000000' || d.key === 'decision:00000001')).toBe(false);
  });

  it('adds up counts and keeps a PR both boats watch once', () => {
    const { snapshot } = mergeMirror(sources(), NOW, viewer);
    const one = put('n', NORTH);
    expect(snapshot.dispatches).toHaveLength(one.dispatches.length * 2);
    expect(snapshot.prs).toHaveLength(one.prs.length);
    if (one.slots) expect(snapshot.slots?.limit).toBe(one.slots.limit * 2);
  });
});


describe('a PR description on the hosted glass', () => {
  it('relays the description read to the row’s boat', async () => {
    const key = boatFleet('s').prs[0]!.key;
    const h = await hosted('#pr/' + encodeURIComponent(key), { boats: [[SOUTH, 's']], relay: call => call.read?.startsWith('/data/pr/') ? Response.json({ key, title: 'Fresh PR', url: boatFleet('s').prs[0]!.url, bodyHtml: '<p>A fresh description.</p>' }) : undefined });
    expect(text(h.doc.querySelector('.github-description'))).toBe('A fresh description.');
    expect(h.relayed.filter(call => call.read).map(({boat, read}) => ({boat, read}))).toEqual([{ boat: SOUTH.boat, read: '/data/pr/' + encodeURIComponent(key) }]);
    expect(h.relayed.filter(call => call.write)).toEqual([]);
  });
});

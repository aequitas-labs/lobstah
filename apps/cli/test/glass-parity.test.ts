import { build } from 'esbuild';
import { Window } from 'happy-dom';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GlassFullSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { GLASS_CSS, GLASS_SCRIPT } from '../../../services/wharf/src/glass-page.generated.js';
import { dispatchDetail, wharfSnapshot } from '../../../packages/glass-ui/ui/wharf-snapshot.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { detail, jobs, markdown, snapshot } from './fixtures/wharf-glass.js';
import { acceptanceFleet, NOW as FLEET_NOW } from './fixtures/glass-snapshots.js';
import type { GlassSettings, StatsPage } from '@lobstah/core';
import { pollBody } from '../src/glass-poll.js';

/**
 * The gates that keep the local and hosted glass one UI.
 *
 * Parity: the same snapshot, rendered by the local page's own entry on the
 * wharf's capabilities and by the hosted glass, must give the same HTML for
 * every view they share. The hosted glass may add only its host parts
 * (sign-in, its chips, Boats, notices); a list, card or modal it renders its
 * own way fails here.
 *
 * Boundary: services/wharf/glass holds only those host parts, and its
 * stylesheet only the sign-in screen's rules. Shared views belong in
 * packages/glass-ui.
 */

const NOW = Date.parse('2026-10-10T17:05:00Z');
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';
/** The hosted page's DESKTOP browser is a Mac; the local page gets the same platform, so both name the same send shortcut. */
const onMac = (w: unknown) => Object.defineProperty((w as { navigator: object }).navigator, 'platform', { value: 'MacIntel', configurable: true });

/** The world both glasses read: the hosted glass's fixture, with a second job, a landing and no attachments (whose URLs are each host's own). */
const glass = {
  ...snapshot,
  requests: [],
  documents: snapshot.documents.map((d) => ({ ...d, attachments: [] })),
  workers: [...snapshot.workers, { ...snapshot.workers[0]!, id: 'calm-eel', live: true, harness: 'claude', session: 'eel-session', lastCheckIn: '2026-10-10T17:04:00Z' }],
};
const world = [
  // Its current status names the PR its detail names, so the row and the modal agree, as they do in a live wharf.
  { ...jobs[0]!, status: { ...jobs[0]!.status!, evidence: { prUrls: ['https://github.com/aequitas-labs/lobstah/pull/205'] } } },
  { ...jobs[0]!, id: 'asks', brief: 'Pick the base\nWhich branch?', status: { verb: 'needs-decision' as const, note: 'Which base should the PR target?', at: '2026-10-10T17:02:00Z' } },
  { ...jobs[0]!, id: 'landed', state: 'done' as const, brief: 'Land it', status: { verb: 'done' as const, note: 'Merged', at: '2026-10-10T16:00:00Z' } },
];
const details = new Map([['md', markdown]]);
/** What the hosted glass will show, as one snapshot; the local page reads it from /data. */
const expected = (): GlassFullSnapshot => {
  const d = wharfSnapshot(glass, world, NOW, details, 'wharf-session', 'desktop');
  // The dispatch modal reads the full record; the local page gets it from /data/dispatch/<id>.
  return { ...d, dispatches: d.dispatches.map((x) => (x.id === 'job' ? dispatchDetail(detail) : { ...x, brief: '', attachments: [], messageAttachments: [], log: [], inbox: [] })) } as GlassFullSnapshot;
};

/** The local page's own entry, built on another backend's capabilities, as the reference a hosted glass must match. */
async function referencePage(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    loader: { '.png': 'dataurl' },
    logLevel: 'silent',
  });
  const script = result.outputFiles[0]!.text.replace(/<\/(script)/gi, '<\\/$1');
  const at = GLASS_PAGE.indexOf('<script>');
  return GLASS_PAGE.slice(0, at) + '<script>' + script + GLASS_PAGE.slice(GLASS_PAGE.indexOf('</script>', at));
}

let reference = '';
let mirrorReference = '';
beforeAll(async () => {
  [reference, mirrorReference] = await Promise.all([referencePage('./fixtures/glass-wharf-caps-entry.ts'), referencePage('./fixtures/glass-mirror-caps-entry.ts')]);
});

const windows: Window[] = [];
const locals: GlassDom[] = [];
afterEach(async () => {
  await Promise.all([...windows.map((w) => w.happyDOM.close()), ...locals.map((g) => g.close())]);
  windows.length = 0;
  locals.length = 0;
});

/** What the hosted glass's wharf answers: the wharf world the wharf parity tests share. */
async function wharfWorld(path: string, init: RequestInit = {}): Promise<Response> {
  if (init.method && init.method !== 'GET') return Response.json({ success: true });
  if (path === '/api/glass') return Response.json(glass);
  if (path === '/api/glass/dispatches') return Response.json(world);
  if (path === '/api/glass/dispatches/job/detail') return Response.json(detail);
  if (path.includes('/files/')) return new Response(markdown);
  return Response.json({ error: 'not found' }, { status: 404 });
}

/** The hosted glass on the same world, its clock pinned as the local harness pins its own. */
async function hosted(hash: string, respond: (path: string, init?: RequestInit) => Promise<Response> = wharfWorld, now = NOW) {
  const window = new Window({
    url: 'https://glass.test/' + hash,
    width: 1280,
    height: 800,
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      navigator: { userAgent: DESKTOP },
    },
  } as ConstructorParameters<typeof Window>[0]);
  windows.push(window);
  const w = window as unknown as Record<string, unknown> & { Date: DateConstructor };
  w.Date.now = () => now;
  w.WebSocket = class {
    close() {}
  };
  w.setInterval = () => 0;
  w.clearInterval = () => {};
  w.fetch = (path: string, init: RequestInit = {}) => respond(String(path), init);
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await window.happyDOM.waitUntilComplete();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  window.document.write(`<!doctype html><html><head><style>${GLASS_CSS}</style></head><body><script>${GLASS_SCRIPT}</script></body></html>`);
  await settle();
  return { doc: window.document, settle };
}

/** The local page's own entry on the wharf's capabilities, reading the same snapshot from /data. */
async function local(hash: string): Promise<GlassDom> {
  const g = await loadGlass(reference, expected(), { now: NOW, hash, prepare: onMac });
  locals.push(g);
  return g;
}

/**
 * A view's HTML, without what Preact leaves between renders. A listed file's
 * URL is each host's own (/decision/... locally, /api/glass/... on a wharf),
 * so it compares as empty; remote URLs compare as they are.
 */
const html = (el: Element | null | undefined) =>
  (el?.innerHTML ?? '').replace(/<!--.*?-->/g, '').replace(/ src="(?!https?:)[^"]*"/g, ' src=""');

describe('the hosted glass renders exactly what the local glass renders', () => {
  for (const tab of ['deck', 'dispatches', 'traps', 'reviews', 'reports']) {
    it(`#${tab}`, async () => {
      const [l, h] = [await local('#' + tab), await hosted('#' + tab)];
      const page = `#page-${tab}`;
      expect(html(l.$(page)).length, 'the view renders').toBeGreaterThan(40);
      if (tab === 'settings') {
        // Run cards' passkeys differ on purpose: the Mac registers its own; the hosted glass says how a phone pairs.
        expect(h.doc.querySelector('.runpasskeys')?.textContent).toContain('lobstah run passkey add --hosted');
        const without = (el: Element | null | undefined) => {
          const copy = el?.cloneNode(true) as Element | undefined;
          copy?.querySelector('.runpasskeys')?.replaceWith('');
          return html(copy);
        };
        expect(without(h.doc.querySelector(page))).toBe(without(l.$(page)));
        return;
      }
      expect(html(h.doc.querySelector(page))).toBe(html(l.$(page)));
    });
  }

  it('the dispatch modal', async () => {
    const l = await local('#dispatches');
    const h = await hosted('#dispatches');
    const row = (doc: Document | GlassDom['document']) =>
      Array.from(doc.querySelectorAll('#dispatches tr.rowhead')).find((r) => r.querySelector('td')?.textContent === 'job');
    (row(l.document) as unknown as HTMLElement).click();
    await l.settle();
    (row(h.doc as unknown as Document) as unknown as HTMLElement).click();
    await h.settle();
    expect(html(l.$('#modalbox'))).toContain('Build the hosted spyglass');
    expect(html(h.doc.querySelector('#modalbox'))).toBe(html(l.$('#modalbox')));
  });

  it('the decision modal', async () => {
    const l = await local('#decision/card');
    const h = await hosted('#decision/card');
    expect(html(l.$('.dmodal'))).toContain('Choose the next catch');
    expect(html(h.doc.querySelector('.dmodal'))).toBe(html(l.$('.dmodal')));
  });
});

describe('the hosted glass holds only its host parts', () => {
  const root = new URL('../../../services/wharf/glass/', import.meta.url);

  it('keeps every shared view in packages/glass-ui', () => {
    // Sign-in, the page's socket, Boats and its Slack setup, boat approval, passkey pairing, the API helper and the wharf's types: nothing that lists or shows glass items.
    const host = ['api.ts', 'assets.d.ts', 'auth-screen.ts', 'boats.ts', 'common.ts', 'device.ts', 'main.ts', 'model.ts', 'pairing.ts', 'slack.ts', 'socket.ts'];
    const files = fs.readdirSync(new URL('src/', root)).sort();
    expect(files, 'a new view belongs in packages/glass-ui/ui/components, shared by both glasses').toEqual(host);
  });

  it("styles only the sign-in screen; every other rule is the local glass's", () => {
    const css = fs.readFileSync(new URL('glass.css', root), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/([^{}]+)\{/g)]
      .map((m) => m[1]!.trim())
      .filter((s) => !s.startsWith('@'))
      .flatMap((s) => s.split(',').map((x) => x.trim()));
    expect(selectors.length).toBeGreaterThan(0);
    // The sign-in screen's own classes, its GitHub mark, and the page while it shows.
    for (const s of selectors) expect(s, s).toMatch(/(^|[\s>+~(])(\.auth-|#auth-|\.github-mark|body:has\(\.auth-shell\))/);
  });
});

/**
 * A mirror boat: the hosted glass shows the boat's own glass. With one boat,
 * every tab and modal renders from the snapshot the boat put exactly as the
 * local page renders it on the mirror's capabilities: the same tabs as the
 * local glass, with Boats beside them, and no ↗ Open off the boat.
 */
describe('the hosted glass on one mirror boat renders exactly what the local glass renders', () => {
  const BOAT = { boat: 'boat-1', name: 'studio' };
  /** The boat's glass, as its /data serves it to an off-machine viewer. */
  const fleet = (): GlassFullSnapshot => {
    const d = acceptanceFleet();
    d.viewer = { onMachine: false, windowFocus: false, machine: BOAT.name, device: 'desktop' };
    d.attention = [...d.attention, { kind: 'decision', key: 'decision:0a1b2c3d', stateHash: 'h', id: d.dispatches[0]!.id, lane: 'work', verb: 'decision', ageSecs: 60, at: new Date(FLEET_NOW - 60_000).toISOString(), standingSince: new Date(FLEET_NOW - 60_000).toISOString(), note: 'Which base?' }];
    d.decisions = [{ key: 'decision:0a1b2c3d', dispatch: d.dispatches[0]!.id, lane: 'work', title: 'Which base?', detail: 'Choose a base', options: ['main', 'feature'], attachments: [], askedBy: 'helm', askedAt: new Date(FLEET_NOW - 60_000).toISOString(), stateHash: 'h' }];
    return d;
  };
  const stats: StatsPage = { today: '2026-09-24', catchesToday: 2, catchesThisWeek: 3, totalCatches: 9, weeks: [[{ date: '2026-09-24', count: 2, level: 4 }]], months: [], max: 2, perTrap: [{ name: 'pearl-gull', catches: 9 }], undated: 0, historyFrom: '2026-09-24' };
  const settings: GlassSettings = { file: '~/.lobstah/config.toml', versions: { rows: [{ name: 'cli', version: '0.8.6' }], match: true, text: 'all current' }, grounds: [{ name: 'home', repos: ['web'] }], repos: [], sections: [{ title: 'glass', rows: [{ key: 'port', value: '4949', source: 'default' }] }] };
  /** The boat's own answer to a read the hosted glass relays. */
  const boatAnswer = (path: string): Response => {
    const d = fleet();
    if (path === '/data/stats') return Response.json(stats);
    if (path === '/data/settings') return Response.json(settings);
    if (path.startsWith('/data/dispatch/')) {
      const found = d.dispatches.find((x) => x.id === decodeURIComponent(path.slice('/data/dispatch/'.length)));
      return found ? Response.json(found) : Response.json({ error: 'not found' }, { status: 404 });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  };
  const mirrorWorld = async (path: string, init: RequestInit = {}): Promise<Response> => {
    if (path === '/api/glass') return Response.json({ ...glass, documents: [], boats: [{ id: BOAT.boat, name: BOAT.name, revoked: 0, permissions: ['mirror', 'read'], lastCheckIn: null, repos: [] }] });
    if (path === '/api/glass/dispatches') return Response.json([]);
    if (path.startsWith('/api/glass/mirror?') || path === '/api/glass/mirror') {
      // What the boat puts is what its /data serves: the slim poll body, without the page token.
      const { focusToken: _token, ...put } = JSON.parse(pollBody(fleet(), FLEET_NOW).body) as GlassFullSnapshot;
      return Response.json({ boats: [{ ...BOAT, at: new Date(FLEET_NOW - 5_000).toISOString(), etag: 'e'.repeat(64), bytes: 1, snapshot: put }] });
    }
    if (path === '/api/glass/mirror/relay') {
      const call = JSON.parse(String(init.body)) as { boat: string; read?: string };
      expect(call.boat).toBe(BOAT.boat);
      return boatAnswer(call.read ?? '');
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  };
  async function localMirror(hash: string): Promise<GlassDom> {
    const g = await loadGlass(mirrorReference, fleet(), { now: FLEET_NOW, hash, settings, prepare: onMac, get: (url) => (url === '/data/stats' ? { status: 200, body: stats } : undefined) });
    locals.push(g);
    return g;
  }

  for (const tab of ['deck', 'dispatches', 'traps', 'prs', 'reviews', 'reports', 'grants', 'todos', 'notices', 'stats', 'settings']) {
    it(`#${tab}`, async () => {
      const [l, h] = [await localMirror('#' + tab), await hosted('#' + tab, mirrorWorld, FLEET_NOW)];
      const page = `#page-${tab}`;
      expect(html(l.$(page)).length, 'the view renders').toBeGreaterThan(40);
      expect(html(h.doc.querySelector(page))).toBe(html(l.$(page)));
    });
  }

  it('the dispatch modal', async () => {
    const id = fleet().dispatches[0]!.id;
    const l = await localMirror('#dispatches');
    const h = await hosted('#dispatches', mirrorWorld, FLEET_NOW);
    const row = (doc: Document | GlassDom['document']) =>
      Array.from(doc.querySelectorAll('#dispatches tr.rowhead')).find((r) => r.querySelector('td')?.textContent === id.slice(0, 8));
    (row(l.document) as unknown as HTMLElement).click();
    await l.settle();
    (row(h.doc as unknown as Document) as unknown as HTMLElement).click();
    await h.settle();
    expect(html(l.$('#modalbox')).length).toBeGreaterThan(40);
    expect(html(h.doc.querySelector('#modalbox'))).toBe(html(l.$('#modalbox')));
  });

  it('the decision modal', async () => {
    const l = await localMirror('#decision/' + encodeURIComponent('decision:0a1b2c3d'));
    const h = await hosted('#decision/' + encodeURIComponent('decision:0a1b2c3d'), mirrorWorld, FLEET_NOW);
    expect(html(l.$('.dmodal'))).toContain('Which base?');
    expect(html(h.doc.querySelector('.dmodal'))).toBe(html(l.$('.dmodal')));
  });

  it('shows the PRs, TODOs, Notices, Grants, Stats and Settings tabs, and Boats, but no ↗ Open off the boat', async () => {
    const h = await hosted('#traps', mirrorWorld, FLEET_NOW);
    const tabs = Array.from(h.doc.querySelectorAll('#tabs a')).map((a) => a.getAttribute('data-tab'));
    for (const tab of ['prs', 'todos', 'notices', 'grants', 'stats', 'settings', 'boats']) expect(tabs, tab).toContain(tab);
    expect(h.doc.querySelector('#page-traps button.open')).toBeNull();
  });
});

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

let reference = '';
beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/glass-wharf-caps-entry.ts', import.meta.url))],
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
  reference = GLASS_PAGE.slice(0, at) + '<script>' + script + GLASS_PAGE.slice(GLASS_PAGE.indexOf('</script>', at));
});

const windows: Window[] = [];
const locals: GlassDom[] = [];
afterEach(async () => {
  await Promise.all([...windows.map((w) => w.happyDOM.close()), ...locals.map((g) => g.close())]);
  windows.length = 0;
  locals.length = 0;
});

/** The hosted glass on the same world, its clock pinned as the local harness pins its own. */
async function hosted(hash: string) {
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
  w.Date.now = () => NOW;
  w.WebSocket = class {
    close() {}
  };
  w.setInterval = () => 0;
  w.clearInterval = () => {};
  w.fetch = async (path: string, init: RequestInit = {}) => {
    if (init.method && init.method !== 'GET') return Response.json({ success: true });
    if (path === '/api/glass') return Response.json(glass);
    if (path === '/api/glass/dispatches') return Response.json(world);
    if (path === '/api/glass/dispatches/job/detail') return Response.json(detail);
    if (path.includes('/files/')) return new Response(markdown);
    return Response.json({ error: 'not found' }, { status: 404 });
  };
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
  const g = await loadGlass(reference, expected(), { now: NOW, hash });
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
    // Sign-in, the wake hint, Boats, boat approval, the API helper and the wharf's types: nothing that lists or shows glass items.
    const host = ['api.ts', 'assets.d.ts', 'auth-screen.ts', 'boats.ts', 'common.ts', 'device.ts', 'main.ts', 'model.ts', 'wake.ts'];
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

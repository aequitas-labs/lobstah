import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import type { GlassSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { FIXTURES, NOW } from './fixtures/glass-snapshots.js';

/**
 * The fidelity diff: the page as it shipped before the source split
 * (fixtures/glass-legacy.html, the exact bytes the old template string
 * served) and the built page render the same DOM for the same snapshot.
 * Every section is compared verbatim after each view the page can show —
 * every tab in both views, the chain grouping, every modal, the lobs, the
 * preview lob — and the static skeleton after whitespace normalization.
 */
// The exact bytes served, whatever line endings the checkout gave the fixture.
const LEGACY = fs.readFileSync(new URL('./fixtures/glass-legacy.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const REGIONS = ['chips', 'clock', 'deck', 'dispatches', 'traps', 'prs', 'notices', 'foot', 'lobs', 'f-repo', 'f-kind'];
const CONTROLS = ['f-lane', 'f-verb', 'chain-control', 'f-kind', 'stale', 'overlay'];

/** The static skeleton: dynamic regions emptied, script and style dropped, whitespace normalized. */
function skeleton(g: GlassDom): string {
  const body = g.document.body.cloneNode(true) as unknown as HTMLElement;
  for (const el of body.querySelectorAll('script')) el.remove();
  for (const id of [...REGIONS, 'modalbox']) {
    const el = body.querySelector('#' + id);
    if (el) el.innerHTML = '';
  }
  return body.innerHTML
    .replace(/style="([^"]*)"/g, (_m, s: string) => `style="${s.replace(/\s+/g, '').replace(/;$/, '')}"`)
    .replace(/\s*\/>/g, '>')
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Everything the reader can see in the page right now, section by section. */
function capture(g: GlassDom): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of REGIONS) out[id] = g.$('#' + id)?.innerHTML ?? '<missing>';
  // The selects' static options are formatted source in index.html; only their whitespace may differ.
  for (const id of ['f-repo', 'f-kind']) out[id] = out[id]!.replace(/>\s+</g, '><').trim();
  for (const id of CONTROLS) {
    const el = g.$('#' + id) as HTMLElement | null;
    out[`${id}.display`] = el ? `${el.style.display}|${el.className}` : '<missing>';
  }
  out.modal = g.$('#modalbox')?.innerHTML ?? '<missing>';
  out.tabs = g.$$('#tabs a, .tabpage').map((a) => `${a.getAttribute('href') ?? a.id}:${a.className}`).join(' ');
  return out;
}

type Step = { name: string; run: (g: GlassDom) => Promise<void> };

/** Every view the page shows for a snapshot: tabs × views, chain grouping, every modal. */
function steps(d: GlassSnapshot): Step[] {
  const out: Step[] = [];
  for (const view of ['table', 'cards']) {
    out.push({ name: `view ${view}`, run: (g) => g.call('setView', view) });
    for (const tab of ['#deck', '#dispatches', '#traps', '#prs', '#notices']) out.push({ name: `${view} ${tab}`, run: (g) => g.go(tab) });
  }
  out.push({ name: 'view table again', run: (g) => g.call('setView', 'table') });
  out.push({ name: 'chain', run: async (g) => {
    await g.go('#dispatches');
    const box = g.$('#f-chain') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new (g.window as unknown as { Event: typeof Event }).Event('change'));
    await g.settle();
  } });
  out.push({ name: 'filter repo web', run: async (g) => {
    const sel = g.$('#f-repo') as HTMLSelectElement;
    sel.value = 'web';
    sel.dispatchEvent(new (g.window as unknown as { Event: typeof Event }).Event('change'));
    await g.settle();
  } });
  out.push({ name: 'search', run: async (g) => {
    const q = g.$('#f-q') as HTMLInputElement;
    q.value = 'aaaa';
    q.dispatchEvent(new (g.window as unknown as { Event: typeof Event }).Event('input'));
    await g.settle();
  } });
  out.push({ name: 'deck after filters', run: (g) => g.go('#deck') });
  const modals: Array<[string, string]> = [
    ['settings', 'browser'],
    ...d.dispatches.map((x): [string, string] => ['dispatch', `${x.lane}:${x.id}`]),
    ...d.traps.map((t): [string, string] => ['trap', t.trapId]),
    ...d.helms.map((h): [string, string] => ['helm', h.grounds]),
    ...d.prs.map((p): [string, string] => ['pr', p.key]),
  ];
  for (const [type, key] of modals) out.push({ name: `modal ${type} ${key}`, run: (g) => g.call('showModal', type, key) });
  out.push({ name: 'modal closed', run: (g) => g.call('closeModal') });
  out.push({ name: 'poll', run: (g) => g.poll() });
  out.push({ name: 'lobs off', run: (g) => g.call('setLobs', 'off') });
  out.push({ name: 'lobs on', run: (g) => g.call('setLobs', 'on') });
  return out;
}

async function trace(page: string, d: GlassSnapshot, search = ''): Promise<{ skeleton: string; views: Array<[string, Record<string, string>]> }> {
  const g = await loadGlass(page, d, { now: NOW, search });
  try {
    const views: Array<[string, Record<string, string>]> = [['load', capture(g)]];
    for (const s of steps(d)) {
      await s.run(g);
      views.push([s.name, capture(g)]);
    }
    return { skeleton: skeleton(g), views };
  } finally {
    await g.close();
  }
}

describe('glass fidelity: the built page renders the legacy page’s DOM', () => {
  for (const [name, make] of Object.entries(FIXTURES)) {
    it(`${name} fleet: every tab, view, filter, and modal`, async () => {
      const [legacy, built] = [await trace(LEGACY, make()), await trace(GLASS_PAGE, make())];
      expect(built.skeleton).toBe(legacy.skeleton);
      expect(built.views.map(([n]) => n)).toEqual(legacy.views.map(([n]) => n));
      for (let i = 0; i < legacy.views.length; i++) {
        const [step, want] = legacy.views[i]!;
        const got = built.views[i]![1];
        for (const k of Object.keys(want)) expect(got[k], `${name} · ${step} · ${k}`).toBe(want[k]);
      }
    }, 30_000);
  }

  // The CSS moved to glass.css and its literals became tokens (custom
  // properties): every element's computed style must come out the same.
  it('every element computes the same style under glass.css as under the legacy stylesheet', async () => {
    const computed = async (page: string) => {
      const g = await loadGlass(page, FIXTURES['every-attention']!(), { now: NOW });
      const out: string[] = [];
      const snap = (label: string) => {
        g.$$('body *').forEach((el, i) => {
          const cs = g.window.getComputedStyle(el as never);
          const props = Array.from({ length: cs.length }, (_, k) => cs.item(k)).sort();
          out.push(`${label} ${i} ${el.tagName}.${el.className} ` + props.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';'));
        });
      };
      try {
        for (const view of ['table', 'cards']) {
          await g.call('setView', view);
          for (const tab of ['#deck', '#dispatches', '#traps', '#prs', '#notices']) {
            await g.go(tab);
            snap(`${view}${tab}`);
          }
        }
        await g.call('showModal', 'trap', 't1');
        snap('modal');
        await g.call('showModal', 'settings', 'browser');
        snap('settings');
      } finally {
        await g.close();
      }
      return out;
    };
    // Prettier writes glass.css numbers with a leading zero (.55 → 0.55), which
    // happy-dom reports verbatim; the value is the same.
    const norm = (s: string) => s.replace(/(?<![\d.])0\.(\d)/g, '.$1');
    const [legacy, built] = [(await computed(LEGACY)).map(norm), (await computed(GLASS_PAGE)).map(norm)];
    expect(built.length).toBe(legacy.length);
    for (let i = 0; i < legacy.length; i++) expect(built[i]).toBe(legacy[i]);
  }, 60_000);

  it('the ?lob preview lob, on an empty fleet', async () => {
    const [legacy, built] = [await trace(LEGACY, FIXTURES.empty!(), '?lob'), await trace(GLASS_PAGE, FIXTURES.empty!(), '?lob')];
    expect(legacy.views[0]![1].lobs).toContain('attention questions crawl in here');
    expect(built.views.map(([, v]) => v.lobs)).toEqual(legacy.views.map(([, v]) => v.lobs));
  }, 30_000);
});

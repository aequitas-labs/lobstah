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
 * Both pages are driven the way a reader drives them — hash links, clicks
 * on rows and chips, the ⚙ settings buttons, the filter controls, Escape —
 * through every tab in both views, the filters, every modal, the lobs, and
 * the preview lob; every visible section is compared after each step.
 *
 * The comparison is canonical, and each normalization is a documented
 * difference of the Preact page, not a visible one:
 * - event handlers are listeners, not on* attributes, so on* attributes
 *   are dropped (the DOM tests click through them);
 * - attributes compare in sorted order, with style declarations
 *   whitespace-normalized and empty class/style attributes dropped;
 * - a select's chosen option is compared as its value, not a `selected`
 *   attribute;
 * - only the active tab's section is compared: the old page left a hidden
 *   tab's last render in place, the new one does not render hidden tabs;
 * - likewise the modal box only while the overlay is open: the old page
 *   left a closed modal's markup behind the hidden overlay.
 */
// The exact bytes served, whatever line endings the checkout gave the fixture.
const LEGACY = fs.readFileSync(new URL('./fixtures/glass-legacy.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const TABS = ['deck', 'dispatches', 'traps', 'prs', 'notices'];
const REGIONS = ['chips', 'clock', 'foot', 'lobs', 'modalbox', 'f-repo', 'f-kind'];
const CONTROLS = ['f-lane', 'f-verb', 'chain-control', 'f-kind', 'stale', 'overlay'];

const normStyle = (s: string) =>
  s
    .split(';')
    .map((d) => d.replace(/\s*:\s*/, ':').trim())
    .filter(Boolean)
    .join(';');

/** A canonical serialization: sorted attributes, no handlers, adjacent text merged, empty text dropped. */
function canon(node: Node, skeletonOnly = false): string {
  let out = '';
  let text = '';
  const flush = () => {
    // The skeleton's formatting whitespace (index.html vs the old one-line markup) is not content.
    if (skeletonOnly) text = text.trim() ? text.replace(/\s+/g, ' ') : '';
    if (text) out += JSON.stringify(text);
    text = '';
  };
  for (const c of [...node.childNodes]) {
    if (c.nodeType === 3) {
      text += c.textContent ?? '';
      continue;
    }
    if (c.nodeType !== 1) continue;
    flush();
    const el = c as Element;
    if (el.tagName === 'SCRIPT') continue;
    const attrs = [...el.attributes]
      .filter((a) => !a.name.startsWith('on') && a.name !== 'selected')
      .map((a) => [a.name, a.name === 'style' ? normStyle(a.value) : a.value] as const)
      .filter(([n, v]) => !((n === 'class' || n === 'style') && v === ''))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([n, v]) => `${n}=${JSON.stringify(v)}`);
    out += `<${el.tagName.toLowerCase()}${attrs.length ? ' ' + attrs.join(' ') : ''}>${canon(el, skeletonOnly)}</>`;
  }
  flush();
  return out;
}

const activeTab = (g: GlassDom) => (g.$('.tabpage.on')?.id ?? 'page-deck').slice(5);

/** The static skeleton: every region, tab page, and select emptied, then canonical. */
function skeleton(g: GlassDom): string {
  const body = g.document.body.cloneNode(true) as unknown as HTMLElement;
  for (const id of [...REGIONS, ...TABS]) {
    const el = body.querySelector('#' + id);
    if (el) el.innerHTML = '';
  }
  for (const sel of body.querySelectorAll('select')) sel.innerHTML = '';
  return canon(body as unknown as Node, true);
}

/** Everything the reader can see in the page right now, section by section. */
function capture(g: GlassDom): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of REGIONS) {
    const el = g.$('#' + id);
    out[id] = el ? canon(el as unknown as Node) : '<missing>';
  }
  // A closed modal is hidden: the old page left its last markup behind the closed overlay, the new one unmounts it.
  if (g.$('#overlay')!.className !== 'open') out.modalbox = '(closed)';
  const tab = activeTab(g);
  out.tab = tab;
  out.page = canon(g.$('#' + tab) as unknown as Node);
  for (const id of CONTROLS) {
    const el = g.$('#' + id) as HTMLElement | null;
    out[`${id}.display`] = el ? `${el.style.display}|${el.className}` : '<missing>';
  }
  for (const id of ['f-lane', 'f-repo', 'f-verb', 'f-kind', 'f-q']) out[`${id}.value`] = (g.$('#' + id) as HTMLInputElement).value;
  out.chain = String((g.$('#f-chain') as HTMLInputElement).checked);
  out.tabs = g.$$('#tabs a, .tabpage').map((a) => `${a.getAttribute('href') ?? a.id}:${a.className}`).join(' ');
  return out;
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const Evt = (g: GlassDom) => (g.window as unknown as { Event: typeof Event }).Event;
async function click(g: GlassDom, el: Element | null | undefined) {
  if (!el) throw new Error('nothing to click');
  (el as HTMLElement).click();
  await g.settle();
}
async function escape(g: GlassDom) {
  g.document.dispatchEvent(new (g.window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent('keydown', { key: 'Escape' }));
  await g.settle();
}
async function setting(g: GlassDom, row: string, choice: string) {
  await click(g, g.$('#gearbtn'));
  const r = g.$$('#modalbox .settings .row').find((x) => text(x.querySelector('.lbl')).startsWith(row));
  await click(g, r && [...r.querySelectorAll('.seg button')].find((b) => text(b) === choice));
  await escape(g);
}
async function control(g: GlassDom, id: string, value: string | boolean, type = 'change') {
  const el = g.$('#' + id) as HTMLInputElement;
  if (typeof value === 'boolean') el.checked = value;
  else el.value = value;
  el.dispatchEvent(new (Evt(g))(type));
  await g.settle();
}
async function openRow(g: GlassDom, tab: string, label: string) {
  await g.go('#' + tab);
  await click(
    g,
    g.$$(`#${tab} tr.rowhead`).find((tr) => text(tr.querySelector('td')).includes(label)),
  );
}

type Step = { name: string; run: (g: GlassDom) => Promise<void> };

/** Every view the page shows for a snapshot: tabs × views, filters, every modal — as a reader reaches them. */
function steps(d: GlassSnapshot): Step[] {
  const out: Step[] = [];
  for (const view of ['table', 'cards']) {
    out.push({ name: `view ${view}`, run: (g) => setting(g, 'view', view) });
    for (const tab of TABS) out.push({ name: `${view} #${tab}`, run: (g) => g.go('#' + tab) });
  }
  out.push({ name: 'view table again', run: (g) => setting(g, 'view', 'table') });
  out.push({
    name: 'chain',
    run: async (g) => {
      await g.go('#dispatches');
      await control(g, 'f-chain', true);
    },
  });
  out.push({ name: 'filter repo web', run: (g) => control(g, 'f-repo', 'web') });
  out.push({ name: 'filter verb working', run: (g) => control(g, 'f-verb', 'working') });
  out.push({ name: 'filter lane chore', run: (g) => control(g, 'f-lane', 'chore') });
  out.push({
    name: 'filters cleared',
    run: async (g) => {
      for (const id of ['f-lane', 'f-verb', 'f-repo']) await control(g, id, '');
    },
  });
  out.push({
    name: 'notice kind',
    run: async (g) => {
      await g.go('#notices');
      await control(g, 'f-kind', d.notices[0]?.kind ?? '');
    },
  });
  out.push({ name: 'search', run: (g) => control(g, 'f-q', 'aaaa', 'input') });
  out.push({ name: 'deck after filters', run: (g) => g.go('#deck') });
  out.push({ name: 'search cleared', run: (g) => control(g, 'f-q', '', 'input') });
  out.push({ name: 'modal settings', run: (g) => click(g, g.$('#gearbtn')) });
  for (const x of d.dispatches) out.push({ name: `modal dispatch ${x.id}`, run: (g) => openRow(g, 'dispatches', x.id.slice(0, 8)) });
  for (const t of d.traps) out.push({ name: `modal trap ${t.trapId}`, run: (g) => openRow(g, 'traps', 'wt:' + t.trapId) });
  for (const h of d.helms) out.push({ name: `modal helm ${h.grounds}`, run: (g) => click(g, g.$('#chips .chip.click')) });
  for (const p of d.prs) out.push({ name: `modal pr ${p.key}`, run: (g) => openRow(g, 'prs', '#' + p.number) });
  if (d.prs.length)
    out.push({
      name: 'PR modal chain link',
      run: async (g) => {
        await openRow(g, 'prs', '#' + d.prs[0]!.number);
        await click(
          g,
          g.$$('#modalbox a').find((a) => a.getAttribute('href') === '#'),
        );
      },
    });
  out.push({ name: 'modal closed', run: (g) => escape(g) });
  out.push({ name: 'poll', run: (g) => g.poll() });
  out.push({ name: 'lobs off', run: (g) => setting(g, 'lobs', 'off') });
  out.push({ name: 'lobs on', run: (g) => setting(g, 'lobs', 'on') });
  return out;
}

async function trace(page: string, d: GlassSnapshot, search = '') {
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
    }, 60_000);
  }

  // The CSS moved to glass.css and its literals became tokens (custom
  // properties): every visible element's computed style must come out the same.
  it('every visible element computes the same style under glass.css as under the legacy stylesheet', async () => {
    const computed = async (page: string) => {
      const g = await loadGlass(page, FIXTURES['every-attention']!(), { now: NOW });
      const out: string[] = [];
      const snap = (label: string) => {
        const hidden = [...g.$$('.tabpage:not(.on)'), ...(g.$('#overlay')!.className === 'open' ? [] : [g.$('#modalbox')!])];
        g.$$('body *')
          .filter((el) => el.tagName !== 'SCRIPT' && !hidden.some((p) => p !== el && p.contains(el as never)))
          .forEach((el, i) => {
            const cs = g.window.getComputedStyle(el as never);
            const props = Array.from({ length: cs.length }, (_, k) => cs.item(k)).sort();
            out.push(`${label} ${i} ${el.tagName}.${el.className} ` + props.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';'));
          });
      };
      try {
        for (const view of ['table', 'cards']) {
          await setting(g, 'view', view);
          for (const tab of TABS) {
            await g.go('#' + tab);
            snap(`${view}#${tab}`);
          }
        }
        await setting(g, 'view', 'table');
        await openRow(g, 'traps', 'wt:t1');
        snap('modal');
        await click(g, g.$('#gearbtn'));
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

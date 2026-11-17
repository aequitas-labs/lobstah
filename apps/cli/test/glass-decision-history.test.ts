import { afterEach, describe, expect, it } from 'vitest';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass, type GlassDom } from './glass-dom.js';
import { emptyFleet, NOW, ago } from './fixtures/glass-snapshots.js';

const keys = ['decision:first', 'decision:second', 'decision:third'];
const hash = (key: string) => '#decision/' + encodeURIComponent(key);
const pages: GlassDom[] = [];
afterEach(async () => { await Promise.all(pages.splice(0).map(g => g.close())); });
function fleet() {
  const d = emptyFleet();
  d.focusToken = 'tok';
  d.decisions = keys.map((key, i) => ({ key, title: `Question ${i + 1}`, detail: '', options: ['Yes', 'No'], attachments: [], askedBy: 'helm', askedAt: ago((3 - i) * 60_000), stateHash: key }));
  d.attention = d.decisions.map(c => ({ kind: 'decision' as const, key: c.key, note: c.title, stateHash: c.key, verb: 'decision', ageSecs: 60, at: c.askedAt }));
  return d;
}
async function page(initial = '#deck') {
  const d = fleet();
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, hash: initial, post: () => ({ status: 200, body: { ok: true } }) });
  pages.push(g);
  return { g, d };
}
async function click(g: GlassDom, selector: string) {
  expect(g.$(selector)).toBeTruthy();
  (g.$(selector) as HTMLElement).click();
  await g.settle();
}
const shown = (g: GlassDom) => g.$('.dmodal')?.getAttribute('data-decision');
async function back(g: GlassDom) { g.window.history.back(); await g.settle(); }
async function forward(g: GlassDom) { g.window.history.forward(); await g.settle(); }

describe('decision browser history', () => {
  it('pushes a card visit, then restores the page on Back and the card on Forward', async () => {
    const { g } = await page();
    g.setScroll(340);
    const length = g.window.history.length;
    await click(g, `[data-decision="${keys[0]}"] .dopen`);
    expect(g.window.location.hash).toBe(hash(keys[0]!));
    expect(g.window.history.length).toBe(length + 1);
    await back(g);
    expect(g.window.location.hash).toBe('#deck');
    expect(g.$('.dmodal')).toBeNull();
    expect(g.window.scrollY).toBe(340);
    await forward(g);
    expect(shown(g)).toBe(keys[0]);
  });

  it('pushes next, previous and keyboard visits and renders each popstate without fetching the page again', async () => {
    const { g } = await page();
    await click(g, `[data-decision="${keys[0]}"] .dopen`);
    const length = g.window.history.length;
    const fetches = g.fetches();
    await click(g, '.dnext');
    g.document.dispatchEvent(new g.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await g.settle();
    await click(g, '.dprev');
    expect(g.window.history.length).toBe(length + 3);
    expect(shown(g)).toBe(keys[1]);
    await back(g); expect(shown(g)).toBe(keys[2]);
    await back(g); expect(shown(g)).toBe(keys[1]);
    await back(g); expect(shown(g)).toBe(keys[0]);
    await forward(g); expect(shown(g)).toBe(keys[1]);
    expect(g.fetches()).toBe(fetches);
  });

  it.each(['toast', 'link'])('opens from a %s over the selected tab and returns to its scroll', async (source) => {
    const { g } = await page('#reviews');
    g.setScroll(280);
    const length = g.window.history.length;
    if (source === 'toast') await click(g, '.dalert-open');
    else await click(g, `a.lob[href="${hash(keys[0]!)}"]`);
    expect(shown(g)).toBe(keys[0]);
    expect(g.$('.tabpage.on')?.id).toBe('page-reviews');
    expect(g.window.history.length).toBe(length + 1);
    await back(g);
    expect(g.$('.dmodal')).toBeNull();
    expect(g.$('.tabpage.on')?.id).toBe('page-reviews');
    expect(g.window.scrollY).toBe(280);
  });

  it('replaces an answered visit with the next card', async () => {
    const { g } = await page();
    await click(g, `[data-decision="${keys[0]}"] .dopen`);
    const length = g.window.history.length;
    await click(g, '.dopt');
    await click(g, '.dsend');
    expect(shown(g)).toBe(keys[1]);
    expect(g.window.location.hash).toBe(hash(keys[1]!));
    expect(g.window.history.length).toBe(length);
    await back(g); expect(g.$('.dmodal')).toBeNull();
    await forward(g); expect(shown(g)).toBe(keys[1]);
  });

  it('replaces a withdrawn visit and keeps the empty state addressable after the last withdrawal', async () => {
    const { g, d } = await page();
    await click(g, `[data-decision="${keys[0]}"] .dopen`);
    const length = g.window.history.length;
    d.decisions.shift(); d.attention.shift();
    g.serve(d); await g.poll();
    expect(shown(g)).toBe(keys[1]);
    expect(g.window.location.hash).toBe(hash(keys[1]!));
    expect(g.window.history.length).toBe(length);
    d.decisions = []; d.attention = [];
    g.serve(d); await g.poll();
    expect(g.window.location.hash).toBe('#decisions');
    expect(g.$('.ddone')).toBeTruthy();
    await back(g); expect(g.$('.dmodal')).toBeNull();
    await forward(g); expect(g.$('.ddone')).toBeTruthy();
  });

  it('opens a fresh deep link without manufacturing a Back destination', async () => {
    const { g } = await page(hash(keys[1]!));
    expect(shown(g)).toBe(keys[1]);
    expect(g.window.history.length).toBe(1);
    expect(g.window.history.state?.glassDecision).toBeUndefined();
    await click(g, '.dnext');
    await back(g); expect(shown(g)).toBe(keys[1]);
  });

  it('renders a popstate immediately and adds no new entry', async () => {
    const { g } = await page('#reviews');
    const length = g.window.history.length;
    g.window.history.replaceState(null, '', hash(keys[1]!));
    g.window.dispatchEvent(new g.window.PopStateEvent('popstate', { state: null }));
    expect(shown(g)).toBe(keys[1]);
    expect(g.window.history.length).toBe(length);
    await g.settle();
    expect(g.$$('.dmodal')).toHaveLength(1);
  });

  it('loads a closed card when Back returns to a visit that predates its withdrawal', async () => {
    const d = fleet();
    const archived = { ...d.decisions[0]!, readOnly: true };
    const g = await loadGlass(GLASS_PAGE, d, {
      now: NOW, hash: '#deck', post: () => ({ status: 200, body: { ok: true } }),
      get: url => url === '/data/decision/' + encodeURIComponent(keys[0]!) ? { status: 200, body: archived } : undefined,
    });
    pages.push(g);
    await click(g, `[data-decision="${keys[0]}"] .dopen`);
    await click(g, '.dnext');
    d.decisions.shift(); d.attention.shift();
    g.serve(d); await g.poll();
    await back(g);
    expect(g.window.location.hash).toBe(hash(keys[0]!));
    expect(shown(g)).toBe(keys[0]);
    expect(g.$('.dmodal')?.textContent).toContain('Closed decision');
    expect(g.$('.dmodal .dsend')).toBeNull();
  });

  it('falls back to the decisions list for an unknown card', async () => {
    const { g } = await page();
    await g.go(hash('decision:gone'));
    expect(g.window.location.hash).toBe('#deck');
    expect(g.$('.dmodal')).toBeNull();
    expect(g.$$('#deck .dopen')).toHaveLength(3);
  });
});

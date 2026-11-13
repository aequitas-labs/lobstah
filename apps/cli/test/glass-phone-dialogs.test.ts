import { afterEach, describe, expect, it } from 'vitest';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass, type GlassDom } from './glass-dom.js';
import { acceptanceFleet, NOW } from './fixtures/glass-snapshots.js';

const open: GlassDom[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map(g => g.close())); });
async function click(g: GlassDom, selector: string) { (g.$(selector) as unknown as HTMLElement).click(); await g.settle(); }
function touch(g: GlassDom, selector: string, type: string, x: number, y: number) {
  const event = new g.window.Event(type, { bubbles: true });
  Object.defineProperty(event, type === 'touchstart' ? 'touches' : 'changedTouches', { value: [{clientX: x, clientY: y}] });
  g.$(selector)!.dispatchEvent(event);
}
async function page(hash = '#deck', description?: string) {
  const d = acceptanceFleet();
  const key = d.prs[0]!.key;
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, hash, prepare: window => Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true }), get: url => url.startsWith('/data/pr/') ? { status: 200, body: {key, url:d.prs[0]!.url, title:'A PR', bodyHtml:description ?? ''} } : undefined });
  open.push(g); return g;
}

describe('phone sheets', () => {
  it('opens the helm in the shared dialog, restores focus and keeps the tab scroll on Back', async () => {
    const g = await page();
    g.setScroll(380);
    await click(g, '.helmpill');
    expect(g.$('.helm-dialog[role=dialog]')).not.toBeNull();
    expect(g.$('.helm-dialog')?.textContent).toContain('fleet');
    expect(g.document.body.style.overflow).toBe('hidden');
    g.window.history.back(); await g.settle();
    expect(g.$('.helm-dialog')).toBeNull();
    expect(g.window.location.hash).toBe('#deck');
    expect(g.window.scrollY).toBe(380);
  });
  it('uses the same menu contents in a dialog and closes on a downward header swipe', async () => {
    const g = await page();
    await click(g, '.bottombar [aria-label=Menu]');
    expect(g.$('.phone-menu-dialog #phone-menu')).not.toBeNull();
    expect(g.$$('#phone-menu nav a').map(a => a.getAttribute('href')).sort()).toEqual(g.$$('#tabs a').map(a => a.getAttribute('href')).sort());
    touch(g, '.phone-menu-dialog .dialog-head', 'touchstart', 150, 100);
    touch(g, '.phone-menu-dialog .dialog-head', 'touchend', 155, 180);
    await g.settle();
    expect(g.$('#phone-menu')).toBeNull();
    expect(g.window.location.hash).toBe('#deck');
  });
  it('closes the menu on Back and can replace it with Settings without leaving a sheet behind', async () => {
    const g = await page('#prs');
    await click(g, '.bottombar [aria-label=Menu]');
    g.window.history.back(); await g.settle();
    expect(g.$('#phone-menu')).toBeNull();
    await click(g, '.bottombar [aria-label=Menu]');
    const settings = g.$$('#phone-menu button').find(button => button.textContent?.includes('Settings'))!;
    (settings as unknown as HTMLElement).click(); await g.settle();
    expect(g.$('.settings-dialog')).not.toBeNull();
    expect(g.$('#phone-menu')).toBeNull();
    g.window.history.back(); await g.settle();
    expect(g.$('.settings-dialog')).toBeNull();
    expect(g.window.location.hash).toBe('#prs');
  });
});

describe('images from one description', () => {
  it('shows its position and steps with arrows and horizontal swipes, while vertical swipes leave it alone', async () => {
    const g = await page('#pr/pr%3Aacme%2Fweb%2341', '<img src="https://user-images.githubusercontent.com/first.png" alt="First"><img src="https://user-images.githubusercontent.com/second.png" alt="Second">');
    const photos = g.$$('.github-description .mdimg');
    (photos[1] as unknown as HTMLElement).click(); await g.settle();
    expect(g.$('.lbcount')?.textContent).toBe('2 of 2');
    g.document.dispatchEvent(new g.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); await g.settle();
    expect(g.$('.lbimg')?.getAttribute('alt')).toBe('First');
    touch(g, '.lightbox', 'touchstart', 200, 100); touch(g, '.lightbox', 'touchend', 180, 200); await g.settle();
    expect(g.$('.lbcount')?.textContent).toBe('1 of 2');
    touch(g, '.lightbox', 'touchstart', 200, 100); touch(g, '.lightbox', 'touchend', 100, 110); await g.settle();
    expect(g.$('.lbcount')?.textContent).toBe('2 of 2');
    g.document.dispatchEvent(new g.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await g.settle();
    expect(g.$('.lightbox')).toBeNull();
    expect(g.$('.pr-view-head')).not.toBeNull();
  });
  it('has no count or navigation for one image and Back returns to its PR', async () => {
    const g = await page('#pr/pr%3Aacme%2Fweb%2341', '<img src="https://user-images.githubusercontent.com/only.png" alt="Only">');
    await click(g, '.github-description .mdimg');
    expect(g.$('.lbcount, .lbprev, .lbnext')).toBeNull();
    touch(g, '.lightbox', 'touchstart', 200, 100); touch(g, '.lightbox', 'touchend', 100, 110); await g.settle();
    expect(g.$('.lbimg')?.getAttribute('alt')).toBe('Only');
    g.window.history.back(); await g.settle();
    expect(g.$('.lightbox')).toBeNull();
    expect(g.$('.pr-view-head')).not.toBeNull();
  });
});

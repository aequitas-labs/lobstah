import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { render } from 'preact';
import type { GlassFullSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, acceptanceFleet, everyAttentionFleet } from './fixtures/glass-snapshots.js';
import { Button, buttonClass } from '../../../packages/glass-ui/ui/components/button.js';
import { ToastHost } from '../../../packages/glass-ui/ui/components/toast.js';
import { html } from '../../../packages/glass-ui/ui/html.js';

/**
 * The Button atom (packages/glass-ui/ui/components/button.ts): every action
 * on the glass is one, in one of four variants and two sizes, and no other
 * stylesheet rule sizes or colors a button.
 */

let pages: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(pages.map((g) => g.close()));
  pages = [];
});
async function page(d: GlassFullSnapshot, hash: string): Promise<GlassDom> {
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, hash, prefs: { view: 'cards' } });
  pages.push(g);
  return g;
}

describe('the atom', () => {
  it('wears btn, its variant, its size when not md, and role classes, never a size of its own', () => {
    expect(buttonClass()).toBe('btn btn-secondary');
    expect(buttonClass('primary')).toBe('btn btn-primary');
    expect(buttonClass('icon', 'lg', 'dattach')).toBe('btn btn-icon btn-lg dattach');
    expect(buttonClass('danger', 'md', false)).toBe('btn btn-danger');
  });

  it('is a button of type button, a link with an href, named when it is an icon, and pressed when a toggle is on', async () => {
    const g = await page(acceptanceFleet(), '#deck');
    const host = g.window.document.createElement('div');
    g.window.document.body.appendChild(host);
    // Preact renders with the global document: the page's, while it renders here.
    const global = globalThis as { document?: unknown };
    const before = global.document;
    global.document = g.window.document;
    render(
      html`<div>
        <${Button}>Skip<//>
        <${Button} variant="primary" pressed=${true}>Cancel merge<//>
        <${Button} variant="icon" label="Open" href="https://example.com/">↗<//>
        <${Button} variant="danger" size="lg" type="submit">Stop<//>
      </div>`,
      host as never,
    );
    global.document = before;
    const [skip, merge, open, stop] = [...host.querySelectorAll('.btn')];
    expect([skip!.tagName, skip!.getAttribute('type'), skip!.className]).toEqual(['BUTTON', 'button', 'btn btn-secondary']);
    expect([merge!.className, merge!.getAttribute('aria-pressed')]).toEqual(['btn btn-primary on', 'true']);
    expect([open!.tagName, open!.getAttribute('aria-label'), open!.getAttribute('title'), open!.className]).toEqual(['A', 'Open', 'Open', 'btn btn-icon']);
    expect([stop!.getAttribute('type'), stop!.className]).toEqual(['submit', 'btn btn-danger btn-lg']);
  });

  it('shows progress, announces success, and puts a refusal beside the action', async () => {
    const g = await page(acceptanceFleet(), '#deck');
    const host = g.window.document.createElement('div');
    g.window.document.body.appendChild(host);
    const global = globalThis as { document?: unknown };
    const before = global.document;
    global.document = g.window.document;
    let finish!: () => void;
    let called = 0;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    render(
      html`<div>
        <${Button} action=${async () => { called++; await pending; }} sending="Approving…" done="Approved #91">Approve<//>
        <${Button} action=${async () => 'The request was refused.'}>Send<//>
        <${ToastHost} />
      </div>`,
      host as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [approve, send] = [...host.querySelectorAll('button')];
    (approve as unknown as HTMLElement).click();
    await Promise.resolve();
    expect(called).toBe(1);
    expect(approve!.disabled).toBe(true);
    expect(approve!.getAttribute('aria-busy')).toBe('true');
    expect(approve!.textContent).toContain('Approving…');
    finish();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(approve!.disabled).toBe(false);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Approved #91');
    (send as unknown as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('The request was refused.');
    global.document = before;
  });

  it('is 32px with 12px words, 40px with 14px at lg, and an icon is a square', async () => {
    const g = await page(acceptanceFleet(), '#deck');
    const host = g.window.document.createElement('div');
    g.window.document.body.appendChild(host);
    // Preact renders with the global document: the page's, while it renders here.
    const global = globalThis as { document?: unknown };
    const before = global.document;
    global.document = g.window.document;
    render(
      html`<div><${Button}>md<//><${Button} size="lg">lg<//><${Button} variant="icon" label="i">i<//><${Button} variant="icon" size="lg" label="j">j<//></div>`,
      host as never,
    );
    global.document = before;
    const style = (el: Element) => g.window.getComputedStyle(el as never);
    const [md, lg, icon, iconLg] = [...host.querySelectorAll('.btn')];
    expect([style(md!).getPropertyValue('min-height'), style(md!).getPropertyValue('font-size')]).toEqual(['32px', '12px']);
    expect([style(lg!).getPropertyValue('min-height'), style(lg!).getPropertyValue('font-size')]).toEqual(['40px', '14px']);
    expect([style(icon!).getPropertyValue('min-width'), style(icon!).getPropertyValue('padding-left')]).toEqual(['32px', '0px']);
    expect(style(iconLg!).getPropertyValue('min-width')).toBe('40px');
  });
});

describe('every page', () => {
  /** Controls that are not action buttons: a row, a chip, navigation, an image, a menu item, an eye in a field. */
  const NOT_ACTIONS = '.dopen, .dalert-open, .nav-toggle, .helmpill, .repochip, .bbitem, .thumb, .mdimg, .runeye, .cmenuitem, #tabs *, .seg-tab';

  it.each([
    ['#deck', everyAttentionFleet],
    ['#prs', acceptanceFleet],
    ['#traps', everyAttentionFleet],
    ['#reports', everyAttentionFleet],
    ['#notices', everyAttentionFleet],
  ] as const)('%s: every action button is the atom, 32px or 40px tall', async (hash, fleet) => {
    const d = fleet();
    d.focusToken = 'tok';
    const g = await page(d, hash);
    const style = (el: Element) => g.window.getComputedStyle(el as never);
    const actions = g.$$('button, a.btn').filter((b) => !b.matches(NOT_ACTIONS));
    expect(actions.length).toBeGreaterThan(0);
    for (const b of actions) {
      expect(b.className, b.outerHTML.slice(0, 80)).toMatch(/(^| )btn( |$)/);
      expect(['32px', '40px'], b.outerHTML.slice(0, 80)).toContain(style(b).getPropertyValue('min-height'));
    }
  });

  it('has no stylesheet rule but the atom that sizes or colors a button', () => {
    // A Windows checkout may end lines with CRLF.
    const css = fs.readFileSync(new URL('../../../packages/glass-ui/ui/glass.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const atom = /^\.btn(-(primary|danger|icon|lg)(:hover)?|:hover|:disabled|\.on|\[aria-pressed='true'\]|-lg\.btn-icon)?$/;
    const offenders: string[] = [];
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = m[1]!
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      // Only rules on a button itself; one on text inside it (an option's key or note) is not the button's look.
      const own = selectors.filter((s) => /(\.btn\b|(^|\s)button\b)[^\s>]*$/.test(s));
      if (!own.length) continue;
      if (own.every((s) => atom.test(s))) continue;
      const sizing = /(^|;|\s)(min-height|height|font-size|padding|padding-inline|background|color)\s*:/.test(m[2]!);
      // An option card wraps its words (padding-block only); a segmented control joins its buttons (no border).
      if (sizing && !own.every((s) => /^\.btn\.dopt$/.test(s))) offenders.push(own.join(', '));
    }
    expect(offenders).toEqual([]);
  });
});

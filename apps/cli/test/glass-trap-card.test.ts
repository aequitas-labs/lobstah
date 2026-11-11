import { afterEach, describe, expect, it } from 'vitest';
import type { GlassFullSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, acceptanceFleet } from './fixtures/glass-snapshots.js';

/**
 * The trap card (components/card.ts, traps.ts trapCard): the same four lines
 * on every glass and width. Parity between the local and the hosted glass is
 * glass-parity.test.ts's.
 */

let open: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

function fleet(viewer: GlassFullSnapshot['viewer']): GlassFullSnapshot {
  const d = acceptanceFleet();
  d.viewer = viewer;
  Object.assign(d.traps[0]!, { name: 'hardy-kelp', repo: 'aequitas-labs/lobstah', totalCatches: 36 });
  return d;
}

async function card(d: GlassFullSnapshot, hash = '#traps') {
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, hash, prefs: { view: 'cards' } });
  open.push(g);
  return { g, card: g.$$(`${hash === '#deck' ? '#deck' : '#traps'} .card`).find((c) => text(c).includes('hardy-kelp'))! };
}

describe('the trap card', () => {
  it('shows its name, harness, lowercase state, repo, current work, boat and catches', async () => {
    const { card: c } = await card(fleet({ onMachine: false, windowFocus: false, machine: 'studio', device: 'phone' }));
    expect(text(c.querySelector('.gtitle'))).toBe('hardy-kelp');
    expect(c.querySelector('.gicon .harness-icon')?.getAttribute('aria-label')).toBe('Claude');
    const word = text(c.querySelector('.gchip'));
    expect(word).toBe('working');
    expect(word).toBe(word.toLowerCase());
    expect(text(c.querySelector('.gcontext .gtext'))).toBe('aequitas-labs/lobstah');
    expect(text(c.querySelector('.gnow'))).not.toBe('');
    expect(text(c.querySelector('.gfoot'))).toContain('⛵ studio');
    expect(text(c.querySelector('.gfoot'))).toContain('🦞 36');
  });

  it('shows the same card on the deck', async () => {
    const { card: c } = await card(fleet({ onMachine: false, windowFocus: false, machine: 'studio', device: 'phone' }), '#deck');
    expect(text(c.querySelector('.gchip'))).toBe('working');
    expect(text(c.querySelector('.gfoot'))).toContain('⛵ studio');
  });

  it('shows no Open and no "only reachable" note when this page has no route to the trap', async () => {
    const d = fleet({ onMachine: false, windowFocus: false, machine: 'studio', device: 'phone' });
    Object.assign(d.traps[0]!, { link: undefined, attachCommand: undefined });
    const { card: c } = await card(d);
    expect(c.querySelector('.gaction')).toBeNull();
    expect(text(c)).not.toContain('only reachable');
    expect(text(c)).not.toContain('Running on');
  });

  it("keeps ↗ Open on the trap's own machine", async () => {
    const d = fleet({ onMachine: true, windowFocus: true, machine: 'studio', device: 'desktop' });
    d.focusToken = 'fixture-token';
    const { card: c } = await card(d);
    expect(text(c.querySelector('.gaction'))).toBe('↗ Open');
  });

  it("leaves the table view's columns as they were", async () => {
    const g = await loadGlass(GLASS_PAGE, fleet({ onMachine: true, windowFocus: true, machine: 'studio', device: 'desktop' }), {
      now: NOW,
      hash: '#traps',
      prefs: { view: 'table' },
    });
    open.push(g);
    expect(g.$$('#traps th').map((th) => text(th))).toEqual([
      'address',
      'repo',
      'worktree',
      'harness',
      'session',
      'now',
      'listening',
      'heartbeat',
      'mail',
      'catches',
      'window',
    ]);
  });
});

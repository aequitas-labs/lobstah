import { afterEach, describe, expect, it } from 'vitest';
import type { GlassSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom, GlassDomOptions } from './glass-dom.js';
import { NOW, acceptanceFleet, ago } from './fixtures/glass-snapshots.js';

let open: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});
async function page(d: GlassSnapshot, opts: Partial<GlassDomOptions> = {}): Promise<GlassDom> {
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, ...opts });
  open.push(g);
  return g;
}
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

function fleet(stale: boolean): GlassSnapshot {
  const d = acceptanceFleet();
  const x = d.dispatches.find((y) => y.id.startsWith('bbbbbbbb'))!;
  x.note = 'building the parser';
  x.activity = { at: ago(stale ? 20 * 60_000 : 12_000), kind: 'tool', summary: 'Edit src/parse.ts', ageSecs: stale ? 1200 : 12, stale };
  return d;
}

describe('glass: the activity line sits under the verb and note', () => {
  for (const view of ['cards', 'table'] as const) {
    it(`${view}: fresh activity shows its summary and age`, async () => {
      const g = await page(fleet(false), { hash: '#dispatches', prefs: { view } });
      const el = g.$$('#dispatches .activity')[0];
      expect(text(el)).toBe('Edit src/parse.ts · 12s ago');
      expect(el?.className).toBe('activity');
    });
  }

  it('stale activity is dim and says so, with its age', async () => {
    const g = await page(fleet(true), { hash: '#dispatches', prefs: { view: 'cards' } });
    const card = g.$$('#dispatches .card').find((c) => text(c).includes('bbbbbbbb'))!;
    expect(text(card.querySelector('.note'))).toBe('building the parser');
    const el = card.querySelector('.activity')!;
    expect(el.className).toBe('activity stale');
    expect(text(el)).toBe('stale · Edit src/parse.ts · 20m ago');
  });
});

describe('glass: a paused dispatch says what it waits on', () => {
  it('shows the kind, the time waited, and links the URL', async () => {
    const d = acceptanceFleet();
    const x = d.dispatches.find((y) => y.id.startsWith('bbbbbbbb'))!;
    x.verb = 'paused';
    x.waiting = { on: 'review', link: 'https://ume.example.com/s/abc', since: ago(12 * 60_000), waitedSecs: 720 };
    const g = await page(d, { hash: '#dispatches', prefs: { view: 'cards' } });
    const card = g.$$('#dispatches .card').find((c) => text(c).includes('bbbbbbbb'))!;
    const w = card.querySelector('.waiting')!;
    expect(text(w)).toBe('paused: waiting on review · 12m · ume.example.com/s/abc');
    const a = w.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://ume.example.com/s/abc');
    expect(a.getAttribute('target')).toBe('_blank');
  });

  it('never renders a non-http link', async () => {
    const d = acceptanceFleet();
    const x = d.dispatches.find((y) => y.id.startsWith('bbbbbbbb'))!;
    x.verb = 'paused';
    x.waiting = { on: 'external', link: 'javascript:alert(1)', since: ago(60_000), waitedSecs: 60 };
    const g = await page(d, { hash: '#dispatches' });
    expect(g.$$('#dispatches .waiting a')).toHaveLength(0);
    expect(text(g.$$('#dispatches .waiting')[0])).toBe('paused: waiting on external · 60s');
  });
});

describe('glass: a reserved trap shows as starting, then as failed', () => {
  const reserved = (failed: boolean): GlassSnapshot => {
    const d = acceptanceFleet();
    d.traps.push({
      trapId: 'abcd1234',
      name: 'amber-gull',
      label: 'amber-gull (wt:abcd1234)',
      repo: 'web',
      live: false,
      starting: {
        reservedAt: ago(60_000),
        deadline: ago(-120_000),
        ...(failed ? { failedAt: ago(1_000), reason: 'no session signed on by 12:03' } : {}),
      },
      messages: [],
      notices: [],
      catches: [],
    });
    return d;
  };
  for (const view of ['cards', 'table'] as const) {
    it(`${view}: starting, with no window action`, async () => {
      const g = await page(reserved(false), { hash: '#traps', prefs: { view } });
      const el = view === 'cards' ? g.$$('#traps .card').find((c) => text(c).includes('amber-gull')) : g.$$('#traps tr').find((c) => text(c).includes('amber-gull'));
      expect(text(el)).toContain('starting · waiting for its session to sign on');
      expect(text(el)).toContain('Starting — no window yet');
      expect(el?.className).not.toContain('dim');
    });
  }
  it('failed: says why, on the traps tab and the deck', async () => {
    const g = await page(reserved(true), { hash: '#traps', prefs: { view: 'cards' } });
    const card = g.$$('#traps .card').find((c) => text(c).includes('amber-gull'));
    expect(text(card)).toContain('start failed · no session signed on by 12:03');
    expect(text(card?.querySelector('.badge'))).toBe('start failed');
    await g.go('#deck');
    expect(g.$$('#deck *').some((e) => text(e).includes('amber-gull'))).toBe(true);
  });
});

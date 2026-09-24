import { afterEach, describe, expect, it } from 'vitest';
import type { GlassSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom, GlassDomOptions } from './glass-dom.js';
import { NOW, acceptanceFleet, ago, emptyFleet, everyAttentionFleet } from './fixtures/glass-snapshots.js';

/**
 * The spyglass page, tested as a page: the built HTML loads into happy-dom,
 * /data answers with a fixture snapshot, and every assertion reads the DOM.
 */

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
const shown = (g: GlassDom, id: string) => (g.$('#' + id) as HTMLElement).style.display !== 'none';
const click = async (g: GlassDom, el: Element | null) => {
  expect(el).toBeTruthy();
  (el as HTMLElement).click();
  await g.settle();
};

describe('glass page: tabs and hash routing', () => {
  it('opens On deck by default and follows the hash to each tab', async () => {
    const g = await page(acceptanceFleet());
    const on = () => g.$$('.tabpage.on').map((el) => el.id);
    expect(on()).toEqual(['page-deck']);
    expect(g.$$('#tabs a.on').map((a) => a.getAttribute('href'))).toEqual(['#deck']);
    for (const tab of ['dispatches', 'traps', 'prs', 'notices', 'deck']) {
      await g.go('#' + tab);
      expect(on()).toEqual([`page-${tab}`]);
      expect(g.$$('#tabs a.on').map((a) => a.getAttribute('data-tab'))).toEqual([tab]);
    }
    await g.go('#no-such-tab');
    expect(on()).toEqual(['page-deck']);
  });

  it('a deep link lands on its tab; each tab shows only its own filters', async () => {
    const g = await page(acceptanceFleet(), { hash: '#dispatches' });
    expect(g.$$('.tabpage.on').map((el) => el.id)).toEqual(['page-dispatches']);
    expect(['f-lane', 'f-verb', 'chain-control', 'f-kind'].map((id) => shown(g, id))).toEqual([true, true, true, false]);
    await g.go('#notices');
    expect(['f-lane', 'f-verb', 'chain-control', 'f-kind'].map((id) => shown(g, id))).toEqual([false, false, false, true]);
    expect(shown(g, 'f-repo') && shown(g, 'f-q')).toBe(true);
  });

  it('renders a tab only once it is opened', async () => {
    const g = await page(acceptanceFleet());
    expect(g.$('#prs')!.innerHTML).toBe('');
    await g.go('#prs');
    expect(g.$$('#prs tr.rowhead')).toHaveLength(3);
  });
});

describe('glass page: per-section change detection', () => {
  it('a quiet poll fetches but rewrites nothing', async () => {
    const g = await page(acceptanceFleet(), { hash: '#dispatches' });
    const before = { chips: g.$('#chips .chip'), table: g.$('#dispatches table'), foot: g.$('#foot a'), lob: g.$('#lobs .lob') };
    const fetched = g.fetches();
    await g.poll();
    expect(g.fetches()).toBe(fetched + 1);
    expect(g.$('#chips .chip')).toBe(before.chips);
    expect(g.$('#dispatches table')).toBe(before.table);
    expect(g.$('#foot a')).toBe(before.foot);
    expect(g.$('#lobs .lob')).toBe(before.lob);
  });

  it('a change to one dispatch rewrites the dispatches section and leaves the header alone', async () => {
    const g = await page(acceptanceFleet(), { hash: '#dispatches' });
    const chip = g.$('#chips .chip');
    const table = g.$('#dispatches table');
    const d = acceptanceFleet();
    d.dispatches[1]!.note = 'a new note';
    g.serve(d);
    await g.poll();
    expect(g.$('#dispatches table')).not.toBe(table);
    expect(text(g.$('#dispatches'))).toContain('a new note');
    expect(g.$('#chips .chip')).toBe(chip);
  });

  it('ages tick in place without a rewrite', async () => {
    const g = await page(acceptanceFleet(), { hash: '#dispatches' });
    const age = () => g.$$('#dispatches tr.rowhead').find((tr) => text(tr).includes('cccccccc'))!.querySelector('[data-age]')!;
    const el = age();
    expect(el.textContent).toBe('4m');
    (g.window as unknown as { Date: DateConstructor }).Date.now = () => NOW + 60_000;
    await g.poll();
    expect(age()).toBe(el);
    expect(el.textContent).toBe('5m');
  });

  it('polls one request at a time, and not at all while the tab is hidden', async () => {
    const g = await page(acceptanceFleet());
    expect(g.intervals()).toEqual([2000]);
    const fetched = g.fetches();
    await Promise.all([g.poll(), g.poll()]);
    expect(g.fetches()).toBe(fetched + 1);
    await g.hide(true);
    expect(g.intervals()).toEqual([]);
    await g.hide(false);
    expect(g.intervals()).toEqual([2000]);
    expect(g.fetches()).toBe(fetched + 2);
  });

  it('a failed fetch shows the stale feed marker; the next good one clears it', async () => {
    const g = await page(acceptanceFleet());
    expect(shown(g, 'stale')).toBe(false);
    const w = g.window as unknown as { fetch: unknown };
    const good = w.fetch;
    w.fetch = async () => {
      throw new Error('down');
    };
    await g.poll();
    expect(shown(g, 'stale')).toBe(true);
    w.fetch = good;
    await g.poll();
    expect(shown(g, 'stale')).toBe(false);
  });
});

describe('glass page: modals', () => {
  it('an open modal keeps its node across ticks; only its own item changing rebuilds it', async () => {
    const g = await page(acceptanceFleet());
    const d = acceptanceFleet();
    const target = d.dispatches.find((x) => x.verb === 'needs-decision')!;
    await g.call('showModal', 'dispatch', `${target.lane}:${target.id}`);
    expect(g.$('#overlay')!.className).toBe('open');
    const title = g.$('#modalbox h3');
    expect(text(title)).toBe('cccccccc needs-decision');
    // Another dispatch changes: the modal is untouched.
    d.dispatches[0]!.note = 'elsewhere';
    g.serve(d);
    await g.poll();
    expect(g.$('#modalbox h3')).toBe(title);
    // Its own dispatch changes: the modal rebuilds with the new state.
    target.verb = 'working';
    g.serve(d);
    await g.poll();
    expect(text(g.$('#modalbox h3'))).toBe('cccccccc working');
  });

  it('Escape and a click outside close the modal; a vanished item closes it', async () => {
    const g = await page(acceptanceFleet());
    await g.call('showModal', 'trap', 't1');
    expect(text(g.$('#modalbox h3'))).toContain('wt:t1');
    g.document.dispatchEvent(new (g.window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent('keydown', { key: 'Escape' }));
    await g.settle();
    expect(g.$('#overlay')!.className).toBe('');
    await g.call('showModal', 'trap', 't1');
    await click(g, g.$('#overlay'));
    expect(g.$('#overlay')!.className).toBe('');
    await g.call('showModal', 'trap', 't1');
    const d = acceptanceFleet();
    d.traps = d.traps.filter((t) => t.trapId !== 't1');
    g.serve(d);
    await g.poll();
    expect(g.$('#overlay')!.className).toBe('');
  });

  it('a row click opens its dispatch; the modal offers copyable commands, never actions', async () => {
    const g = await page(acceptanceFleet(), { hash: '#dispatches' });
    await click(g, g.$$('#dispatches tr.rowhead').find((tr) => text(tr).includes('cccccccc'))!);
    expect(text(g.$('#modalbox h3'))).toBe('cccccccc needs-decision');
    const cmds = g.$$('#modalbox .cmd code').map(text);
    expect(cmds).toContain('wt:t1');
    expect(cmds).toContain('/tmp/shot.png');
    expect(g.$$('#modalbox form, #modalbox [method]')).toHaveLength(0);
  });

  it('the PR modal shows the stack, the dispatch chain, and the watch cursor', async () => {
    const g = await page(acceptanceFleet());
    await g.call('showModal', 'pr', 'pr:acme/web#42');
    const box = g.$('#modalbox')!;
    expect(text(box.querySelector('h3'))).toBe('#42 PR 42 checks 3/4');
    expect(text(box)).toContain('#41 → #42 → #43 · 2 of 3 · floor main · blocked by #41');
    expect(box.querySelector('b')?.textContent).toBe('#42');
    expect(g.$$('#modalbox .cmd code').map(text)).toEqual(['eyJoIjoiYWJjIn0-a-long-opaque-cursor']);
    // The chain links open the dispatch modals.
    await click(g, g.$$('#modalbox a').find((a) => text(a) === 'aaaaaaaa')!);
    expect(text(g.$('#modalbox h3'))).toBe('aaaaaaaa done');
  });

  it('⚙ opens settings; the view switch persists in this browser and applies everywhere', async () => {
    const g = await page(acceptanceFleet(), { hash: '#dispatches' });
    await click(g, g.$('#gearbtn'));
    expect(text(g.$('#modalbox h3'))).toBe('⚙ settings · this browser only');
    expect(text(g.$('#modalbox .settings .row:last-child'))).toContain('question · landed · pr:draft');
    await click(g, g.$$('#modalbox .seg button').find((b) => text(b) === 'cards')!);
    expect(JSON.parse(g.window.localStorage.getItem('spyglass')!).view).toBe('cards');
    expect(g.$$('#dispatches .card')).toHaveLength(4);
    expect(g.$$('#modalbox .seg button.on').map(text)).toEqual(['cards', 'on']);
  });
});

describe('glass page: PRs', () => {
  it('colors every PR badge with its GitHub state class', async () => {
    const g = await page(everyAttentionFleet(), { hash: '#prs', prefs: { view: 'cards' } });
    const badges = Object.fromEntries(g.$$('#prs .card').map((c) => [text(c.querySelector('b')).split(' ')[0], c.querySelector('.badge')!.className]));
    expect(badges).toEqual({
      '#41': 'badge pr-open',
      '#42': 'badge warn',
      '#43': 'badge pr-draft',
      '#50': 'badge pr-conflicts',
      '#60': 'badge bad',
      '#61': 'badge pr-behind',
      '#30': 'badge pr-merged',
    });
    expect(g.$$('#prs h2').map(text)).toContain('#41 → #42 → #43 · floor main');
    expect(g.$$('#prs h2').map(text)).toContain('#30 · floor main · history');
  });

  it('the PRs table groups by stack and never shows a watch cursor', async () => {
    const g = await page(acceptanceFleet(), { hash: '#prs' });
    expect(g.$$('#prs th[colspan]').map(text)).toEqual(['#41 → #42 → #43 · floor main · open']);
    const rows = g.$$('#prs tr.rowhead').map((tr) => [...tr.querySelectorAll('td')].map(text));
    expect(rows.map((r) => r[0])).toEqual(['#41', '#42', '#43']);
    expect(rows[0]![5]).toBe('CLEAN · next mergeable');
    expect(rows[1]![5]).toBe('CLEAN · blocked by #41');
    expect(rows[1]![6]).toBe('watching · 60s ago');
    expect(text(g.$('#prs'))).not.toContain('a-long-opaque-cursor');
    // Other (non-PR) watches list below, cursor shortened.
    expect(g.$$('#prs h2').map(text)).toEqual(['other watches']);
    expect(text(g.$$('#prs table')[1]!)).toContain('ci-nightly');
  });

  it('a dispatch row carries its PR link, evidence badge, and merge gate', async () => {
    const g = await page(acceptanceFleet(), { hash: '#dispatches' });
    const row = g.$$('#dispatches tr.rowhead').find((tr) => text(tr).includes('aaaaaaaa'))!;
    const cell = row.querySelectorAll('td')[7]!;
    expect(cell.querySelector('a')!.getAttribute('href')).toBe('https://github.com/acme/web/pull/41');
    expect([...cell.querySelectorAll('.badge')].map((b) => [b.className, text(b)])).toEqual([
      ['badge pr-open', 'green'],
      ['badge dim', 'waiting-approval'],
    ]);
  });
});

describe('glass page: On deck', () => {
  it('shows attention (no pr:* kinds), in flight, landed, traps, and PR stacks as five full-width sections', async () => {
    const g = await page(everyAttentionFleet());
    const sections = g.$$('#deck .deckgrid > section');
    expect(sections.map((s) => text(s.querySelector('h2')))).toEqual(['attention →', 'in flight →', 'Landed · 24h →', 'traps →', 'PRs →']);
    const kinds = [...sections[0]!.querySelectorAll('tr.rowhead td:first-child')].map(text);
    expect(kinds.every((k) => !k.startsWith('pr:') && !['draft', 'review', 'checks', 'conflicts', 'ready'].includes(k))).toBe(true);
    expect(text(sections[0]!.querySelector('.deckmore'))).toMatch(/^\+\d+ more →$/);
    // PR standing rides the stack line.
    expect(text(sections[4]!)).toContain('#41 → #42 → #43 · next #41');
    expect(text(sections[4]!.querySelector('.deckmore'))).toBe('+1 more →');
  });

  it('Landed · 24h: the newest eight catches, newest first, unreported badged, failed in red, nothing older', async () => {
    const g = await page(everyAttentionFleet());
    const landed = g.$$('#deck section')[2]!;
    const lines = [...landed.querySelectorAll('.deckline')];
    expect(lines).toHaveLength(8);
    expect(lines.map((l) => text(l.querySelector('b')).split(' ')[0])).toEqual(
      Array.from({ length: 8 }, (_, i) => `1${i}aaaaaa`),
    );
    expect(lines.map((l) => !!l.querySelector('.badge.unreported'))).toEqual([true, true, true, true, false, false, false, false]);
    expect(lines[2]!.querySelector('.badge')!.className).toBe('badge bad');
    expect(text(landed)).not.toContain('yesterday');
    expect(landed.querySelector('.deckmore')).toBeNull();
  });

  it('an empty window says none', async () => {
    const d = acceptanceFleet();
    d.landed = [{ ...d.landed[0]!, at: ago(25 * 3600_000) }];
    const g = await page(d);
    expect(text(g.$$('#deck section')[2]!.querySelector('.empty'))).toBe('none');
  });

  it('cards view: acked PR standing dims its card', async () => {
    const g = await page(everyAttentionFleet(), { prefs: { view: 'cards' } });
    const prs = g.$$('#deck section')[4]!;
    const cards = [...prs.querySelectorAll('.card')];
    expect(cards.map((c) => [text(c.querySelector('b')).split(' ')[0], c.className])).toContainEqual(['#42', 'card acked']);
    expect(text(prs.querySelector('.card .badge.pr-conflicts'))).toBe('conflicts');
  });

  it('an empty fleet: every section says none, the daemon is down', async () => {
    const g = await page(emptyFleet());
    expect(g.$$('#deck section .empty').map(text)).toEqual(['none', 'none', 'none', 'none', 'none']);
    expect(text(g.$('#chips'))).toBe('daemon down');
  });
});

describe('glass page: header', () => {
  it('the helm chip names the man and opens the helm modal with its resume command', async () => {
    const g = await page(acceptanceFleet());
    const chip = g.$('#chips .chip.click')!;
    expect(text(chip)).toBe('⛵ claude @ web helm fleet 30s ago');
    expect(chip.querySelector('.ok')).toBeTruthy();
    await click(g, chip);
    expect(text(g.$('#modalbox h3'))).toBe('⛵ claude @ web');
    expect(g.$$('#modalbox .cmd code').map(text)).toEqual([
      'claude --resume 7e740e13-aaaa-bbbb-cccc-000000000001',
      '/Users/me/.claude/projects/-Users-me-src-web/7e740e13.jsonl',
    ]);
  });

  it('a stale helm and daemon say so', async () => {
    const g = await page(everyAttentionFleet());
    expect(text(g.$('#chips .chip.click .warn'))).toBe('stale 45m ago');
    expect(text(g.$('#chips .chip .bad'))).toBe('stale 10m ago');
  });

  it('no helm, no chip', async () => {
    const g = await page(emptyFleet());
    expect(g.$$('#chips .chip.click')).toHaveLength(0);
  });

  it('the footer names the version and links the repo', async () => {
    const g = await page(acceptanceFleet());
    expect(text(g.$('#foot'))).toBe('🦞✨ lobstah v0.5.5 · aequitas-labs/lobstah');
    expect(g.$('#foot a')!.getAttribute('href')).toBe('https://github.com/aequitas-labs/lobstah');
  });
});

describe('glass page: lobs', () => {
  it('attention walks: a PR lob links out, a question lob opens its dispatch', async () => {
    const g = await page(acceptanceFleet());
    const lobs = g.$$('#lobs .lob');
    expect(lobs.map((l) => [l.tagName, text(l.querySelector('.bub'))])).toEqual([
      ['DIV', 'which base should #43 target?'],
      ['A', 'draft #43 draft'],
    ]);
    expect(lobs[1]!.getAttribute('href')).toBe('https://github.com/acme/web/pull/43');
    await click(g, lobs[0]!);
    expect(text(g.$('#modalbox h3'))).toBe('cccccccc needs-decision');
  });

  it('acked items do not walk; a clicked lob hides in this browser until its state changes', async () => {
    const g = await page(everyAttentionFleet());
    // Four walk at most, the last counting the rest; acked ones never do.
    const bubs = g.$$('#lobs .lob .bub').map(text);
    expect(bubs).toHaveLength(4);
    expect(bubs.join(' ')).not.toMatch(/landed item 1|pr:checks item 4|watch item 7/);
    await g.call('hideLob', 'work:extra0', 'x0');
    expect(JSON.parse(g.window.localStorage.getItem('spyglass-lob-hidden')!)).toEqual({ 'work:extra0': 'x0' });
    expect(g.$$('#lobs .lob .bub').map(text).join(' ')).not.toContain('extra question 0');
  });

  it('the lobs switch turns them off', async () => {
    const g = await page(acceptanceFleet(), { prefs: { lobs: false } });
    expect(g.$$('#lobs .lob')).toHaveLength(0);
    await g.call('setLobs', 'on');
    expect(g.$$('#lobs .lob')).toHaveLength(2);
  });
});

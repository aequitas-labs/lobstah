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
/** Open a modal the way a reader does: click its row on its tab. */
async function openRow(g: GlassDom, tab: string, label: string) {
  await g.go(tab);
  await click(g, g.$$(`#${tab.slice(1)} tr.rowhead`).find((tr) => text(tr).includes(label)) ?? null);
}
async function settings(g: GlassDom, row: 'view' | 'lobs', choice: string) {
  await click(g, g.$('#gearbtn'));
  const rowEl = g.$$('#modalbox .settings .row').find((r) => text(r.querySelector('.lbl')).startsWith(row))!;
  await click(g, [...rowEl.querySelectorAll('.seg button')].find((b) => text(b) === choice) ?? null);
}
const escape = async (g: GlassDom) => {
  g.document.dispatchEvent(new (g.window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent('keydown', { key: 'Escape' }));
  await g.settle();
};
/** Record every DOM mutation under the body while fn runs. */
async function mutations(g: GlassDom, fn: () => Promise<void>): Promise<MutationRecord[]> {
  const W = g.window as unknown as { MutationObserver: typeof MutationObserver };
  const seen: MutationRecord[] = [];
  const mo = new W.MutationObserver((records) => seen.push(...records));
  mo.observe(g.document.body as unknown as Node, { subtree: true, childList: true, attributes: true, characterData: true });
  await fn();
  seen.push(...mo.takeRecords());
  mo.disconnect();
  return seen;
}

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
    expect(await mutations(g, () => g.poll())).toEqual([]);
    expect(g.fetches()).toBe(fetched + 1);
    expect(g.$('#chips .chip')).toBe(before.chips);
    expect(g.$('#dispatches table')).toBe(before.table);
    expect(g.$('#foot a')).toBe(before.foot);
    expect(g.$('#lobs .lob')).toBe(before.lob);
  });

  it('a snapshot change to one dispatch re-renders only that row', async () => {
    const g = await page(acceptanceFleet(), { hash: '#dispatches' });
    const rowOf = (id: string) => g.$$('#dispatches tr.rowhead').find((tr) => text(tr).includes(id))!;
    const row = rowOf('bbbbbbbb');
    const others = g.$$('#dispatches tr.rowhead').filter((tr) => tr !== row);
    const d = acceptanceFleet();
    d.dispatches.find((x) => x.id.startsWith('bbbbbbbb'))!.note = 'a new note';
    g.serve(d);
    const seen = await mutations(g, () => g.poll());
    expect(seen.length).toBeGreaterThan(0);
    // Every mutation is inside the changed row: no other row, no header, no other section.
    expect(seen.filter((m) => !row.contains(m.target as never))).toEqual([]);
    expect(rowOf('bbbbbbbb')).toBe(row);
    expect(text(row)).toContain('a new note');
    expect(g.$$('#dispatches tr.rowhead').filter((tr) => tr !== row)).toEqual(others);
  });

  it('cards: a change to one dispatch touches only its card', async () => {
    const g = await page(acceptanceFleet(), { hash: '#dispatches', prefs: { view: 'cards' } });
    const card = g.$$('#dispatches .card').find((c) => text(c).includes('bbbbbbbb'))!;
    const d = acceptanceFleet();
    d.dispatches.find((x) => x.id.startsWith('bbbbbbbb'))!.verb = 'blocked';
    g.serve(d);
    const seen = await mutations(g, () => g.poll());
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((m) => !card.contains(m.target as never))).toEqual([]);
    expect(card.querySelector('.badge')!.className).toBe('badge v-blocked');
  });

  it('a new dispatch inserts one row and keeps every existing row node', async () => {
    const g = await page(acceptanceFleet(), { hash: '#dispatches' });
    const before = g.$$('#dispatches tr.rowhead');
    const d = acceptanceFleet();
    d.dispatches.unshift({ ...d.dispatches[0]!, id: 'eeeeeeee-0000-4000-8000-000000000009', note: 'fresh' });
    g.serve(d);
    await g.poll();
    const after = g.$$('#dispatches tr.rowhead');
    expect(after).toHaveLength(before.length + 1);
    expect(text(after[0]!)).toContain('eeeeeeee');
    expect(after.slice(1)).toEqual(before);
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
  it('an open modal keeps its root element across ten ticks; its own item changing updates it in place', async () => {
    const g = await page(acceptanceFleet());
    await openRow(g, '#dispatches', 'cccccccc');
    expect(g.$('#overlay')!.className).toBe('open');
    const root = g.$('#modalbox')!;
    const title = g.$('#modalbox h3')!;
    const secs = g.$$('#modalbox .sec');
    expect(text(title)).toBe('cccccccc needs-decision');
    const d = acceptanceFleet();
    for (let i = 0; i < 10; i++) {
      // Another dispatch changes every tick; the modal's nodes stay put.
      d.dispatches[0]!.note = `elsewhere ${i}`;
      g.serve(structuredClone(d));
      await g.poll();
      expect(g.$('#modalbox')).toBe(root);
      expect(g.$('#modalbox h3')).toBe(title);
      expect(g.$$('#modalbox .sec')).toEqual(secs);
    }
    // Its own dispatch changes: same nodes, new state.
    const own = structuredClone(d);
    own.dispatches.find((x) => x.id.startsWith('cccccccc'))!.verb = 'working';
    g.serve(own);
    const seen = await mutations(g, () => g.poll());
    expect(g.$('#modalbox h3')).toBe(title);
    expect(text(title)).toBe('cccccccc working');
    // The dispatches table row changed too; nothing outside the modal and that row moved.
    const row = g.$$('#dispatches tr.rowhead').find((tr) => text(tr).includes('cccccccc'))!;
    expect(seen.filter((m) => !root.contains(m.target as never) && !row.contains(m.target as never))).toEqual([]);
  });

  it('Escape and a click outside close the modal; a vanished item closes it', async () => {
    const g = await page(acceptanceFleet());
    await openRow(g, '#traps', 'wt:t1');
    expect(text(g.$('#modalbox h3'))).toContain('wt:t1');
    await escape(g);
    expect(g.$('#overlay')!.className).toBe('');
    await openRow(g, '#traps', 'wt:t1');
    // A click inside the modal keeps it open; a click on the backdrop closes it.
    await click(g, g.$('#modalbox .sub'));
    expect(g.$('#overlay')!.className).toBe('open');
    await click(g, g.$('#overlay'));
    expect(g.$('#overlay')!.className).toBe('');
    await openRow(g, '#traps', 'wt:t1');
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
    await openRow(g, '#prs', '#42');
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
    // Clicking a question lob opens its dispatch and hides that lob here.
    await click(g, g.$$('#lobs .lob').find((l) => text(l).includes('question item 0')) ?? null);
    expect(text(g.$('#modalbox h3'))).toBe('cccccccc needs-decision');
    expect(JSON.parse(g.window.localStorage.getItem('spyglass-lob-hidden')!)).toEqual({ 'work:cccccccc-0000-4000-8000-000000000003': 'h0' });
    expect(g.$$('#lobs .lob .bub').map(text).join(' ')).not.toContain('question item 0');
    // A new state hash walks it again.
    const d = everyAttentionFleet();
    d.attention[0]!.stateHash = 'h0-changed';
    g.serve(d);
    await g.poll();
    expect(g.$$('#lobs .lob .bub').map(text).join(' ')).toContain('question item 0');
  });

  it('the lobs switch turns them off', async () => {
    const g = await page(acceptanceFleet(), { prefs: { lobs: false } });
    expect(g.$$('#lobs .lob')).toHaveLength(0);
    await settings(g, 'lobs', 'on');
    expect(g.$$('#lobs .lob')).toHaveLength(2);
    expect(JSON.parse(g.window.localStorage.getItem('spyglass')!).lobs).toBe(true);
    await settings(g, 'lobs', 'off');
    expect(g.$$('#lobs .lob')).toHaveLength(0);
  });
});

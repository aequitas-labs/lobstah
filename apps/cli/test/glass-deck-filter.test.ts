import { afterEach, describe, expect, it } from 'vitest';
import { sectionInputs } from '../src/glass-diff.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, repoFilterFleet } from './fixtures/glass-snapshots.js';

const select = (repo: string) => ({ st: { view: 'table' as const, repo }, modal: null });
const inputs = (repo: string) => sectionInputs(repoFilterFleet(), select(repo), NOW);
let pages: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(pages.map((g) => g.close()));
  pages = [];
});
async function page(prefs: Record<string, unknown> = {}) {
  const g = await loadGlass(GLASS_PAGE, repoFilterFleet(), { now: NOW, prefs });
  pages.push(g);
  return g;
}
const text = (g: GlassDom, selector: string) => g.$(selector)?.textContent ?? '';

describe('deck repo filter', () => {
  it.each(['web', 'api'])('filters every deck section to %s, resolving dispatch links', (repo) => {
    const d = inputs(repo);
    expect(d.deck.decisions.map((c) => c.key).sort()).toEqual([`decision:${repo}`, `work:${repo}-work`]);
    expect(d.deck.decisions.map((c) => c.repo)).toEqual([repo, repo]);
    expect(d.deck.inflight.map((x) => x.id)).toEqual([`${repo}-work`, `${repo}-queued`]);
    expect(d.deck.landed.map((x) => x.id)).toEqual([`${repo}-work`]);
    expect(d.deck.reports.map((x) => x.title)).toEqual([`${repo} report`]);
    expect(d.deck.traps.map((x) => x.x.trapId)).toEqual([repo]);
    expect(d.deck.stacks.map((x) => x.repo)).toEqual([repo]);
    expect(d.deck.prs.map((x) => x.repo)).toEqual([repo]);
    expect(d.deck.prAttention.map((x) => x.repo)).toEqual([repo]);
    // Deck and dedicated tabs select the same repos, including linked reports.
    expect(d.deck.inflight).toEqual(d.dispatches.list);
    expect(d.deck.reports).toEqual(d.reports.list);
    expect(d.deck.traps).toEqual(d.traps.list);
    expect(d.deck.stacks).toEqual(d.prs.stacks);
    expect(d.deck.prs).toEqual(d.prs.prs);
    expect(d.notices.list.map((n) => n.text)).toEqual([`${repo} notice`, 'Global notice']);
  });

  it('keeps repo-less work with all repos, but not under a selected repo', () => {
    const all = inputs('');
    expect(all.deck.decisions).toHaveLength(5);
    expect(all.deck.reports).toHaveLength(3);
    expect(all.deck.traps).toHaveLength(3);
    const empty = inputs('empty').deck;
    for (const list of [empty.decisions, empty.inflight, empty.landed, empty.reports, empty.traps, empty.stacks, empty.prs, empty.prAttention])
      expect(list).toEqual([]);
  });

  it('uses the decision attention repo if its dispatch is no longer in the snapshot', () => {
    const d = repoFilterFleet();
    d.dispatches = [];
    d.attention.find((a) => a.key === 'decision:web')!.repo = 'web';
    expect(sectionInputs(d, select('web'), NOW).deck.decisions.map((c) => c.key)).toEqual(['decision:web']);
  });

  it('keeps a multi-PR stack together and filters before deck display limits', () => {
    const d = repoFilterFleet();
    const web = d.prs[0]!;
    d.prs.push({ ...web, key: 'pr:acme/web#43', number: 43, position: 1 });
    d.stacks[0]!.numbers.push(43);
    const [report, landed, trap] = [d.reports[1]!, d.landed[1]!, d.traps[1]!] as const;
    for (let i = 0; i < 12; i++) {
      d.reports.unshift({ ...report, key: `report:api:${i}` });
      d.landed.unshift({ ...landed, key: `work:api:${i}` });
      d.traps.unshift({ ...trap, trapId: `api-${i}` });
    }
    const filtered = sectionInputs(d, select('web'), NOW).deck;
    expect(filtered.stacks.map((s) => s.numbers)).toEqual([[41, 43]]);
    expect(filtered.prs.map((p) => p.number)).toEqual([41, 43]);
    expect(filtered.landed).toHaveLength(1);
    expect(filtered.reports).toHaveLength(1);
    expect(filtered.traps).toHaveLength(1);
  });

  it('opens a direct decision link without losing a saved repo filter', async () => {
    const g = await page({ repo: 'web' });
    await g.go('#decision/decision%3Aapi');
    expect(text(g, '.dmodal')).toContain('api decision');
    expect((g.$('#f-repo') as HTMLSelectElement).value).toBe('web');
  });

  it.each(['table', 'cards'])('filters rendered %s rows, badges and alerts through polls and reloads', async (view) => {
    const g = await page({ view });
    const filter = g.$('#f-repo') as HTMLSelectElement;
    filter.value = 'web';
    filter.dispatchEvent(new g.window.Event('change'));
    await g.settle();
    const check = (p: GlassDom) => {
      expect(text(p, '#deck')).toContain('web report');
      expect(text(p, '#deck')).not.toMatch(/api|Global|global-crab/);
      expect(p.$$('#deck .drow')).toHaveLength(2);
      expect(text(p, '#deck .dbadge')).toBe('2');
      expect(text(p, '.dalert')).toContain('2 new decisions');
      expect((p.$('#f-repo') as HTMLSelectElement).value).toBe('web');
    };
    check(g);
    const updated = repoFilterFleet();
    updated.reports.push({ ...updated.reports[1]!, key: 'report:api:later', title: 'api later' });
    g.serve(updated);
    await g.poll();
    check(g);
    const prefs = JSON.parse(g.window.localStorage.getItem('spyglass')!);
    const reload = await page(prefs);
    check(reload);
    filter.value = 'empty';
    filter.dispatchEvent(new g.window.Event('change'));
    await g.settle();
    expect(g.$$('#deck .empty')).toHaveLength(6);
    expect(g.$$('#deck .deckmore, #deck .dbadge, #tabs .dbadge, .dalert')).toHaveLength(0);
  });
});

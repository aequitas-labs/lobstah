import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GlassSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom, GlassDomOptions } from './glass-dom.js';
import { NOW, PR_TITLES, acceptanceFleet, ago, emptyFleet, everyAttentionFleet, trapStatesFleet } from './fixtures/glass-snapshots.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * The spyglass page, tested as a page: the built HTML loads into happy-dom,
 * /data answers with a fixture snapshot, and every assertion reads the DOM.
 */

let open: GlassDom[] = [];
let home: string;
it.each([
  ['linear', 'https://linear.review/acme/web/pull/'],
  ['linear-app', 'linear://review/acme/web/pull/'],
])('routes PR links to %s without changing report or decision links', async (tool, prefix) => {
  const fixture = acceptanceFleet();
  fixture.reviewTools = { 'acme/web': tool! };
  const g = await loadGlass(GLASS_PAGE, fixture, { now: NOW });
  open.push(g);
  await g.go('#prs');
  const links = g.$$('a').map((a) => a.getAttribute('href') ?? '');
  expect(links.some((url) => url.startsWith(prefix!))).toBe(true);
  expect(links.filter((url) => /^https:\/\/github.com\/acme\/web\/pull\//.test(url))).toEqual([]);
  expect(g.$$('#lobs a').some((a) => (a.getAttribute('href') ?? '').startsWith(prefix!))).toBe(true);
});
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-glass-page-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});
async function page(d: GlassSnapshot, opts: Partial<GlassDomOptions> = {}): Promise<GlassDom> {
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, ...opts });
  open.push(g);
  return g;
}
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
/** A stack heading without its Ack stack control (glass-pr-ack.test.ts tests that). */
const heading = (el: Element): Element => {
  const copy = el.cloneNode(true) as Element;
  for (const n of copy.querySelectorAll('.prack')) n.remove();
  return copy;
};
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
  it('badges open cards from the unfiltered snapshot and clears at zero', async () => {
    const d = emptyFleet();
    d.attention = [1, 2].map((n) => ({ kind: 'question', key: `work:q${n}`, id: `q${n}`, lane: 'work', verb: 'needs-decision', note: 'Choose', ageSecs: 0, stateHash: String(n) }));
    const badges: number[] = [];
    const g = await page(d, { badge: async (n) => { badges.push(n); }, prefs: { repo: 'another-repo' } });
    expect(badges).toEqual([2]);
    g.serve(emptyFleet()); await g.poll();
    expect(badges.at(-1)).toBe(0);
  });
  it('keeps updating when the browser refuses an app badge', async () => {
    const g = await page(emptyFleet(), { badge: async () => { throw new Error('not allowed'); } });
    await g.poll();
    expect(g.$('#deck')).toBeTruthy();
    expect(g.fetches()).toBeGreaterThan(1);
  });
  it('shows working, idle, and parked traps on deck and tab, with a dispatch link', async () => {
    const d = acceptanceFleet();
    const working = d.dispatches.find((x) => x.id.startsWith('cccccccc'))!;
    working.verb = 'working';
    working.brief = 'Polish the glass trap deck\nMore detail';
    working.activity = { at: ago(12_000), kind: 'tool', summary: 'Bash', ageSecs: 12, stale: false };
    const parked = {
      ...working,
      id: 'eeeeeeee-0000-4000-8000-000000000005',
      verb: 'paused' as const,
      waiting: { on: 'review', since: ago(3 * 60_000), waitedSecs: 180 },
    };
    d.dispatches.push(parked);
    const live = d.traps[0]!;
    live.listening = true;
    const idle = { ...live, trapId: 'idle', label: 'idle trap', claimed: undefined, catches: [], listening: false, heartbeatAt: ago(45 * 60_000) };
    const waiting = { ...live, trapId: 'parked', label: 'parked trap', claimed: parked.id, catches: [parked.id] };
    d.traps = [live, idle, waiting];
    const g = await page(d, { hash: '#deck', prefs: { view: 'table' } });
    const deck = g.$$('#deck section')[4]!;
    expect(text(deck)).toContain('working · cccccccc · Polish the glass trap deck · Bash 12s ago');
    expect(text(deck)).toContain('idle · not listening');
    expect(text(deck)).toContain('parked · waiting on review');
    await click(g, deck.querySelector('a[href="#dispatches"]'));
    expect(text(g.$('#modalbox h3'))).toBe('cccccccc working');
    await g.go('#traps');
    const rows = g.$$('#traps tr.rowhead');
    expect(rows.map(text).join(' ')).toContain('working · cccccccc · Polish the glass trap deck · Bash 12s ago');
    expect(rows.map(text).join(' ')).toContain('idle · not listening');
    expect(rows.map(text).join(' ')).toContain('parked · waiting on review');
  });

  it('leads each trap state line with a green, amber, or grey dot on deck, cards, and table', async () => {
    const want: Record<string, [string, string]> = {
      'working trap': ['ok', 'working · '],
      'listening trap': ['ok', 'idle · listening'],
      'parked trap': ['warn', 'parked · waiting on review'],
      'stale trap': ['dim', 'idle · not listening'],
    };
    /** The state dot's tone and its line's text, per trap label, in one tab's items. */
    const dots = (items: Element[]) =>
      Object.fromEntries(
        items.map((el) => {
          const dot = el.querySelector('.trapdot')!;
          const tone = [...dot.classList].filter((c) => c !== 'dot' && c !== 'trapdot').join(' ');
          const label = Object.keys(want).find((l) => text(el).includes(l))!;
          return [label, [tone, text(dot.parentElement)]];
        }),
      );
    const check = (got: Record<string, [string, string]>) => {
      expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
      for (const [label, [tone, line]] of Object.entries(want)) {
        expect(got[label]![0], label).toBe(tone);
        expect(got[label]![1], label).toContain(line);
      }
    };
    const g = await page(trapStatesFleet(), { hash: '#deck', prefs: { view: 'table' } });
    check(dots([...g.$$('#deck section')[4]!.querySelectorAll('.deckline')]));
    await g.go('#traps');
    check(dots(g.$$('#traps tr.rowhead')));
  });

  it("shows each trap card's state as a lowercase chip in the dot's tone, and its work on the third line", async () => {
    const want: Record<string, [string, string, string]> = {
      'working trap': ['ok', 'working', ''],
      'listening trap': ['ok', 'idle', 'listening for work'],
      'parked trap': ['warn', 'waiting', 'waiting on review'],
      'stale trap': ['dim', 'idle', 'not listening'],
    };
    const chips = (cards: Element[]) =>
      Object.fromEntries(
        cards.map((el) => {
          const chip = el.querySelector('.gchip')!;
          const tone = [...chip.classList].filter((c) => c !== 'gchip').join(' ');
          const label = Object.keys(want).find((l) => text(el).includes(l))!;
          return [label, [tone, text(chip), text(el.querySelector('.gnow'))]];
        }),
      );
    const check = (got: Record<string, [string, string, string]>) => {
      expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
      for (const [label, [tone, word, now]] of Object.entries(want)) {
        expect(got[label]![0], label).toBe(tone);
        expect(got[label]![1], label).toBe(word);
        expect(got[label]![2], label).toContain(now);
      }
    };
    const g = await page(trapStatesFleet(), { hash: '#deck', prefs: { view: 'cards' } });
    check(chips([...g.$$('#deck section')[4]!.querySelectorAll('.card')]));
    await g.go('#traps');
    check(chips(g.$$('#traps .card')));
  });

  it.each(['claude', 'codex'].flatMap((harness) => (['table', 'cards'] as const).map((view) => ({ harness, view }))))('copies a signed-off $harness resume command in the modal only, not on $view or deck', async ({ harness, view }) => {
    const d = acceptanceFleet();
    d.viewer = { onMachine: true, windowFocus: true, machine: 'studio', device: 'desktop' };
    const trap = d.traps.find((t) => t.trapId === 't2')!;
    trap.harness = harness;
    trap.sessionId = 'past-session';
    const command = (harness === 'codex' ? 'codex resume ' : 'claude --resume ') + trap.sessionId;
    const g = await page(d, { hash: '#traps', prefs: { view } });
    const writes: string[] = [];
    g.window.navigator.clipboard.writeText = async (value: string) => { writes.push(value); };
    expect(text(g.$('#traps'))).not.toContain(command);
    expect(g.$$('#traps .cmd')).toHaveLength(0);
    await g.go('#deck');
    // Only recently signed-off traps are listed on deck.
    expect(text(g.$('#deck'))).toContain('wt:t2');
    expect(text(g.$('#deck'))).not.toContain(command);
    expect(g.$$('#deck .cmd')).toHaveLength(0);
    await g.go('#traps');
    await click(g, g.$$('#traps b').find((el) => text(el).endsWith('wt:t2'))!);
    const row = g.$$('#modalbox .cmd').find((el) => text(el).includes(command))!;
    const button = row.querySelector('button')! as HTMLElement;
    button.click();
    // Read confirmation before the page harness waits for its one-second reset.
    for (let i = 0; i < 10 && button.textContent !== '✓'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(button.textContent).toBe('✓');
    expect(writes.at(-1)).toBe(command);
    await g.settle();
    expect(g.$('#overlay')!.className).toBe('open');
  }, 15_000);

  it.each(['claude', 'codex'])('offers no resume for a live %s trap, and copies the helm resume command', async (harness) => {
    const d = acceptanceFleet();
    d.viewer = { onMachine: true, windowFocus: true, machine: 'studio', device: 'desktop' };
    d.traps[0]!.harness = harness;
    d.helms[0]!.harness = harness;
    const g = await page(d, { hash: '#traps' });
    const writes: string[] = [];
    g.window.navigator.clipboard.writeText = async (value: string) => { writes.push(value); };
    const prefix = harness === 'codex' ? 'codex resume ' : 'claude --resume ';
    await openRow(g, '#traps', 'wt:t1');
    expect(text(g.$('#modalbox'))).not.toContain(prefix);
    expect(text(g.$('#modalbox'))).not.toContain('open this session');
    await escape(g);
    await click(g, g.$('#chips .chip.click'));
    await click(g, g.$('#modalbox .cmd button'));
    expect(writes.at(-1)).toBe(prefix + d.helms[0]!.sessionId);
  });

  it.each(['claude', 'codex'].flatMap((harness) => (['table', 'cards'] as const).map((view) => ({ harness, view }))))('opens a signed-off $harness desktop link from $view and deck, and copies it in the modal only', async ({ harness, view }) => {
    const d = acceptanceFleet();
    d.viewer = { onMachine: true, windowFocus: true, machine: 'studio', device: 'desktop' };
    const trap = d.traps.find((t) => t.trapId === 't2')!;
    Object.assign(trap, { harness, sessionId: 'past-session', link: harness === 'codex' ? 'codex://threads/past-session' : 'claude://claude.ai/past-session', window: { entrypoint: 'claude-desktop' } });
    const g = await page(d, { hash: '#traps', prefs: { view } });
    const writes: string[] = [];
    g.window.navigator.clipboard.writeText = async (value: string) => { writes.push(value); };
    const card = async (selector: string) => {
      const open = g.$$(selector + ' a.btn.open').filter((a) => a.getAttribute('href') === trap.link);
      expect(open).toHaveLength(1);
      expect(text(open[0])).toBe('↗ Open');
      expect(text(g.$(selector))).not.toContain(trap.link!);
      expect(text(g.$(selector))).not.toContain('desktop thread');
      expect(g.$$(selector + ' .cmd')).toHaveLength(0);
      await click(g, open[0]!);
      expect(g.$('#overlay')!.className).toBe('');
    };
    await card('#traps');
    await g.go('#deck');
    await card('#deck');
    await g.go('#traps');
    await click(g, g.$$('#traps b').find((el) => text(el).endsWith('wt:t2'))!);
    const row = g.$$('#modalbox .cmd').find((el) => text(el).includes(trap.link!))!;
    expect(text(row)).toContain('desktop thread:');
    expect(row.querySelector('a')?.getAttribute('href')).toBe(trap.link);
    expect(text(g.$('#modalbox'))).not.toContain(harness === 'codex' ? 'codex resume ' : 'claude --resume ');
    await click(g, row.querySelector('button'));
    expect(writes.at(-1)).toBe(trap.link);
  }, 15_000);

  it('keeps the ↗ Open button on a live desktop trap card and its link in the modal', async () => {
    const d = acceptanceFleet();
    d.viewer = { onMachine: true, windowFocus: true, machine: 'studio', device: 'desktop' };
    d.focusToken = 'fixture-token';
    Object.assign(d.traps[0]!, { harness: 'codex', link: 'codex://threads/live-session' });
    const g = await page(d, { hash: '#traps', prefs: { view: 'cards' } });
    const card = g.$$('#traps .card').find((el) => text(el).includes('wt:t1'))!;
    expect(text(card.querySelector('.gaction'))).toBe('↗ Open');
    expect(text(card)).not.toContain('codex://threads/live-session');
    expect(card.querySelectorAll('.cmd')).toHaveLength(0);
    await click(g, card);
    expect(text(g.$('#modalbox'))).toContain('codex://threads/live-session');
    expect(g.$$('#modalbox .cmd').filter((el) => text(el).includes('codex://threads/live-session'))).toHaveLength(1);
  });

  it('does not offer a CLI command for live desktop traps or the helm without a link', async () => {
    const d = acceptanceFleet();
    d.viewer = { onMachine: true, windowFocus: true, machine: 'studio', device: 'desktop' };
    d.traps[0]!.desktopThread = true;
    d.traps[0]!.harness = 'codex';
    d.helms[0]!.desktopThread = true;
    d.helms[0]!.harness = 'codex';
    const g = await page(d, { hash: '#traps' });
    await openRow(g, '#traps', 'wt:t1');
    expect(text(g.$('#modalbox'))).toContain('desktop thread — open in the app');
    expect(text(g.$('#modalbox'))).not.toContain('codex resume');
    await escape(g);
    await click(g, g.$('#chips .chip.click'));
    expect(text(g.$('#modalbox'))).toContain('desktop thread — open in the app');
    expect(text(g.$('#modalbox'))).not.toContain('codex resume');
  });

  it('copies the attach command from a live tmux trap modal, and never from its card', async () => {
    const d = acceptanceFleet();
    d.viewer = { onMachine: true, windowFocus: true, machine: 'studio', device: 'desktop' };
    d.traps[0]!.attachCommand = 'tmux -L lobstah attach -t %7';
    const g = await page(d, { hash: '#traps' });
    const writes: string[] = [];
    g.window.navigator.clipboard.writeText = async (value: string) => { writes.push(value); };
    expect(text(g.$('#traps'))).not.toContain('attach -t');
    await openRow(g, '#traps', 'wt:t1');
    const row = g.$$('#modalbox .cmd').find((el) => text(el).includes('attach -t %7'))!;
    await click(g, row.querySelector('button'));
    expect(writes.at(-1)).toBe('tmux -L lobstah attach -t %7');
  });

  it('tells an off-machine desktop where a live trap runs and keeps the attach command, without a session link', async () => {
    const d = acceptanceFleet();
    d.viewer = { onMachine: false, windowFocus: false, machine: 'studio', device: 'desktop' };
    const trap = d.traps[0]!;
    const foot = async () => {
      const g = await page(d, { hash: '#traps', prefs: { view: 'cards' } });
      expect(g.$$('#traps button.open')).toHaveLength(0);
      return g.$$('#traps .card').find((c) => text(c).includes('wt:t1'))!;
    };
    // The card names the boat; it never says where the trap is only reachable from (the modal does).
    expect(text((await foot()).querySelector('.gfoot'))).toContain('⛵ studio');
    expect(text(await foot())).not.toContain('only reachable');
    trap.attachCommand = 'ssh studio -t tmux -L lobstah attach -r -t %7';
    expect(text((await foot()).querySelector('.gfoot'))).toContain('⛵ studio');
    expect(text(await foot())).not.toContain('only reachable');
    const attach = await page(d, { hash: '#traps' });
    await openRow(attach, '#traps', 'wt:t1');
    expect(attach.$$('#modalbox .cmd').map(text).join()).toContain('attach -r -t %7');
    expect(text(attach.$('#modalbox'))).toContain('This glass is read-only from here');
    trap.attachCommand = undefined;
    Object.assign(trap, { harness: 'codex', link: 'codex://threads/live-session' });
    const card = await foot();
    expect(text(card.querySelector('.gfoot'))).toContain('⛵ studio');
    expect(text(card)).not.toContain('only reachable');
    expect(card.querySelector('a[href^="codex:"]')).toBeNull();
    const desktopTrap = await page(d, { hash: '#traps' });
    await openRow(desktopTrap, '#traps', 'wt:t1');
    expect(desktopTrap.$$('#modalbox a[href^="codex:"]')).toHaveLength(0);
    expect(text(desktopTrap.$('#modalbox'))).not.toContain('open this session');
  });

  for (const device of ['phone', 'unknown'] as const) {
    it(`shows a ${device} only where a trap runs, its state and the read-only notice`, async () => {
      const d = acceptanceFleet();
      d.viewer = { onMachine: false, windowFocus: false, machine: 'studio', device };
      const trap = d.traps[0]!;
      const modal = async () => {
        const g = await page(d, { hash: '#traps' });
        await openRow(g, '#traps', 'wt:t1');
        const box = g.$('#modalbox');
        expect(text(box)).toContain('Running on studio, only reachable from there');
        expect(text(box)).toContain('live');
        expect(text(box)).toContain('This glass is read-only from here');
        expect(text(box)).not.toContain('open this session');
        expect(text(box)).not.toContain('Session link');
        expect(g.$$('#modalbox a[href^="claude:"], #modalbox a[href^="codex:"], #modalbox a[href^="vscode:"]')).toHaveLength(0);
        expect(text(box)).not.toContain('attach -r');
      };
      trap.attachCommand = 'ssh studio -t tmux -L lobstah attach -r -t %7';
      await modal();
      trap.attachCommand = undefined;
      for (const link of ['claude://claude.ai/local_1', 'codex://threads/live-session', 'vscode://anthropic.claude-code/open?session=abc']) {
        Object.assign(trap, { harness: link.startsWith('codex') ? 'codex' : 'claude', link });
        await modal();
      }
    });
  }

  it('offers a phone no resume command or open button for a signed-off trap, and none for a helm', async () => {
    const d = acceptanceFleet();
    d.viewer = { onMachine: false, windowFocus: false, machine: 'studio', device: 'phone' };
    Object.assign(d.traps[0]!, { live: false, harness: 'codex', link: 'codex://threads/gone', sessionId: 'gone' });
    const signedOff = await page(d, { hash: '#traps' });
    await openRow(signedOff, '#traps', 'wt:t1');
    expect(text(signedOff.$('#modalbox'))).toContain('Signed off — no window');
    expect(text(signedOff.$('#modalbox'))).not.toContain('open this session');
    expect(signedOff.$$('#modalbox a[href^="codex:"]')).toHaveLength(0);
    Object.assign(d.traps[0]!, { harness: 'claude', link: undefined });
    const command = await page(d, { hash: '#traps' });
    await openRow(command, '#traps', 'wt:t1');
    expect(text(command.$('#modalbox'))).not.toContain('claude --resume');
  });

  describe('a live Claude link', () => {
    const LIVE = 'https://claude.ai/code/session_01AbC';
    const open = async (viewer: GlassSnapshot['viewer'], over: Record<string, unknown> = {}) => {
      const d = acceptanceFleet();
      d.viewer = viewer;
      d.focusToken = viewer?.onMachine ? 'fixture-token' : undefined;
      Object.assign(d.traps[0]!, { harness: 'claude', liveLink: LIVE, ...over });
      const g = await page(d, { hash: '#traps' });
      await openRow(g, '#traps', 'wt:t1');
      return g;
    };
    const links = (g: GlassDom) => g.$$(`#modalbox a[href="${LIVE}"]`);

    for (const device of ['phone', 'desktop', 'unknown'] as const) {
      it(`opens from a ${device} off the machine, in a new tab, with where it runs`, async () => {
        const g = await open({ onMachine: false, windowFocus: false, machine: 'studio', device });
        const [link] = links(g);
        expect(links(g)).toHaveLength(1);
        expect(text(link)).toBe('Open live in Claude');
        expect(text(link!.parentElement)).toContain('any device');
        expect(link?.querySelector('.harness-icon')).toBeNull();
        expect(link!.getAttribute('target')).toBe('_blank');
        expect(link!.getAttribute('rel')).toContain('noopener');
        expect(text(g.$('#modalbox'))).toContain('Running on studio');
        expect(text(g.$('#modalbox'))).not.toContain('only reachable');
        expect(text(g.$('#modalbox'))).toContain('Opens in the Claude app or a browser');
        expect(text(g.$('#modalbox'))).toContain('This glass is read-only from here');
      });
    }

    it('keeps the rule for what else a phone sees: no attach command or desktop link beside it', async () => {
      const g = await open({ onMachine: false, windowFocus: false, machine: 'studio', device: 'phone' }, { attachCommand: 'ssh studio -t tmux -L lobstah attach -r -t %7', link: 'claude://claude.ai/local_1' });
      expect(links(g)).toHaveLength(1);
      expect(text(g.$('#modalbox'))).not.toContain('attach -r');
      expect(g.$$('#modalbox a[href^="claude:"]')).toHaveLength(0);
    });

    it('sits beside the attach command for a desktop off the machine', async () => {
      const g = await open({ onMachine: false, windowFocus: false, machine: 'studio', device: 'desktop' }, { attachCommand: 'ssh studio -t tmux -L lobstah attach -r -t %7' });
      expect(links(g)).toHaveLength(1);
      expect(text(g.$('#modalbox'))).toContain('attach -r -t %7');
    });

    it('sits beside open on the machine', async () => {
      const g = await open({ onMachine: true, windowFocus: true, machine: 'studio', device: 'desktop' });
      expect(links(g)).toHaveLength(1);
      expect(g.$$('#modalbox button.open')).toHaveLength(1);
      expect(text(g.$('#modalbox'))).not.toContain('read-only');
    });

    it('shows on the trap card and the deck, not only in the modal', async () => {
      const d = acceptanceFleet();
      d.viewer = { onMachine: false, windowFocus: false, machine: 'studio', device: 'phone' };
      Object.assign(d.traps[0]!, { harness: 'claude', liveLink: LIVE });
      const g = await page(d, { hash: '#traps', prefs: { view: 'cards' } });
      expect(g.$$(`#traps a[href="${LIVE}"]`)).toHaveLength(1);
    });

    it('says why when two processes hold the session, with no link to tap', async () => {
      const g = await open({ onMachine: false, windowFocus: false, machine: 'studio', device: 'phone' }, { liveLink: undefined, sessionWriters: [6882, 2669] });
      expect(links(g)).toHaveLength(0);
      expect(text(g.$('#modalbox'))).toContain('Processes 6882 and 2669 both hold this session');
    });

    it('gives a signed-off trap no live link', async () => {
      const g = await open({ onMachine: false, windowFocus: false, machine: 'studio', device: 'phone' }, { live: false, liveLink: undefined });
      expect(links(g)).toHaveLength(0);
      expect(text(g.$('#modalbox'))).not.toContain('Opens in the Claude app');
    });

    it('offers a Codex trap on a phone no action at all', async () => {
      const g = await open({ onMachine: false, windowFocus: false, machine: 'studio', device: 'phone' }, { harness: 'codex', liveLink: undefined, link: 'codex://threads/live-session', desktopThread: true });
      expect(g.$$('#modalbox a[href^="codex:"], #modalbox a[href^="https://chatgpt"], #modalbox button.open')).toHaveLength(0);
      expect(text(g.$('#modalbox'))).toContain('Running on studio, only reachable from there');
      expect(text(g.$('#modalbox'))).not.toContain('open this session');
    });
  });

  it('offers a phone no attach command in a dispatch modal', async () => {
    const d = acceptanceFleet();
    const x = d.dispatches.find((c) => !c.claimedBy?.startsWith('wt:'))!;
    const modal = async (device: 'phone' | 'desktop') => {
      d.viewer = { onMachine: false, windowFocus: false, machine: 'studio', device };
      const g = await page(d, { hash: '#dispatches' });
      await openRow(g, '#dispatches', x.id.slice(0, 8));
      return text(g.$('#modalbox'));
    };
    expect(await modal('desktop')).toContain(`lobstah attach ${x.id}`);
    expect(await modal('phone')).not.toContain('lobstah attach');
  });

  it('hides links and attach from a phone on a forward that keeps the address, and leaves open working', async () => {
    const d = acceptanceFleet();
    d.viewer = { onMachine: true, windowFocus: true, machine: 'studio', device: 'phone' };
    d.traps[0]!.attachCommand = 'tmux -L lobstah attach -t %7';
    const g = await page(d, { hash: '#traps' });
    await openRow(g, '#traps', 'wt:t1');
    expect(g.$$('#modalbox button.open')).toHaveLength(1);
    expect(text(g.$('#modalbox'))).not.toContain('attach -t');
    expect(text(g.$('#modalbox'))).not.toContain('read-only');
  });

  it('shows one copyable desktop link in a live trap modal', async () => {
    const d = acceptanceFleet();
    d.viewer = { onMachine: true, windowFocus: true, machine: 'studio', device: 'desktop' };
    Object.assign(d.traps[0]!, { harness: 'codex', link: 'codex://threads/live-session' });
    const g = await page(d, { hash: '#traps' });
    await openRow(g, '#traps', 'wt:t1');
    const links = g.$$('#modalbox a').filter((a) => a.getAttribute('href') === d.traps[0]!.link);
    expect(links).toHaveLength(1);
    expect(text(g.$('#modalbox'))).toContain('desktop thread:');
    expect(text(g.$('#modalbox'))).not.toContain('codex resume');
  });

  describe('one Open per trap row, every route in the modal', () => {
    const LIVE = 'https://claude.ai/code/session_01AbC';
    const fleet = (viewer: GlassSnapshot['viewer']) => {
      const d = acceptanceFleet();
      d.viewer = viewer;
      d.focusToken = viewer?.onMachine ? 'fixture-token' : undefined;
      Object.assign(d.traps[0]!, {
        harness: 'claude',
        liveLink: LIVE,
        link: 'vscode://anthropic.claude-code/open?session=abc',
        attachCommand: 'tmux -L lobstah attach -t %7',
      });
      return d;
    };
    const opens = (root: Element | null | undefined) => [...(root?.querySelectorAll('.btn.open') ?? [])];
    const trapRow = (g: GlassDom, selector: string) => g.$$(selector).find((el) => text(el).includes('wt:t1'));

    it("raises the window from the one row button on the trap's Mac, and lists every route in the modal", async () => {
      const d = fleet({ onMachine: true, windowFocus: true, machine: 'studio', device: 'desktop' });
      for (const [view, selector] of [['table', '#traps tr.rowhead'], ['cards', '#traps .card']] as const) {
        const g = await page(d, { hash: '#traps', prefs: { view } });
        const row = trapRow(g, selector);
        expect(opens(row).map(text), view).toEqual(['↗ Open']);
        expect(opens(row)[0]!.tagName, view).toBe('BUTTON');
        expect(text(row), view).not.toContain('Open live');
        expect(text(row), view).not.toContain('Session link');
      }
      const modal = await page(d, { hash: '#traps' });
      await openRow(modal, '#traps', 'wt:t1');
      expect(modal.$$('#modalbox .route').map(text)).toEqual([
        'Raise window on this Mac',
        'Open live in Claude any device',
        'Session link opens its app on this Mac',
        'attach:tmux -L lobstah attach -t %7⧉',
      ]);
    });

    it('opens the live link from the one row button off the machine', async () => {
      const d = fleet({ onMachine: false, windowFocus: false, machine: 'studio', device: 'phone' });
      const g = await page(d, { hash: '#traps', prefs: { view: 'cards' } });
      const card = trapRow(g, '#traps .card');
      expect(opens(card).map(text)).toEqual(['↗ Open']);
      expect(opens(card)[0]!.getAttribute('href')).toBe(LIVE);
      expect(text(card.querySelector('.gfoot'))).toContain('⛵ studio');
      const modal = await page(d, { hash: '#traps' });
      await openRow(modal, '#traps', 'wt:t1');
      expect(modal.$$('#modalbox .route').map(text)).toEqual(['Open live in Claude any device']);
    });

    it('opens the live link from the one row button on the Mac when this source cannot raise windows', async () => {
      const d = fleet({ onMachine: true, windowFocus: false, machine: 'studio', device: 'desktop' });
      Object.assign(d.traps[0]!, { link: undefined });
      const g = await page(d, { hash: '#traps', prefs: { view: 'cards' } });
      const card = trapRow(g, '#traps .card');
      expect(opens(card).map(text)).toEqual(['↗ Open']);
      expect(opens(card)[0]!.getAttribute('href')).toBe(LIVE);
    });
  });

  it('gives a signed-off trap a grey state dot', async () => {
    const g = await page(acceptanceFleet(), { hash: '#traps', prefs: { view: 'table' } });
    const t2 = g.$$('#traps tr.rowhead').find((tr) => text(tr).includes('wt:t2'))!;
    expect([...t2.querySelector('.trapdot')!.classList]).toEqual(['dot', 'trapdot', 'dim']);
  });

  it('shows the ↗ Open button on live traps in the table, cards, deck, and modal only', async () => {
    const d = acceptanceFleet();
    d.viewer = { onMachine: true, windowFocus: true, machine: 'studio', device: 'desktop' };
    d.focusToken = 'fixture-token';
    d.traps.find((t) => t.trapId === 't2')!.sessionId = 'past-session';
    d.traps.find((t) => t.trapId === 't2')!.harness = 'codex';
    const g = await page(d, { hash: '#traps' });
    const t1 = g.$$('#traps tr.rowhead').find((tr) => text(tr).includes('wt:t1'))!;
    const t2 = g.$$('#traps tr.rowhead').find((tr) => text(tr).includes('wt:t2'))!;
    expect(text(t1)).toContain('↗ Open');
    expect(text(t2)).not.toContain('↗ Open');
    expect(text(t2)).not.toContain('codex resume past-session');
    await click(g, t1.querySelector('button'));
    expect(g.$('#overlay')!.className).toBe('');
    await click(g, t1);
    expect(text(g.$('#modalbox'))).toContain('Raise window on this Mac');
    await escape(g);
    await g.go('#deck');
    expect(text(g.$('#deck'))).toContain('↗ Open');
    await g.go('#traps');
    const cardPage = await page(d, { hash: '#traps', prefs: { view: 'cards' } });
    expect(text(cardPage.$('#traps'))).toContain('↗ Open');
  });
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

  it('opens a deep-linked PR tab and every switched tab at the top', async () => {
    const g = await page(acceptanceFleet(), { hash: '#prs', initialScroll: 600 });
    expect(g.$$('.tabpage.on').map((el) => el.id)).toEqual(['page-prs']);
    expect(g.window.scrollY).toBe(0);
    for (const tab of ['dispatches', 'traps', 'notices', 'deck', 'prs']) {
      g.setScroll(600);
      await click(g, g.$(`#tabs a[data-tab="${tab}"]`));
      expect(g.$$('.tabpage.on').map((el) => el.id)).toEqual([`page-${tab}`]);
      expect(g.window.scrollY).toBe(0);
    }
  });

  it('a PR poll changes data without moving the reader', async () => {
    const g = await page(acceptanceFleet(), { hash: '#prs' });
    g.setScroll(500);
    const scrolls = g.scrolls();
    const d = acceptanceFleet();
    d.prs[0]!.title = 'Updated PR title';
    g.serve(d);
    await g.poll();
    expect(text(g.$('#prs'))).toContain('Updated PR title');
    expect(g.window.scrollY).toBe(500);
    expect(g.scrolls()).toEqual(scrolls);
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
    expect(card.querySelector('.gchip')!.className).toBe('gchip bad');
    expect(text(card.querySelector('.gchip'))).toBe('blocked');
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
    // Only the presence heartbeat runs while hidden (presence.ts).
    expect(g.intervals()).toEqual([30_000]);
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
  it('shows a send awaiting its reply under the dispatch messages', async () => {
    const d = acceptanceFleet();
    d.dispatches.find((x) => x.id.startsWith('cccccccc'))!.awaitingReply = { sentAt: ago(300_000), from: 'helm', line: 'start the dev server' };
    const g = await page(d);
    await openRow(g, '#dispatches', 'cccccccc');
    const secs = g.$$('#modalbox .sec').map((el) => text(el));
    expect(secs).toContain('awaiting reply');
    expect(text(g.$('#modalbox'))).toContain('start the dev server · from helm · 5m ago');
  });

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
    expect(text(box.querySelector('h3'))).toBe(`#42 ${PR_TITLES[42]} checks 3/4`);
    expect(text(box)).toContain('#41 → #42 → #43 · 2 of 3 · floor main · blocked by #41');
    expect(box.querySelector('b')?.textContent).toBe('#42');
    expect(g.$$('#modalbox .cmd code').map(text)).toEqual(['eyJoIjoiYWJjIn0-a-long-opaque-cursor']);
    // The chain links open the dispatch modals.
    await click(g, g.$$('#modalbox a').find((a) => text(a) === 'aaaaaaaa')!);
    expect(text(g.$('#modalbox h3'))).toBe('aaaaaaaa done');
  });

  it('⚙ edits browser display preferences while helm settings stay read-only', async () => {
    const g = await page(acceptanceFleet(), { hash: '#dispatches', prefs: { view: 'table', lobs: false } });
    await click(g, g.$('#gearbtn'));
    expect(text(g.$('#modalbox h3'))).toBe('⚙ settings');
    expect(text(g.$('#modalbox .settings .row:last-child'))).toContain('question · landed · pr:draft');
    const choose = async (setting: string, value: string) => click(g, g.$$(`.settings [aria-label="${setting}"] button`).find(button => text(button) === value) ?? null);
    await choose('view', 'cards');
    expect(g.$$('#dispatches .card')).toHaveLength(4);
    await choose('lobs', 'on');
    expect(g.$$('#lobs .lob')).toHaveLength(2);
    expect(JSON.parse(g.window.localStorage.getItem('spyglass')!)).toMatchObject({ view: 'cards', lobs: true });
    await choose('view', 'table');
    await choose('lobs', 'off');
    expect(g.$$('#dispatches tr.rowhead')).toHaveLength(4);
    expect(g.$$('#lobs .lob')).toHaveLength(0);
    expect(g.$$('[data-helm-chat] button, [data-helm-chat] input, [data-helm-chat] select')).toEqual([]);
    expect(g.posts()).toEqual([]);
    const reloaded = await page(acceptanceFleet(), { hash: '#dispatches', prefs: JSON.parse(g.window.localStorage.getItem('spyglass')!) });
    expect(reloaded.$$('#dispatches tr.rowhead')).toHaveLength(4);
    expect(reloaded.$$('#lobs .lob')).toHaveLength(0);
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
      '#60': 'badge bad long',
      '#61': 'badge pr-behind',
      '#30': 'badge pr-merged',
    });
    expect(g.$$('#prs h2').map((h) => text(heading(h)))).toContain('#41 → #42 → #43 · floor main');
    expect(g.$$('#prs h2').map((h) => text(heading(h)))).toContain('#30 · floor main · history');
  });

  it('a poll with new observation times keeps every PR row node in its place and the open modal', async () => {
    const g = await page(everyAttentionFleet(), { hash: '#prs' });
    const before = g.$$('#prs tr');
    await click(g, g.$$('#prs tr.rowhead')[0]!);
    const modal = g.$('#modalbox');
    expect(modal).toBeTruthy();
    const d = everyAttentionFleet();
    for (const p of d.prs) p.observedAt = ago(1000);
    g.serve(d);
    await g.poll();
    expect(g.$$('#prs tr')).toEqual(before);
    expect(g.$('#modalbox')).toBe(modal);
  });

  it('cards: a new stack at the top keeps every existing stack heading and card node', async () => {
    const g = await page(everyAttentionFleet(), { hash: '#prs', prefs: { view: 'cards' } });
    const cards = g.$$('#prs .card');
    const heads = g.$$('#prs h2');
    const d = everyAttentionFleet();
    const id = 'pr:acme/web#99';
    d.stacks.unshift({ id, floor: 'main', repo: d.stacks[0]!.repo, numbers: [99], open: true, nextNumber: 99, behind: 0 });
    d.prs.unshift({ ...d.prs[0]!, key: id, url: 'https://github.com/acme/web/pull/99', number: 99, title: 'fresh', stackId: id, position: 0 });
    g.serve(d);
    await g.poll();
    const after = g.$$('#prs .card');
    expect(text(after[0]!.querySelector('.prname'))).toBe('#99 fresh');
    expect(after.slice(1)).toEqual(cards);
    expect(g.$$('#prs h2').slice(1)).toEqual(heads);
  });

  it('the PRs table groups by stack and never shows a watch cursor', async () => {
    const g = await page(acceptanceFleet(), { hash: '#prs' });
    expect(g.$$('#prs th[colspan]').map((h) => text(heading(h)))).toEqual(['#41 → #42 → #43 · floor main · open']);
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

  it('titles: the PRs table has a title column after the number; a PR without one leaves it empty', async () => {
    const g = await page(acceptanceFleet(), { hash: '#prs' });
    expect(g.$$('#prs table')[0]!.querySelectorAll('th:not([colspan])')[1]!.textContent).toBe('title');
    const rows = g.$$('#prs tr.rowhead').map((tr) => [...tr.querySelectorAll('td')].map(text));
    expect(rows.map((r) => r.slice(0, 2))).toEqual([
      ['#41', PR_TITLES[41]],
      ['#42', PR_TITLES[42]],
      ['#43', ''],
    ]);
  });

  it('titles: a PR card shows the number bold and the title after it; no title shows the number alone', async () => {
    for (const hash of ['#deck', '#prs']) {
      const g = await page(everyAttentionFleet(), { hash, prefs: { view: 'cards' } });
      const names = g.$$(`${hash} .card .prname`);
      const byNumber = Object.fromEntries(names.map((n) => [text(n.querySelector('b')), n]));
      expect(text(byNumber['#41'])).toBe(`#41 ${PR_TITLES[41]}`);
      expect(byNumber['#41']!.getAttribute('title')).toBe(PR_TITLES[41]);
      expect(byNumber['#41']!.querySelectorAll('b')).toHaveLength(1);
      expect(text(byNumber['#43'])).toBe('#43');
      expect(byNumber['#43']!.hasAttribute('title')).toBe(false);
    }
  });

  it('titles: the stack line stays numbers only, and each number carries its title', async () => {
    const titled = (els: Element[]) => els.map((e) => [text(e), e.getAttribute('title')]);
    const want = [
      ['#41', PR_TITLES[41]],
      ['#42', PR_TITLES[42]],
      ['#43', null],
    ];
    const cards = await page(everyAttentionFleet(), { hash: '#prs', prefs: { view: 'cards' } });
    const head = heading(cards.$$('#prs h2').find((h) => text(h).startsWith('#41'))!);
    expect(text(head)).toBe('#41 → #42 → #43 · floor main');
    expect(titled([...head.querySelectorAll('span')])).toEqual(want);
    const deck = await page(everyAttentionFleet());
    const line = deck.$$('#deck .deckline').find((l) => text(l).startsWith('#41 →'))!;
    expect(titled([...line.querySelectorAll('b > span')])).toEqual(want);
    const modal = await page(acceptanceFleet());
    await openRow(modal, '#prs', '#42');
    const nums = [...modal.$('#modalbox')!.querySelectorAll('[title]')].filter((e) => /^#\d+$/.test(text(e)));
    expect(titled(nums)).toEqual(want.slice(0, 2));
    expect(nums[1]!.tagName).toBe('B');
  });

  it('titles: the PR modal header shows the title; a PR without one shows the number alone', async () => {
    const g = await page(acceptanceFleet());
    await openRow(g, '#prs', '#41');
    expect(text(g.$('#modalbox h3'))).toBe(`#41 ${PR_TITLES[41]} green`);
    await escape(g);
    await openRow(g, '#prs', '#43');
    expect(text(g.$('#modalbox h3'))).toBe('#43 draft');
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
  it('shows decisions (no pr:* kinds), in flight, landed, reports, traps, and PR stacks as six full-width sections', async () => {
    const g = await page(everyAttentionFleet());
    const sections = g.$$('#deck .deckgrid > section');
    // The decisions heading carries the unread count as a badge.
    const heading = (s: Element) => text(s.querySelector('h2')).replace(/\d+$/, '');
    expect(sections.map(heading)).toEqual(['decisions', 'in flight →', 'Landed · 24h →', 'reports →', 'traps →', 'PRs →']);
    // Only raw questions (and framed decisions) are rows; PR kinds stay with the PRs.
    const rows = [...sections[0]!.querySelectorAll('.drow')];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.querySelector('.badge'))).toBe(true);
    expect(text(sections[0]!.querySelector('h2 .dbadge'))).toBe(String(rows.length));
    // PR standing rides the stack line.
    expect(text(sections[5]!)).toContain('#41 → #42 → #43 · next #41');
    expect(text(sections[5]!.querySelector('.deckmore'))).toBe('+1 more →');
  });

  it('a queued in-flight row shows the queued badge, its queue time, and its trap address', async () => {
    const g = await page(acceptanceFleet());
    const flight = g.$$('#deck section')[1]!;
    // Two lines: the instruction and its status chip; the repo and trap, with the queue time at the right.
    const line = [...flight.querySelectorAll('.deckrow')].find((l) => text(l).includes('dddddddd'))!;
    expect(text(line.querySelector('.gchip'))).toBe('queued');
    expect(text(line.querySelector('.gtext'))).toBe('api · 🪤 wt:t2');
    expect(text(line.querySelector('.gright'))).toBe('60s ago');
  });

  it('an in-flight row with no time omits the "· ago" fragment', async () => {
    const d = acceptanceFleet();
    d.dispatches = d.dispatches.map((x) => (x.id.startsWith('dddddddd') ? { ...x, verbAt: undefined } : x));
    const g = await page(d);
    const line = [...g.$$('#deck section')[1]!.querySelectorAll('.deckrow')].find((l) => text(l).includes('dddddddd'))!;
    expect(text(line.querySelector('.gtext'))).toBe('api · 🪤 wt:t2');
    expect(line.querySelector('.gright')).toBeNull();
    expect(text(line)).not.toContain('ago');
  });

  it('Landed · 24h: the newest five catches, newest first, unreported badged, failed in red, nothing older', async () => {
    const g = await page(everyAttentionFleet());
    const landed = g.$$('#deck section')[2]!;
    const lines = [...landed.querySelectorAll('.deckrow')];
    expect(lines).toHaveLength(5);
    // Each row's title carries its id on hover; the title is the dispatch's, else its note's first line.
    expect(lines.map((l) => l.querySelector('b')!.getAttribute('title')!.split(' ')[0])).toEqual(
      Array.from({ length: 5 }, (_, i) => `1${i}aaaaaa`),
    );
    expect(lines.map((l) => !!l.querySelector('.badge.unreported'))).toEqual([true, true, true, true, false]);
    expect(lines[2]!.querySelector('.gchip')!.className).toBe('gchip bad');
    expect(text(landed)).not.toContain('yesterday');
    expect(landed.querySelector('.deckmore')).toBeNull();
  });

  it('traps: eight at most, live by sign-on then recently signed off, the rest in "+N more"', async () => {
    for (const view of ['table', 'cards'] as const) {
      const g = await page(everyAttentionFleet(), { prefs: { view } });
      const traps = g.$$('#deck section')[4]!;
      const items = [...traps.querySelectorAll(view === 'cards' ? '.card' : '.deckline')];
      // A card leads with the name alone (components/card.ts); a deck line keeps the 🪤.
      expect(items.map((l) => text(l.querySelector('b')).replace(/^🪤 /, ''))).toEqual([
        'wt:t1',
        'wt:t10',
        'wt:t3',
        'wt:t4',
        'wt:t5',
        'wt:t6',
        'wt:t7',
        'wt:t2',
      ]);
      const harnessOrState = (l: Element) =>
        view === 'cards'
          ? text(l.querySelector('.gchip')) === 'signed off'
            ? 'signed off'
            : l.querySelector('.gicon .harness-icon')?.getAttribute('aria-label')?.toLowerCase()
          : (l.querySelector('.badge .harness-icon')?.getAttribute('aria-label')?.toLowerCase() ?? text(l.querySelector('.badge')));
      expect(items.map(harnessOrState)).toEqual([
        'claude',
        'claude',
        'codex',
        'claude',
        'claude',
        'claude',
        'signed off',
        'signed off',
      ]);
      // t8 (ghosted 45m ago) is the ninth; t9 stowed two hours ago is off the deck.
      expect(text(traps.querySelector('.deckmore'))).toBe('+1 more →');
      expect(traps.querySelector('.deckmore')!.getAttribute('href')).toBe('#traps');
      expect(text(traps)).not.toContain('wt:t9');
    }
  });

  it('an empty window says none', async () => {
    const d = acceptanceFleet();
    d.landed = [{ ...d.landed[0]!, at: ago(25 * 3600_000) }];
    const g = await page(d);
    expect(text(g.$$('#deck section')[2]!.querySelector('.empty'))).toBe('none');
  });

  it('cards view: acked PR standing dims its card', async () => {
    const g = await page(everyAttentionFleet(), { prefs: { view: 'cards' } });
    const prs = g.$$('#deck section')[5]!;
    const cards = [...prs.querySelectorAll('.card')];
    expect(cards.map((c) => [text(c.querySelector('b')).split(' ')[0], c.className])).toContainEqual(['#42', 'card acked']);
    expect(text(prs.querySelector('.card .badge.pr-conflicts'))).toBe('conflicts');
  });

  it('an empty fleet: every section says none, the daemon is down', async () => {
    const g = await page(emptyFleet());
    expect(g.$$('#deck section .empty').map(text)).toEqual(['none', 'none', 'none', 'none', 'none', 'none']);
    expect(text(g.$('#chips'))).toBe('daemon down');
  });
});

describe('glass page: header', () => {
  it('the helm chip names the man and opens the helm modal with its resume command', async () => {
    const d = acceptanceFleet();
    d.viewer = { onMachine: true, windowFocus: true, machine: 'studio', device: 'desktop' };
    const g = await page(d);
    const chip = g.$('#chips .chip.click')!;
    expect(text(chip)).toBe('⛵ claude @ web helm fleet · chat full 30s ago');
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
    expect(text(g.$('#foot'))).toBe('lobstah v0.5.5 · aequitas-labs/lobstah');
    expect(g.$('#foot .pet-art')).toBeNull();
    expect(g.$('#foot a')!.getAttribute('href')).toBe('https://github.com/aequitas-labs/lobstah');
  });
});

describe('glass page: lobs', () => {
  it('attention walks: a PR lob links out, a question lob goes to its card on the deck', async () => {
    const g = await page(acceptanceFleet(), { hash: '#dispatches' });
    const lobs = g.$$('#lobs .lob');
    expect(lobs.map((l) => [l.tagName, text(l.querySelector('.bub'))])).toEqual([
      ['A', 'which base should #43 target?'],
      ['A', 'draft #43 draft'],
    ]);
    expect(lobs[1]!.getAttribute('href')).toBe('https://github.com/acme/web/pull/43');
    const key = acceptanceFleet().attention.find((a) => a.kind === 'question')!.key!;
    expect(lobs[0]!.getAttribute('href')).toBe(`#decision/${encodeURIComponent(key)}`);
    await click(g, lobs[0]!);
    expect(g.$('.tabpage.on')!.id).toBe('page-deck');
    expect(g.$('#overlay')!.className).not.toBe('open');
    const card = g.$$('#deck [data-decision]').find((c) => c.getAttribute('data-decision') === key)!;
    expect(card.className).toContain('focus');
  });

  it('acked items do not walk; a clicked lob hides in this browser until its state changes', async () => {
    const g = await page(everyAttentionFleet());
    // Four walk at most, the last counting the rest; acked ones never do.
    const bubs = g.$$('#lobs .lob .bub').map(text);
    expect(bubs).toHaveLength(4);
    expect(bubs.join(' ')).not.toMatch(/landed item 1|pr:checks item 4|watch item 7/);
    // Clicking a question lob goes to its card and hides that lob here.
    await click(g, g.$$('#lobs .lob').find((l) => text(l).includes('question item 0')) ?? null);
    expect(g.$('#overlay')!.className).not.toBe('open');
    expect(JSON.parse(g.window.localStorage.getItem('spyglass-lob-hidden')!)).toEqual({ 'work:cccccccc-0000-4000-8000-000000000003': 'h0' });
    expect(g.$$('#lobs .lob .bub').map(text).join(' ')).not.toContain('question item 0');
    // A new state hash walks it again.
    const d = everyAttentionFleet();
    d.attention[0]!.stateHash = 'h0-changed';
    g.serve(d);
    await g.poll();
    expect(g.$$('#lobs .lob .bub').map(text).join(' ')).toContain('question item 0');
  });

  it.each([true, false])('honors the stored lobs preference %s', async (lobs) => {
    const g = await page(acceptanceFleet(), { prefs: { lobs } });
    expect(g.$$('#lobs .lob')).toHaveLength(lobs ? 2 : 0);
    await click(g, g.$('#gearbtn'));
    expect(text(g.$('.settings [aria-label="lobs"] button[aria-pressed="true"]'))).toBe(lobs ? 'on' : 'off');
  });
});

describe('glass page: a dispatch shows its trap by name', () => {
  /** t1 is live (crisp-heron), t2 signed off with a recorded name (kind-crab), wt:gone has no known name. */
  function namedFleet(): GlassSnapshot {
    const d = acceptanceFleet();
    d.trapNames = { t1: 'crisp-heron', t2: 'kind-crab' };
    const c = d.dispatches.find((x) => x.id.startsWith('cccccccc'))!;
    c.note = 'claimed by wt:t1';
    c.log = [{ at: ago(4 * 60_000), verb: 'working', note: 'claimed by wt:t1' }];
    d.dispatches.push({ ...d.dispatches.find((x) => x.id.startsWith('dddddddd'))!, id: 'ffffffff-0000-4000-8000-000000000006', for: 'wt:gone' });
    return d;
  }
  const row = (g: GlassDom, id: string) => g.$$('#dispatches tr.rowhead').find((tr) => text(tr).startsWith(id))!;

  it('names a live trap, a signed-off trap, and falls back to wt:<id>, each with wt:<id> in its title', async () => {
    const g = await page(namedFleet(), { hash: '#dispatches', prefs: { view: 'table' } });
    const live = row(g, 'cccccccc');
    expect(text(live)).toContain('claimed by crisp-heron');
    expect(text(live)).not.toContain('wt:t1');
    const liveNames = [...live.querySelectorAll('.trapname')];
    expect(liveNames.map(text)).toEqual(['crisp-heron', 'crisp-heron']);
    expect(liveNames.map((n) => n.getAttribute('title'))).toEqual(['wt:t1', 'wt:t1']);

    const signedOff = row(g, 'dddddddd').querySelector('.trapname')!;
    expect(text(signedOff)).toBe('kind-crab');
    expect(signedOff.getAttribute('title')).toBe('wt:t2');

    const unknown = row(g, 'ffffffff').querySelector('.trapname')!;
    expect(text(unknown)).toBe('wt:gone');
    expect(unknown.getAttribute('title')).toBe('wt:gone');
    expect(unknown.tagName).toBe('SPAN');
  });

  it('shows the name on the deck, in the dispatch modal, and in its log', async () => {
    const g = await page(namedFleet(), { hash: '#deck', prefs: { view: 'table' } });
    const flight = g.$$('#deck .deckrow').find((l) => text(l).includes('cccccccc'))!;
    expect(text(flight.querySelector('.gtext'))).toContain('🪤 crisp-heron');
    expect(text(flight)).not.toContain('wt:t1');
    await openRow(g, '#dispatches', 'cccccccc');
    expect(text(g.$('#modalbox .claimedby'))).toBe('claimed by crisp-heron');
    expect(g.$('#modalbox .claimedby .trapname')!.getAttribute('title')).toBe('wt:t1');
    expect(text(g.$('#modalbox .loglines'))).toContain('working claimed by crisp-heron');
  });

  it("opens the trap's modal when its name is clicked, not the dispatch's", async () => {
    const g = await page(namedFleet(), { hash: '#dispatches', prefs: { view: 'table' } });
    await click(g, row(g, 'cccccccc').querySelector('a.trapname'));
    expect(text(g.$('#modalbox h3'))).toContain('🪤');
    expect(text(g.$('#modalbox h3'))).toContain('crisp-heron');
    expect(text(g.$('#modalbox .trap-address'))).toContain('wt:t1');
    await escape(g);
    await click(g, row(g, 'dddddddd').querySelector('a.trapname'));
    expect(text(g.$('#modalbox h3'))).toContain('signed off');
  });
});

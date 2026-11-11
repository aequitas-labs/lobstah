import { afterEach, describe, expect, it } from 'vitest';
import type { GlassFullSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, acceptanceFleet, ago, emptyFleet } from './fixtures/glass-snapshots.js';

/**
 * The glass's copy pass (plan 2ec9c88b-193, rows C2-C23): each string says
 * what a person can do, in plain words, with no internal names, and the
 * glass's lowercase voice. Ids and addresses still find what they did.
 */

let open: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

async function page(d: GlassFullSnapshot, opts: Parameters<typeof loadGlass>[2] = {}) {
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, ...opts });
  open.push(g);
  return g;
}

function withDecision(token?: string): GlassFullSnapshot {
  const d = acceptanceFleet();
  if (token) d.focusToken = token;
  else delete d.focusToken;
  const at = ago(60_000);
  const id = d.dispatches[0]!.id;
  d.decisions = [{ key: 'decision:c0p10001', dispatch: id, lane: 'work', title: 'Which base?', detail: 'x', options: ['main'], attachments: [], askedBy: 'helm', askedAt: at, stateHash: 'h' }] as GlassFullSnapshot['decisions'];
  d.attention = [...d.attention, { kind: 'decision', key: 'decision:c0p10001', stateHash: 'h', id, lane: 'work', verb: 'decision', ageSecs: 60, at, standingSince: at, note: 'Which base?' }] as GlassFullSnapshot['attention'];
  return d;
}

const BEFORE = ['all lanes', 'Cancel job', 'Keep job', 'fence', 'registration gone', 'surviving record', 'Click anywhere or press Escape', 'answer token', 'was refused', 'scrubbed', "card's hash", 'run on this Mac'];

describe('the copy pass on the glass', () => {
  it('says what an empty deck section is missing (C7) and names the lanes plainly (C5)', async () => {
    const g = await page(emptyFleet());
    const empties = g.$$('#deck section .empty').map(text);
    expect(empties).toContain('nothing in flight');
    expect(empties).toContain('no reports yet');
    await g.go('#dispatches');
    expect([...(g.$('#f-lane') as HTMLSelectElement).options].map((o) => [o.value, o.textContent])).toEqual([
      ['', 'all dispatches'],
      ['work', 'work'],
      ['chore', 'chores'],
    ]);
  });

  it("tells a signed-off trap's history in a few words (C22)", async () => {
    const d = acceptanceFleet();
    const gone = d.traps.find((t) => !t.live)!;
    const g = await page(d, { hash: '#traps', prefs: { view: 'table' } });
    (g.$$('#traps .rowhead').find((r) => text(r).includes(gone.trapId)) as HTMLElement).click();
    await g.settle();
    expect(text(g.$('#modalbox'))).toContain('signed off · its history is below');
  });

  it('decision cards: new and seen (C11), a tap closes (C13), and errors lead with the next step (C14, C15)', async () => {
    const noToken = await page(withDecision(), { hash: '#deck' });
    expect(noToken.$('#deck .drow .dopen')!.getAttribute('aria-label')).toBe('new: Which base?');
    (noToken.$('#deck .drow .dopen') as HTMLElement).click();
    await noToken.settle();
    (noToken.$$('.dmodal .dopt')[0] as HTMLElement).click();
    (noToken.$('.dmodal .dsend') as HTMLElement).click();
    await noToken.settle();
    expect(text(noToken.$('.dmodal .derr'))).toBe('Reload the page to answer.');

    const refused = await page(withDecision('tok'), { hash: '#deck', post: () => ({ status: 403, body: { ok: false } }) });
    (refused.$('#deck .drow .dopen') as HTMLElement).click();
    await refused.settle();
    (refused.$$('.dmodal .dopt')[0] as HTMLElement).click();
    (refused.$('.dmodal .dsend') as HTMLElement).click();
    await refused.settle();
    expect(text(refused.$('.dmodal .derr'))).toBe("Your answer didn't go through. Reload and try again.");

    // Answering the last open decision leaves the "all answered" card.
    const one = withDecision('tok');
    const only = { ...emptyFleet(), focusToken: 'tok', decisions: one.decisions, attention: one.attention.filter((a) => a.kind === 'decision') };
    const done = await page(only, { hash: '#deck', post: () => ({ status: 201, body: { ok: true } }) });
    (done.$('#deck .drow .dopen') as HTMLElement).click();
    await done.settle();
    (done.$$('.dmodal .dopt')[0] as HTMLElement).click();
    (done.$('.dmodal .dsend') as HTMLElement).click();
    await done.settle();
    expect(text(done.$('.ddone'))).toContain('Tap or click anywhere to close');
  });

  it("shows none of the table's before strings across the deck, tabs and details", async () => {
    const g = await page(withDecision('tok'), { hash: '#deck' });
    // What a person reads: the page without its script.
    const shown = () => {
      const body = g.document.body.cloneNode(true) as HTMLElement;
      body.querySelectorAll('script').forEach((s) => s.parentNode?.removeChild(s));
      return text(body);
    };
    const seen: string[] = [shown()];
    for (const tab of ['#dispatches', '#traps', '#prs', '#reports']) {
      await g.go(tab);
      seen.push(shown());
    }
    for (const page of seen) for (const before of BEFORE) expect(page).not.toContain(before);
  });

  it('still finds a dispatch by its id and by its trap address', async () => {
    const d = acceptanceFleet();
    const byId = await page(d, { hash: '#dispatches', prefs: { q: 'cccccccc', view: 'table' } });
    expect(byId.$$('#dispatches tr.rowhead').map((r) => text(r.querySelector('td')))).toEqual(['cccccccc']);
    const addressed = d.dispatches.find((y) => y.for)!;
    const byTrap = await page(d, { hash: '#dispatches', prefs: { q: addressed.for!, view: 'table' } });
    expect(byTrap.$$('#dispatches tr.rowhead').map((r) => text(r.querySelector('td')))).toContain(addressed.id.slice(0, 8));
  });
});

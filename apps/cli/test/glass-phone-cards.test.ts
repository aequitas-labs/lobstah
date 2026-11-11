import { afterEach, describe, expect, it } from 'vitest';
import type { GlassFullSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { mergeMirror } from '../../../packages/glass-ui/ui/mirror-merge.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, acceptanceFleet, ago } from './fixtures/glass-snapshots.js';

/**
 * Decision and run cards on a phone (components/decisions.ts): a head with
 * ‹ n of m ›, a body that scrolls, and a dock with the answer; no keyboard
 * legend on a touch screen; swipes; and a run card's reply and boat.
 */

let open: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const RUN = { scriptSha256: 'a'.repeat(64), scriptBytes: 10, inputs: [], cwd: '/r', timeoutSecs: 300, output: 'scrubbed', interpreter: '/bin/bash', script: 'echo hi', warnings: [] };

function fleet(withRun = false): GlassFullSnapshot {
  const d = acceptanceFleet();
  d.focusToken = 'tok';
  const at = ago(60_000);
  const id = d.dispatches[0]!.id;
  const card = (key: string, title: string, extra: object = {}) => ({ key, dispatch: id, lane: 'work', title, detail: 'x', options: ['main', 'next'], attachments: [], askedBy: 'helm', askedAt: at, stateHash: key, ...extra });
  d.decisions = [
    card('decision:aaaa0001', 'First question?'),
    card('decision:aaaa0002', 'Second question?'),
    ...(withRun ? [card('decision:aaaa0003', 'Run the check', { options: ['Decline'], run: RUN })] : []),
  ] as GlassFullSnapshot['decisions'];
  d.attention = [
    ...d.attention,
    ...d.decisions!.map((x) => ({ kind: 'decision' as const, key: x.key, stateHash: x.stateHash, id, lane: 'work' as const, verb: 'decision', ageSecs: 60, at, standingSince: at, note: x.title })),
  ] as GlassFullSnapshot['attention'];
  return d;
}

/** A touch-only screen: matchMedia says hover none and a coarse pointer. */
const touch = (window: { matchMedia?: unknown }) => {
  window.matchMedia = (q: string) => ({ matches: q.includes('hover: none'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
};

async function page(d: GlassFullSnapshot, key: string, opts: { touch?: boolean } = {}) {
  const g = await loadGlass(GLASS_PAGE, d, {
    now: NOW,
    hash: `#decision/${encodeURIComponent(key)}`,
    post: () => ({ status: 201, body: { ok: true } }),
    ...(opts.touch ? { prepare: touch } : {}),
  });
  open.push(g);
  return g;
}

/** A finger from (x0, y0) to (x1, y1), starting on `el`. */
async function swipe(g: GlassDom, el: Element, [x0, y0]: [number, number], [x1, y1]: [number, number]) {
  const ev = (type: string, list: string, x: number, y: number) => {
    const e = new g.window.Event(type, { bubbles: true });
    Object.defineProperty(e, list, { value: [{ clientX: x, clientY: y }] });
    return e;
  };
  el.dispatchEvent(ev('touchstart', 'touches', x0, y0));
  el.dispatchEvent(ev('touchend', 'changedTouches', x1, y1));
  await g.settle();
}

describe('a decision card', () => {
  it('has a head with ‹ n of m ›, a body with the question, and a dock with the options above the text box', async () => {
    const g = await page(fleet(), 'decision:aaaa0001');
    const card = g.$('.dmodal')!;
    expect(text(card.querySelector('.dhead .dpos'))).toMatch(/^\d of 3$/);
    expect(text(card.querySelector('.dbody .dtitle'))).toBe('First question?');
    const dock = card.querySelector('.ddock')!;
    const order = [...dock.querySelectorAll('.doptions, .danswer, .dsend')].map((el) => el.className.split(' ').find((c) => c.startsWith('d')));
    expect(order).toEqual(['doptions', 'danswer', 'dsend']);
    // With a keyboard: hotkeys and the legend, as today.
    expect(dock.querySelector('.dkey')).toBeTruthy();
    expect(dock.querySelector('.dlegend')).toBeTruthy();
  });

  it('shows no keyboard legend and no hotkey numbers on a touch screen', async () => {
    const g = await page(fleet(), 'decision:aaaa0001', { touch: true });
    expect(g.$('.dmodal .dlegend')).toBeNull();
    expect(g.$('.dmodal .dkey')).toBeNull();
    expect(g.$$('.dmodal .dopt').map(text)).toEqual(['main', 'next']);
  });

  it('swipes left to the next card and right to the previous; down from the head closes it', async () => {
    const g = await page(fleet(), 'decision:aaaa0001', { touch: true });
    await swipe(g, g.$('.dmodal .dbody')!, [300, 400], [100, 410]);
    expect(text(g.$('.dmodal .dtitle'))).toBe('Second question?');
    await swipe(g, g.$('.dmodal .dbody')!, [100, 400], [300, 395]);
    expect(text(g.$('.dmodal .dtitle'))).toBe('First question?');
    // A short or mostly vertical move does nothing.
    await swipe(g, g.$('.dmodal .dbody')!, [300, 400], [270, 400]);
    await swipe(g, g.$('.dmodal .dbody')!, [300, 200], [250, 500]);
    expect(text(g.$('.dmodal .dtitle'))).toBe('First question?');
    // A swipe that starts in the text box moves the text, not the card.
    await swipe(g, g.$('.dmodal textarea')!, [300, 700], [100, 700]);
    expect(text(g.$('.dmodal .dtitle'))).toBe('First question?');
    // Down from the body does not close; down from the head does.
    await swipe(g, g.$('.dmodal .dbody')!, [200, 100], [205, 400]);
    expect(g.$('.dmodal')).toBeTruthy();
    await swipe(g, g.$('.dmodal .dhead')!, [200, 20], [205, 300]);
    expect(g.$('.dmodal')).toBeNull();
  });
});

describe('a run card', () => {
  it('takes a reply with Send, and Decline sends at once', async () => {
    const g = await page(fleet(true), 'decision:aaaa0003');
    const box = g.$('.dmodal .ddock textarea') as HTMLTextAreaElement;
    box.value = 'Run it after the deploy';
    box.dispatchEvent(new g.window.Event('input', { bubbles: true }));
    await g.settle();
    (g.$('.dmodal .dsend') as HTMLElement).click();
    await g.settle();
    expect(g.posts().map((p) => JSON.parse(p.body))).toContainEqual({ kind: 'decision-answer', payload: { key: 'decision:aaaa0003', text: 'Run it after the deploy', files: [] } });
    const d = await page(fleet(true), 'decision:aaaa0003');
    (d.$$('.dmodal .dopt').find((b) => text(b).endsWith('Decline')) as HTMLElement).click();
    await d.settle();
    expect(d.posts().map((p) => JSON.parse(p.body))).toContainEqual({ kind: 'decision-answer', payload: { key: 'decision:aaaa0003', option: 'Decline', files: [] } });
  });

  it('says it runs on its boat when the boats merge into the hosted glass', async () => {
    const d = fleet(true);
    const merged = mergeMirror([{ boat: 'b1', name: 'studio', at: new Date(NOW).toISOString(), snapshot: d }], NOW, { onMachine: false, windowFocus: false, machine: '', device: 'phone' });
    const run = merged.snapshot.decisions!.find((x) => x.key === 'decision:aaaa0003')!.run!;
    expect(run.boat).toBe('studio');
    const g = await page(merged.snapshot as GlassFullSnapshot, 'decision:aaaa0003');
    expect(text(g.$('.dmodal .runhead .badge'))).toBe('Runs on studio');
    // The local glass is on its boat.
    const local = await page(fleet(true), 'decision:aaaa0003');
    expect(text(local.$('.dmodal .runhead .badge'))).toBe('run on this Mac');
  });
});

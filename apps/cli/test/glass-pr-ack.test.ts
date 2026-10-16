import { afterEach, describe, expect, it } from 'vitest';
import type { GlassPr } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom, GlassDomOptions } from './glass-dom.js';
import { acceptanceFleet, NOW } from './fixtures/glass-snapshots.js';

const open: GlassDom[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((g) => g.close())); });

const A = 'pr:acme/web#41';
const B = 'pr:acme/web#70';
const LONE = 'pr:acme/web#80';

/** Stack A (#41-#43), stack B (#70, #71), and a lone PR #80, each with standing attention. */
function fleet() {
  const d = acceptanceFleet();
  d.focusToken = 'page-token';
  const like = d.prs.find((p) => p.number === 41)!;
  const pr = (number: number, stackId: string, position: number): GlassPr => ({
    ...like,
    key: `pr:acme/web#${number}`,
    number,
    url: `https://github.com/acme/web/pull/${number}`,
    title: `web pull request ${number}`,
    stackId,
    position,
  });
  d.prs.push(pr(70, B, 0), pr(71, B, 1), pr(80, LONE, 0));
  d.stacks = [
    d.stacks.find((s) => s.id === A)!,
    { id: B, floor: 'main', repo: 'web', numbers: [70, 71], open: true, nextNumber: 70, behind: 0 },
    { id: LONE, floor: 'main', repo: 'web', numbers: [80], open: true, nextNumber: 80, behind: 0 },
  ];
  const base = { id: 'pr-test', lane: 'work', verb: 'pr:review', kind: 'pr:review', ageSecs: 0 };
  d.attention = [
    ...d.prs.filter((p) => p.state === 'OPEN').map((p) => ({ ...base, key: p.key, stateHash: p.key + '-state' })),
    { ...base, key: 'stack:' + A, stateHash: 'stack-a-state', kind: 'stack-ready' },
    { ...base, key: 'stack:' + B, stateHash: 'stack-b-state', kind: 'stack-ready' },
    { ...base, key: 'work:question', stateHash: 'question-state', kind: 'question', note: 'Which port?' },
  ];
  return d;
}
type Fleet = ReturnType<typeof fleet>;

/** The keys of one stack group's standing PR and stack attention. */
const stackKeys = (d: Fleet, stack: string) =>
  d.attention.filter((a) => a.key === 'stack:' + stack || d.prs.some((p) => p.stackId === stack && p.key === a.key)).map((a) => a.key).sort();

/** A server that acks what it is sent, as glass.ts does. */
const acking = (d: Fleet): GlassDomOptions['post'] => (_url, req) => {
  const { kind, payload } = JSON.parse(req.body);
  expect(kind).toBe('pr-ack');
  const acked = payload.items.map((a: { key: string; stateHash: string }) => ({ ...a, at: new Date(NOW).toISOString(), by: 'glass' }));
  d.attention = d.attention.map((a) => (acked.some((i: { key: string; stateHash: string }) => i.key === a.key && i.stateHash === a.stateHash) ? { ...a, acked: { at: d.now, by: 'glass' } } : a));
  return { status: 200, body: { ok: true, acked } };
};

async function page(d: Fleet, opts: Partial<GlassDomOptions> = {}) {
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, hash: '#prs', ...opts });
  open.push(g);
  return g;
}
const buttons = (g: GlassDom) => g.$$('button').filter((b) => b.textContent === 'Ack stack' || b.textContent === 'Ack');
const ackFor = (g: GlassDom, stack: string) => buttons(g).find((b) => b.getAttribute('data-stack') === stack) as HTMLElement | undefined;
const click = async (g: GlassDom, stack: string) => {
  ackFor(g, stack)!.click();
  await g.settle();
};
const sent = (g: GlassDom, i = -1) => (JSON.parse(g.posts().at(i)!.body).payload.items as Array<{ key: string; stateHash: string }>).map((a) => a.key).sort();

describe('glass PR Ack stack', () => {
  it.each([
    ['#prs', 'table'],
    ['#prs', 'cards'],
    ['#deck', 'table'],
    ['#deck', 'cards'],
  ])('on %s (%s) acks one stack, leaving the other stack and the lone PR, and stands again for a new state', async (hash, view) => {
    const d = fleet();
    const g = await page(d, { hash, prefs: { view }, post: acking(d) });
    expect(g.$$('button').some((b) => b.textContent === 'Ack all')).toBe(false);
    expect([ackFor(g, A), ackFor(g, B), ackFor(g, LONE)].map((b) => b?.textContent)).toEqual(['Ack stack', 'Ack stack', 'Ack']);

    await click(g, A);
    expect(g.posts()).toHaveLength(1);
    expect(g.posts()[0]!.headers['x-lobstah-token']).toBe('page-token');
    expect(sent(g)).toEqual(stackKeys(d, A));
    expect(ackFor(g, A)).toBeUndefined();
    expect(ackFor(g, B)?.textContent).toBe('Ack stack');
    expect(ackFor(g, LONE)?.textContent).toBe('Ack');
    expect(d.attention.filter((a) => a.acked).map((a) => a.key).sort()).toEqual(stackKeys(d, A));

    // A new state of the stack stands again; the page shows its control again.
    d.attention = d.attention.map((a) => (a.key === 'stack:' + A ? { ...a, acked: undefined, stateHash: 'stack-a-next' } : a));
    g.serve(d);
    await g.poll();
    expect(ackFor(g, A)?.textContent).toBe('Ack stack');
  });

  it("a lone PR's Ack acks only that PR", async () => {
    const d = fleet();
    const g = await page(d, { post: acking(d) });
    await click(g, LONE);
    expect(sent(g)).toEqual([LONE]);
    expect(ackFor(g, LONE)).toBeUndefined();
    expect(ackFor(g, A)).toBeTruthy();
    expect(ackFor(g, B)).toBeTruthy();
  });

  it("sends the state each item showed, respects the search filter, and hides a stack whose attention is acknowledged", async () => {
    const d = fleet(), p = d.prs.find((p) => p.number === 42)!;
    const g = await page(d, { prefs: { q: p.title }, post: () => ({ status: 200, body: { ok: true, acked: [] } }) });
    await click(g, A);
    expect(JSON.parse(g.posts()[0]!.body).payload.items).toEqual(
      d.attention.filter((a) => a.key === p.key || a.key === 'stack:' + A).map(({ key, stateHash }) => ({ key, stateHash })),
    );
    d.attention = d.attention.map((a) => (stackKeys(d, A).includes(a.key) ? { ...a, acked: { by: 'pet', at: d.now } } : a));
    g.serve(d);
    await g.poll();
    expect(ackFor(g, A)).toBeUndefined();
  });

  it('keeps a failed acknowledgment visible with an error and permits retry', async () => {
    const g = await page(fleet(), { post: () => ({ status: 503, body: { ok: false, reason: 'Try again' } }) });
    await click(g, B);
    expect(g.$('[role=alert]')!.textContent).toBe('Try again');
    expect(ackFor(g, B)).toBeTruthy();
    await click(g, B);
    expect(g.posts()).toHaveLength(2);
  });

  it('does not open the PR when the deck line is clicked through its Ack stack', async () => {
    const d = fleet();
    const g = await page(d, { hash: '#deck', post: acking(d) });
    await click(g, B);
    expect(g.posts()).toHaveLength(1);
    expect(g.$('#modalbox h3')).toBeNull();
    // The line itself still opens its PR.
    (g.$$('.deckline').find((l) => l.textContent?.includes('#70')) as HTMLElement).click();
    await g.settle();
    expect(g.$('#modalbox h3')).not.toBeNull();
  });
});

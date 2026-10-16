import { afterEach, describe, expect, it } from 'vitest';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom, GlassDomOptions } from './glass-dom.js';
import { acceptanceFleet, NOW } from './fixtures/glass-snapshots.js';

const open: GlassDom[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((g) => g.close())); });
function fleet() {
  const d = acceptanceFleet();
  d.focusToken = 'page-token';
  const prs = d.prs.filter((p) => p.state === 'OPEN');
  const base = { id: 'pr-test', lane: 'work', verb: 'pr:review', kind: 'pr:review', ageSecs: 0 };
  d.attention = [
    ...prs.map((p) => ({ ...base, key: p.key, stateHash: p.key + '-state' })),
    { ...base, key: 'stack:' + prs[0]!.stackId, stateHash: 'stack-state', kind: 'stack-ready' },
    { ...base, key: 'work:question', stateHash: 'question-state', kind: 'question', note: 'Which port?' },
  ];
  return d;
}
async function page(d = fleet(), opts: Partial<GlassDomOptions> = {}) {
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, hash: '#prs', ...opts });
  open.push(g);
  return g;
}
const button = (g: GlassDom) => g.$$('button').find((b) => b.textContent === 'Ack all');
const click = async (g: GlassDom) => { (button(g) as HTMLElement).click(); await g.settle(); };

describe('glass PR Ack all', () => {
  it.each(['#prs', '#deck'])('acks shown PR and stack states from %s, hides after success, and reappears for a new state', async (hash) => {
    const d = fleet();
    const expected = d.attention.filter((a) => a.key.startsWith('pr:') || a.key.startsWith('stack:'));
    const g = await page(d, { hash, post: (_url, req) => {
      const { kind, payload } = JSON.parse(req.body);
      expect(kind).toBe('pr-ack');
      expect(payload.items).toEqual(expected.map(({ key, stateHash }) => ({ key, stateHash })));
      const acked = payload.items.map((a: { key: string; stateHash: string }) => ({ ...a, at: new Date(NOW).toISOString(), by: 'glass' }));
      d.attention = d.attention.map((a) => acked.some((i: { key: string }) => i.key === a.key) ? { ...a, acked: { at: d.now, by: 'glass' } } : a);
      return { status: 200, body: { ok: true, acked } };
    } });
    expect(button(g)).toBeTruthy();
    await click(g);
    expect(g.posts()).toHaveLength(1);
    expect(g.posts()[0]!.headers['x-lobstah-token']).toBe('page-token');
    expect(button(g)).toBeUndefined();
    d.attention = d.attention.map((a) => a.kind === 'stack-ready' ? { ...a, acked: undefined, stateHash: 'new-stack-state' } : a);
    g.serve(d); await g.poll();
    expect(button(g)).toBeTruthy();
  });

  it('respects the PR search filter and excludes already acknowledged items', async () => {
    const d = fleet(), p = d.prs.find((p) => p.number === 42)!;
    const g = await page(d, { prefs: { q: p.title }, post: () => ({ status: 200, body: { ok: true, acked: [] } }) });
    await click(g);
    const items = JSON.parse(g.posts()[0]!.body).payload.items;
    expect(items.map((a: { key: string }) => a.key).sort()).toEqual([p.key, 'stack:' + p.stackId].sort());
    d.attention = d.attention.map((a) => ({ ...a, acked: { by: 'pet', at: d.now } }));
    g.serve(d); await g.poll();
    expect(button(g)).toBeUndefined();
  });

  it('keeps a failed acknowledgment visible with an error and permits retry', async () => {
    const g = await page(fleet(), { post: () => ({ status: 503, body: { ok: false, reason: 'Try again' } }) });
    await click(g);
    expect(g.$('[role=alert]')!.textContent).toBe('Try again');
    expect(button(g)).toBeTruthy();
    await click(g);
    expect(g.posts()).toHaveLength(2);
  });
});

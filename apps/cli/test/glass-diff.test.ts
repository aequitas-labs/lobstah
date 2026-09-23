import { describe, expect, it } from 'vitest';
import { GLASS_DIFF_JS } from '../src/glass-diff.js';
import { serveGlass } from '../src/glass.js';
import type { AddressInfo } from 'node:net';

// Evaluate exactly the source the page inlines — no jsdom, no DOM at all.
type Hashes = Record<string, string>;
type Ui = { st: Record<string, string>; open: Set<string>; modal: { type: string; key: string } | null };
const diff = new Function(`${GLASS_DIFF_JS}; return { sectionHashes, dirtySections, stableStringify, tabFromHash, visibleSections };`)() as {
  sectionHashes: (d: unknown, ui: Ui, now: number) => Hashes;
  dirtySections: (prev: Hashes | null, next: Hashes) => string[];
  stableStringify: (v: unknown) => string;
  tabFromHash: (hash: string) => string;
  visibleSections: (tab: string) => string[];
};

const NOW = Date.parse('2026-09-22T12:00:00Z');
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const dispatch = (id: string, verb: string, note: string) => ({
  id,
  lane: 'work',
  bucket: 'active',
  repo: 'web',
  brief: `brief ${id}`,
  verb,
  note,
  verbAt: iso(60_000),
  log: [{ at: iso(60_000), verb, note }],
  inbox: [],
});
const snapshot = () => ({
  now: iso(0),
  version: '0.5.0',
  repoUrl: 'https://github.com/aequitas-labs/lobstah',
  daemon: { version: '0.5.0', heartbeat: iso(5_000) },
  helms: [{ grounds: 'fleet', man: 'claude @ x', heartbeatAt: iso(10_000) }],
  traps: [{ trapId: 'aa', live: true, heartbeatAt: iso(10_000), messages: [], notices: [], catches: [] }],
  notices: [{ at: iso(30_000), kind: 'caught', text: 'one' }],
  watches: [{ key: 'ci', owner: 'helm', cursor: 1 }],
  dispatches: [dispatch('d1', 'working', 'on it'), dispatch('d2', 'working', 'also on it')],
  mergeView: { open: [], recent: [] },
});
const ui = (over: Partial<Ui> = {}): Ui => ({ st: { view: 'table', lane: '', repo: '', verb: '', q: '' }, open: new Set(), modal: null, ...over });

describe('glass change detector', () => {
  it('an identical snapshot, a second later, dirties nothing', () => {
    const a = diff.sectionHashes(snapshot(), ui(), NOW);
    const b = diff.sectionHashes({ ...snapshot(), now: iso(-1_000) }, ui(), NOW + 1_000);
    expect(diff.dirtySections(a, b)).toEqual([]);
  });

  it('marks only the section whose slice changed', () => {
    const a = diff.sectionHashes(snapshot(), ui(), NOW);
    const s = snapshot();
    s.watches[0]!.cursor = 2;
    expect(diff.dirtySections(a, diff.sectionHashes(s, ui(), NOW))).toEqual(['prs']);
  });

  it('a change to another dispatch leaves the open modal alone', () => {
    const view = ui({ modal: { type: 'dispatch', key: 'work:d1' } });
    const a = diff.sectionHashes(snapshot(), view, NOW);
    const s = snapshot();
    s.dispatches[1]!.note = 'changed';
    expect(diff.dirtySections(a, diff.sectionHashes(s, view, NOW))).toEqual(['deck', 'dispatches']);
    s.dispatches[0]!.note = 'changed too';
    expect(diff.dirtySections(a, diff.sectionHashes(s, view, NOW))).toEqual(['deck', 'dispatches', 'modal']);
  });

  it('a heartbeat crossing the stale line dirties its section with no data change', () => {
    const a = diff.sectionHashes(snapshot(), ui(), NOW);
    const later = NOW + 30 * 60_000;
    expect(diff.dirtySections(a, diff.sectionHashes(snapshot(), ui(), later)).sort()).toEqual(['chips', 'deck', 'traps']);
  });

  it('first render dirties every section; key order never matters', () => {
    const next = diff.sectionHashes(snapshot(), ui(), NOW);
    expect(diff.dirtySections(null, next).sort()).toEqual(
      ['chips', 'deck', 'dispatches', 'foot', 'modal', 'notices', 'prs', 'traps'],
    );
    expect(diff.stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(diff.stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }));
  });

  it('uses the URL hash and leaves hidden section hashes untouched until opened', () => {
    expect(diff.tabFromHash('')).toBe('deck');
    expect(diff.tabFromHash('#dispatches')).toBe('dispatches');
    expect(diff.tabFromHash('#unknown')).toBe('deck');
    const all = diff.sectionHashes(snapshot(), ui(), NOW);
    const rendered = Object.fromEntries(diff.visibleSections('deck').map((k) => [k, all[k]]));
    expect(rendered.prs).toBeUndefined();
    expect(diff.dirtySections(rendered, all)).toContain('prs');
  });

  it('the served page inlines the detector', async () => {
    const server = serveGlass(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    server.close();
    expect(page).toContain(GLASS_DIFF_JS.trim());
    // The whole inline script must still parse.
    const script = page.slice(page.indexOf('<script>') + 8, page.lastIndexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();
  });
});

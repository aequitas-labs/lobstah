import { describe, expect, it } from 'vitest';
import { GLASS_DIFF_JS } from '../src/glass-diff.js';
import { serveGlass } from '../src/glass.js';
import type { AddressInfo } from 'node:net';

// Evaluate exactly the source the page inlines — no jsdom, no DOM at all.
type Hashes = Record<string, string>;
type Ui = { st: Record<string, string>; open: Set<string>; modal: { type: string; key: string } | null };
const diff = new Function(`${GLASS_DIFF_JS}; return { sectionInputs, sectionHashes, dirtySections, stableStringify, tabFromHash, visibleSections };`)() as {
  sectionInputs: (d: unknown, ui: Ui, now: number) => Record<string, any>;
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

const table = (_headers: string[], rows: string[]) => `<table>${rows.join('')}</table>`;
const esc = (v: unknown) => String(v ?? '');
const ageEl = () => '1m';
/** The page's On deck renderer, evaluated from the served source (the detector supplies its constants). */
function deckRenderer(page: string): (d: unknown, inp: unknown) => string {
  const deckSource = page.slice(page.indexOf('const KIND_LABEL='), page.indexOf('const watchCell='));
  return new Function('esc', 'ageEl', 'table', 'prOpen', `${GLASS_DIFF_JS}; ${deckSource}; return renderDeck;`)(
    esc, ageEl, table, (p: { key: string }) => `showPr(${p.key})`,
  ) as (d: unknown, inp: unknown) => string;
}
async function servedPage(): Promise<string> {
  const server = serveGlass(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  server.close();
  return page;
}

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

  it('keeps PR standing out of On deck attention and hashes it with the PR section', () => {
    const d = {
      ...snapshot(),
      attention: [
        { kind: 'question', key: 'work:d1', id: 'd1', lane: 'work', verb: 'needs-decision', at: iso(10_000), note: 'answer me' },
        { kind: 'landed', key: 'work:d2', id: 'd2', lane: 'work', verb: 'done', at: iso(10_000), note: 'landed' },
        { kind: 'pr:checks', key: 'owner/repo#27', id: 'd2', lane: 'work', verb: 'pr:checks', at: iso(10_000), note: 'checks failed' },
        { kind: 'watch', key: 'watch:ci', id: 'd2', lane: 'work', verb: 'watch', at: iso(10_000), note: 'watch event' },
      ],
      stacks: [{ id: 'owner/repo#27', repo: 'web', numbers: [27], open: true, nextNumber: 27, behind: 0 }],
      prs: [{ key: 'owner/repo#27', number: 27, stackId: 'owner/repo#27', state: 'OPEN', position: 0, badge: { text: 'checks 1/2 failed', tone: 'bad' } }],
    };
    const deck = diff.sectionInputs(d, ui(), NOW).deck;
    expect(deck.attention.map((a: { kind: string }) => a.kind)).toEqual(['question', 'landed']);
    expect(deck.prAttention.map((a: { kind: string }) => a.kind)).toEqual(['pr:checks']);
    const before = diff.sectionHashes(d, ui(), NOW);
    const after = diff.sectionHashes({ ...d, prs: [{ ...d.prs[0], badge: { text: 'green', tone: 'ok' } }] }, ui(), NOW);
    expect(diff.dirtySections(before, after)).toContain('deck');
  });

  it('renders notices tables, PR cards, and full-width sibling sections on deck', async () => {
    const server = serveGlass(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    server.close();
    const renderDeck = deckRenderer(page);
    const noticeSource = page.slice(page.indexOf('function noticeTable('), page.indexOf('function trapRow('));
    const noticeTable = new Function('esc', 'ageEl', 'table', `${noticeSource}; return noticeTable;`)(esc, ageEl, table) as
      (list: unknown[]) => string;
    const p = { key: 'owner/repo#27', number: 27, stackId: 'owner/repo#27', position: 0, state: 'OPEN', repo: 'web', title: 'Fix checks', badge: { text: 'checks 1/2 failed', tone: 'bad' } };
    const inp = {
      view: 'cards', attention: [{ kind: 'question', id: 'd1', lane: 'work', verb: 'needs-decision', note: 'answer me', repo: 'web', at: iso(10_000) }],
      prAttention: [{ kind: 'pr:checks', key: p.key, acked: { at: iso(10_000), by: 'helm' } }],
      inflight: [], landed: [], traps: [], stacks: [{ id: p.stackId, numbers: [27], nextNumber: 27 }], prs: [p],
    };
    const html = renderDeck({}, inp);
    expect(page).toContain('.deckgrid{display:flex;flex-direction:column;gap:12px}');
    expect(page).toContain('.deckgrid h2{margin:5px 0}.deckgrid section{width:100%;min-width:0}');
    expect(html).toMatch(/^<div class="deckgrid"><section>/);
    expect(html).toMatch(/<\/section><section>/);
    expect(html.match(/<\/section><section>/g)).toHaveLength(4);
    expect(html).toMatch(/<\/section><\/div>$/);
    expect(html.slice(html.indexOf('attention →'), html.indexOf('in flight →'))).toContain('<table>');
    expect(html.slice(html.indexOf('attention →'), html.indexOf('in flight →'))).not.toContain('pr:checks');
    expect(html).toContain('class="card acked"');
    expect(html).toContain('class="badge bad">checks</span>');
    expect(noticeTable([{ kind: 'caught', text: 'one', repo: 'web', at: iso(10_000) }])).toContain('<table>');
    expect(page).toContain("setHTML('notices',noticeTable(inp.notices.list))");
    const stackLine = renderDeck({}, { ...inp, view: 'table' });
    expect(stackLine).toContain('#27 checks 1/2 failed');
  });

  it('On deck lands the newest eight catches of the last 24h, badging those past the cursor', async () => {
    const HOUR = 3600_000;
    // Ten catches in the last 24h (c0 newest, c9 oldest), one older; the cursor sits after the sixth (c4),
    // so the four newest, c0..c3, are unreported.
    const catches = Array.from({ length: 10 }, (_, i) => ({
      key: `work:c${i}`, id: `c${i}`, lane: 'work', verb: i === 2 ? 'failed' : 'done', at: iso((i + 1) * HOUR),
      note: `catch ${i}`, repo: 'web', unreported: i < 4,
    }));
    const old = { key: 'work:old', id: 'old', lane: 'work', verb: 'done', at: iso(25 * HOUR), note: 'yesterday', repo: 'web', unreported: false };
    // Shuffled on the wire: the page orders newest first itself.
    const d = { ...snapshot(), landed: [old, ...catches.slice().reverse()] };
    const deck = diff.sectionInputs(d, ui(), NOW).deck;
    expect(deck.landed.map((c: { id: string }) => c.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);

    const renderDeck = deckRenderer(await servedPage());
    const base = { view: 'table', attention: [], prAttention: [], inflight: [], traps: [], stacks: [], prs: [] };
    const html = renderDeck({}, { ...base, landed: deck.landed });
    const section = html.slice(html.indexOf('Landed · 24h'), html.indexOf('traps →'));
    expect(html).toContain('<h2><a href="#dispatches">Landed · 24h →</a></h2>');
    expect(html).not.toContain('landed since report');
    expect(section.match(/class="deckline/g)).toHaveLength(8);
    expect(section).not.toContain('deckmore');
    expect(section).not.toContain('old');
    const lines = section.split('<div class="deckline').slice(1);
    expect(lines.map((l) => l.includes('unreported'))).toEqual([true, true, true, true, false, false, false, false]);
    expect(lines[2]).toContain('class="badge bad">failed</span>');

    // An empty window: the section's empty state.
    const stale = diff.sectionInputs({ ...snapshot(), landed: [old] }, ui(), NOW).deck;
    expect(stale.landed).toEqual([]);
    const empty = renderDeck({}, { ...base, landed: stale.landed });
    expect(empty.slice(empty.indexOf('Landed · 24h'), empty.indexOf('traps →'))).toContain('<div class="empty">none</div>');
  });

  it('the served page inlines the detector', async () => {
    const server = serveGlass(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    server.close();
    expect(page).toContain(GLASS_DIFF_JS.trim());
    expect(page).toContain('#chain-control{display:inline-flex;align-items:center;gap:7px;white-space:nowrap}');
    expect(page).toContain('<label id="chain-control"><input id="f-chain" type="checkbox"> group by chain</label>');
    // A missing live helm hides the chip; the page must still ship both it and its detail modal.
    expect(page).toContain('inp.chips.helms.map');
    expect(page).toContain('showModal(\\\'helm\\\'');
    expect(page).toContain("modal.type==='helm'");
    expect(page).toContain('claude --resume ');
    expect(diff.sectionInputs(snapshot(), ui({ modal: { type: 'helm', key: 'fleet' } }), NOW).modal.item.x.man).toBe('claude @ x');
    // The whole inline script must still parse.
    const script = page.slice(page.indexOf('<script>') + 8, page.lastIndexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();
  });
});

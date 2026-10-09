import { describe, expect, it } from 'vitest';
import * as detector from '../src/glass-diff.js';

// The pure section selectors, imported exactly as the page's bundle imports
// them (the tests feed them partial snapshots: each section reads only its slice).
type Ui = { st: Record<string, string>; open: Set<string>; modal: { type: string; key: string } | null };
const diff = detector as unknown as {
  sectionInputs: (d: unknown, ui: Ui, now: number) => Record<string, any>;
  tabFromHash: (hash: string) => string;
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

describe('resume command', () => {
  it.each([
    ['claude', 'claude --resume session-id'],
    ['codex', 'codex resume session-id'],
    [undefined, undefined],
    ['unknown', undefined],
  ])('uses the %s harness without guessing', (harness, command) => {
    expect(detector.resumeCommand({ harness, sessionId: 'session-id' })).toBe(command);
  });
  it('requires a session id', () => {
    expect(detector.resumeCommand({ harness: 'codex' })).toBeUndefined();
  });
  it.each([
    { harness: 'codex', link: 'codex://threads/session-id' },
    { harness: 'codex', desktopThread: true },
    { harness: 'codex', window: { bundleId: 'com.openai.codex' } },
    { harness: 'claude', window: { entrypoint: 'claude-desktop' } },
    { harness: 'claude', link: 'claude://claude.ai/session-id' },
  ])('never offers a CLI command for desktop metadata %j', (session) => {
    expect(detector.desktopSession(session)).toBe(true);
    expect(detector.resumeCommand({ ...session, sessionId: 'session-id' })).toBeUndefined();
  });
  it('keeps terminal sessions inside Claude Desktop resumable', () => {
    expect(detector.resumeCommand({ harness: 'claude', sessionId: 'session-id', window: { bundleId: 'com.anthropic.claudefordesktop', entrypoint: 'cli' } })).toBe('claude --resume session-id');
  });
});

describe('glass section selectors', () => {
  it('finds a trap by its two-word name in the deck and Traps tab', () => {
    const s = { ...snapshot(), traps: [{ ...snapshot().traps[0]!, name: 'amber-gull', label: 'amber-gull (wt:aa)' }] };
    const input = diff.sectionInputs(s, ui({ st: { view: 'table', lane: '', repo: '', verb: '', q: 'AMBER-GULL' } }), NOW);
    expect(input.deck.traps.map((seat: { x: { trapId: string } }) => seat.x.trapId)).toEqual(['aa']);
    expect(input.traps.list.map((seat: { x: { trapId: string } }) => seat.x.trapId)).toEqual(['aa']);
  });

  it('keeps sign-on order across heartbeats and state changes, then signed-off order in both views', () => {
    const off = (trapId: string, kind: string, agoMs: number) => ({
      trapId,
      live: false,
      messages: [],
      notices: [{ kind, at: iso(agoMs), text: kind }],
      catches: [],
    });
    const live = (trapId: string, signedMs: number, beatMs: number) => ({
      trapId, name: trapId, live: true, signedOnAt: iso(signedMs), heartbeatAt: iso(beatMs),
      messages: [], notices: [], catches: [],
    });
    const traps = [off('s1', 'trap-stowed', 50 * 60_000), live('l2', 20 * 60_000, 10_000),
      off('g1', 'trap-ghosted', 60_000), live('l1', 30 * 60_000, 5 * 60_000),
      live('l3', 10 * 60_000, 2 * 60_000)];
    const ids = (seats: Array<{ x: { trapId: string } }>) => seats.map((seat) => seat.x.trapId);
    const ordered = (items: typeof traps) => {
      const input = diff.sectionInputs({ ...snapshot(), traps: items }, ui(), NOW);
      return [ids(input.deck.traps), ids(input.traps.list)];
    };
    const expected = ['l1', 'l2', 'l3', 'g1', 's1'];
    expect(ordered(traps)).toEqual([expected, expected]);
    expect(ordered(traps.map((t) => t.live ? { ...t, heartbeatAt: iso(t.trapId === 'l1' ? 2_000 : 2 * 60_000),
      claimed: t.trapId === 'l1' ? 'dispatch' : undefined, firstParkedAt: t.trapId === 'l2' ? undefined : iso(20 * 60_000) } : t)))
      .toEqual([expected, expected]);
  });

  it('routes the URL hash to a tab, deck by default', () => {
    expect(diff.tabFromHash('')).toBe('deck');
    expect(diff.tabFromHash('#dispatches')).toBe('dispatches');
    expect(diff.tabFromHash('#unknown')).toBe('deck');
  });

  it('a heartbeat crossing the stale line flips its seat with no data change', () => {
    const now = diff.sectionInputs(snapshot(), ui(), NOW);
    const later = diff.sectionInputs(snapshot(), ui(), NOW + 30 * 60_000);
    expect([now.chips.daemonStale, now.chips.helms[0].stale, now.traps.list[0].stale]).toEqual([false, false, false]);
    expect([later.chips.daemonStale, later.chips.helms[0].stale, later.traps.list[0].stale]).toEqual([true, true, true]);
  });

  it('filters dispatches by lane, repo, verb, and search; in flight ignores all but search', () => {
    const s = { ...snapshot(), dispatches: [dispatch('d1', 'working', 'on it'), { ...dispatch('d2', 'blocked', 'stuck'), lane: 'chore', repo: 'api' }] };
    const ids = (st: Record<string, string>) => diff.sectionInputs(s, ui({ st: { view: 'table', lane: '', repo: '', verb: '', q: '', ...st } }), NOW).dispatches.list.map((x: { id: string }) => x.id);
    expect(ids({})).toEqual(['d1', 'd2']);
    expect(ids({ lane: 'chore' })).toEqual(['d2']);
    expect(ids({ repo: 'web' })).toEqual(['d1']);
    expect(ids({ verb: 'blocked' })).toEqual(['d2']);
    expect(ids({ q: 'STUCK' })).toEqual(['d2']);
    const deck = diff.sectionInputs(s, ui({ st: { view: 'table', lane: 'chore', repo: 'api', verb: 'blocked', q: 'on it' } }), NOW).deck;
    expect(deck.inflight.map((x: { id: string }) => x.id)).toEqual(['d1']);
  });

  it('keeps PR standing out of On deck decisions; the deck carries it with the open PRs', () => {
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
    expect(deck.decisions.map((a: { kind: string }) => a.kind)).toEqual(['question']);
    expect(deck.prAttention.map((a: { kind: string }) => a.kind)).toEqual(['pr:checks']);
    expect(deck.prs.map((p: { number: number }) => p.number)).toEqual([27]);
  });

  it('On deck lands the newest eight catches of the last 24h, whatever the order on the wire', () => {
    const HOUR = 3600_000;
    // Ten catches in the last 24h (c0 newest, c9 oldest), one older.
    const catches = Array.from({ length: 10 }, (_, i) => ({
      key: `work:c${i}`, id: `c${i}`, lane: 'work', verb: i === 2 ? 'failed' : 'done', at: iso((i + 1) * HOUR),
      note: `catch ${i}`, repo: 'web', unreported: i < 4,
    }));
    const old = { key: 'work:old', id: 'old', lane: 'work', verb: 'done', at: iso(25 * HOUR), note: 'yesterday', repo: 'web', unreported: false };
    // Shuffled on the wire: the page orders newest first itself.
    const d = { ...snapshot(), landed: [old, ...catches.slice().reverse()] };
    const deck = diff.sectionInputs(d, ui(), NOW).deck;
    expect(deck.landed.map((c: { id: string }) => c.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
    expect(diff.sectionInputs({ ...snapshot(), landed: [old] }, ui(), NOW).deck.landed).toEqual([]);
  });

  it('the helm modal selects its helm by grounds', () => {
    expect(diff.sectionInputs(snapshot(), ui({ modal: { type: 'helm', key: 'fleet' } }), NOW).modal.item.x.man).toBe('claude @ x');
  });
});

describe('prBadgeClass — the glass colors the one prBadge derivation', () => {
  const cls = detector.prBadgeClass as (b: unknown) => string;
  it('fills conflicts GitHub red and behind grey; green stays GitHub open green', () => {
    expect(cls({ text: 'conflicts', tone: 'bad', state: 'open', merge: 'conflicts' })).toBe('pr-conflicts');
    expect(cls({ text: 'behind', tone: 'dim', state: 'open', merge: 'behind' })).toBe('pr-behind');
    expect(cls({ text: 'green', tone: 'ok', state: 'open' })).toBe('pr-open');
    expect(cls({ text: 'checks 1/2 failed', tone: 'bad', state: 'open' })).toBe('bad');
    expect(cls({ text: 'merged', tone: 'ok', state: 'merged', merge: 'conflicts' })).toBe('pr-merged');
  });
});

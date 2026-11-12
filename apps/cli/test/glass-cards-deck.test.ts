import { afterEach, describe, expect, it } from 'vitest';
import type { GlassFullSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, acceptanceFleet, ago } from './fixtures/glass-snapshots.js';

/**
 * Dispatch cards, the deck's two-line rows, and decision and run card rows
 * (components/card.ts, dispatches.ts, deck.ts, decisions.ts).
 */

let open: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

async function page(d: GlassFullSnapshot, hash: string, view: 'cards' | 'table') {
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, hash, prefs: { view } });
  open.push(g);
  return g;
}

function fleet(): GlassFullSnapshot {
  const d = acceptanceFleet();
  d.viewer = { onMachine: false, windowFocus: false, machine: 'studio', device: 'phone' };
  d.trapNames = { ...(d.trapNames ?? {}), t1: 'hardy-kelp', t2: 'pearl-gull' };
  return d;
}

describe('a dispatch card', () => {
  it('shows its instruction and status, then its repo, trap and age, and nothing else', async () => {
    const d = fleet();
    const x = d.dispatches.find((y) => y.id.startsWith('cccccccc'))!;
    const g = await page(d, '#dispatches', 'cards');
    const card = g.$$('#dispatches .card').find((c) => c.querySelector('.gtitle')?.getAttribute('title')?.startsWith('cccccccc'))!;
    // The title is the brief's first line (the server's briefTitle).
    expect(text(card.querySelector('.gtitle'))).toBe(x.brief.split('\n')[0]!.trim());
    expect(card.querySelector('.verbicon')!.getAttribute('aria-label')).toMatch(/^Needs decision · \S+$/);
    expect(text(card.querySelector('.gcontext'))).toMatch(/^web · 🪤 hardy-kelp · \d+\w ago$/);
    // The repo carries GitHub's repo icon, which reads as nothing: the name is the text.
    expect(card.querySelector('.gcontext .reponame svg.repoicon')?.getAttribute('aria-hidden')).toBe('true');
    // The id, note, worker, PR, waiting and activity lines are in the dispatch's modal.
    expect(card.querySelector('.gnow')).toBeNull();
    expect(card.querySelector('.gfoot')).toBeNull();
    expect(card.querySelector('.gicon')).toBeNull();
    expect(text(card)).not.toContain(x.note ?? '');
  });

  it("keeps the Dispatches table's columns", async () => {
    const g = await page(fleet(), '#dispatches', 'table');
    expect(g.$$('#dispatches th').map((th) => text(th))).toEqual(['id', 'lane / bucket', 'repo', 'verb', 'note', 'age', 'addressed', 'pr']);
  });
});

describe('the deck', () => {
  it('lists each in-flight dispatch as two lines, its status at the right of the first', async () => {
    const g = await page(fleet(), '#deck', 'table');
    const rows = [...g.$$('#deck section')[1]!.querySelectorAll('.deckrow')];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const [first, second] = [...row.querySelectorAll(':scope > .gline')];
      // Its verb's icon in a pill; a queued dispatch keeps its word.
      expect(first!.lastElementChild!.className).toMatch(/^(runicon verbicon verb-|gchip )/);
      expect(second).toBeTruthy();
    }
  });

  it('highlights an unread decision with no status edge or word, and plain once read', async () => {
    const d = fleet();
    const at = ago(60_000);
    d.decisions = [
      { key: 'decision:new', dispatch: d.dispatches[0]!.id, lane: 'work', title: 'Which base?', detail: 'x', options: ['a'], attachments: [], askedBy: 'helm', askedAt: at, stateHash: 'h' },
      { key: 'decision:seen', dispatch: d.dispatches[0]!.id, lane: 'work', title: 'Which name?', detail: 'x', options: ['a'], attachments: [], askedBy: 'helm', askedAt: at, stateHash: 'h2', viewedAt: at },
    ] as GlassFullSnapshot['decisions'];
    d.attention = [
      ...d.attention,
      ...['decision:new', 'decision:seen'].map((key) => ({ kind: 'decision' as const, key, stateHash: 'h', id: d.dispatches[0]!.id, lane: 'work' as const, verb: 'decision', ageSecs: 60, at, standingSince: at, note: key })),
    ] as GlassFullSnapshot['attention'];
    const g = await page(d, '#deck', 'table');
    const unread = g.$('#deck .drow[data-decision="decision:new"]')!;
    const read = g.$('#deck .drow[data-decision="decision:seen"]')!;
    expect(unread.className).toContain('unread');
    expect(read.className).not.toContain('unread');
    for (const row of [unread, read]) {
      expect(row.querySelector('.gchip, .gword, .dstate')).toBeNull();
      expect(row.className).not.toContain('gcard-edge');
      // One row, the whole of it the button that opens the decision: no separate Answer.
      expect(row.querySelectorAll('button')).toHaveLength(1);
      expect(row.querySelector('.dopen .dtitle')).toBeTruthy();
      expect(row.querySelector('.dopen .dmeta')).toBeTruthy();
    }
  });

  it('shows a run card as a decision row that names its boat', async () => {
    const d = fleet();
    const at = ago(60_000);
    d.decisions = [
      {
        key: 'decision:run',
        dispatch: d.dispatches[0]!.id,
        lane: 'work',
        title: 'Run the migration check',
        detail: 'x',
        options: [],
        attachments: [],
        askedBy: 'helm',
        askedAt: at,
        stateHash: 'h',
        run: { scriptSha256: 'a'.repeat(64), scriptBytes: 10, inputs: [], cwd: '/r', timeoutSecs: 300, output: 'scrubbed', interpreter: '/bin/bash', script: 'echo hi', warnings: [] },
      },
    ] as GlassFullSnapshot['decisions'];
    d.attention = [...d.attention, { kind: 'decision', key: 'decision:run', stateHash: 'h', id: d.dispatches[0]!.id, lane: 'work', verb: 'decision', ageSecs: 60, at, standingSince: at, note: 'run' }] as GlassFullSnapshot['attention'];
    const g = await page(d, '#deck', 'table');
    const row = g.$('#deck .drow[data-decision="decision:run"]')!;
    expect(text(row.querySelector('.dtitle'))).toBe('Run the migration check');
    expect(row.querySelectorAll('button')).toHaveLength(1);
    expect(text(row.querySelector('.dopen .dboat'))).toBe('⛵ studio');
  });

  it("shows a run card's run state in its row once it has run", async () => {
    const d = fleet();
    const at = ago(60_000);
    const run = { scriptSha256: 'a'.repeat(64), scriptBytes: 10, inputs: [], cwd: '/r', timeoutSecs: 300, output: 'scrubbed', interpreter: '/bin/bash', script: 'echo hi', warnings: [] };
    const latest = { id: '1', key: 'decision:run', scriptSha256: 'a'.repeat(64), state: 'failed', startedAt: at, finishedAt: at, result: { exitCode: 3, timedOut: false, durationMs: 1, outputBytes: 0, scrubbed: 0 } };
    d.decisions = [
      { key: 'decision:run', dispatch: d.dispatches[0]!.id, lane: 'work', title: 'Run the check', detail: 'x', options: [], attachments: [], askedBy: 'helm', askedAt: at, stateHash: 'h', run: { ...run, latest } },
    ] as GlassFullSnapshot['decisions'];
    d.attention = [...d.attention, { kind: 'decision', key: 'decision:run', stateHash: 'h', id: d.dispatches[0]!.id, lane: 'work', verb: 'decision', ageSecs: 60, at, standingSince: at, note: 'run' }] as GlassFullSnapshot['attention'];
    const g = await page(d, '#deck', 'table');
    const row = g.$('#deck .drow[data-decision="decision:run"]')!;
    expect(row.querySelectorAll('button')).toHaveLength(1);
    // Its state is an icon: a red X, named and titled with the words, the exit code and how long it ran.
    const icon = row.querySelector('.dopen .dsent .runicon')!;
    expect(icon.className).toContain('run-failed bad');
    expect([icon.getAttribute('role'), icon.getAttribute('aria-label'), icon.getAttribute('title')]).toEqual(['img', 'Failed · exit 3 · 1ms', 'Failed · exit 3 · 1ms']);
    expect(text(row.querySelector('.dopen .dsent'))).toBe('');
    expect(text(row.querySelector('.dboat'))).toBe('⛵ studio');
  });
});

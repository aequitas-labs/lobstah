import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { GlassRunCard, RunResult } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { runDuration, runStatus, runStatusLabel } from '../../../packages/glass-ui/ui/components/run-status.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW } from './fixtures/glass-snapshots.js';
import { RUN_KEY, glassRun, runCardFleet } from './fixtures/run-card.js';

/**
 * A run card's state is an icon (components/run-status.ts): a green check,
 * a red X, a red clock, an amber spinner, a grey square or a grey slashed
 * circle, each named and titled with its words, exit code and duration.
 */

const open: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((g) => g.close()));
});

const result = (over: Partial<RunResult>): RunResult => ({ exitCode: 0, timedOut: false, durationMs: 4200, outputBytes: 0, scrubbed: 0, ...over });
const latest = (state: NonNullable<GlassRunCard['latest']>['state'], r?: RunResult): GlassRunCard['latest'] => ({
  id: '11111111-1111-4111-8111-111111111111',
  key: RUN_KEY,
  scriptSha256: glassRun().scriptSha256,
  state,
  startedAt: new Date(NOW - 60_000).toISOString(),
  ...(r ? { finishedAt: new Date(NOW).toISOString(), result: r } : {}),
});

describe('run status words', () => {
  it('reads a status from a run on its way, its result, or its record', () => {
    expect(runStatus('succeeded', result({}), true)).toBe('running');
    expect(runStatus('failed', result({ exitCode: 124, timedOut: true }))).toBe('timed-out');
    expect(runStatus('stopped', result({ exitCode: 143, stopped: true }))).toBe('stopped');
    expect(runStatus('failed', result({ exitCode: 2 }))).toBe('failed');
    expect(runStatus('succeeded', result({}))).toBe('succeeded');
    expect(runStatus('failed', undefined)).toBe('failed');
    expect(runStatus(undefined, undefined)).toBeUndefined();
  });

  it('says how long a run took', () => {
    expect([850, 4200, 42_000, 192_000, 3_840_000].map(runDuration)).toEqual(['850ms', '4.2s', '42s', '3m 12s', '1h 4m']);
  });

  it('names the status, then the exit code and duration; a stopped run has no exit code to report', () => {
    expect(runStatusLabel('succeeded', result({}))).toBe('Succeeded · exit 0 · 4.2s');
    expect(runStatusLabel('failed', result({ exitCode: 3, durationMs: 72_000 }))).toBe('Failed · exit 3 · 1m 12s');
    expect(runStatusLabel('timed-out', result({ exitCode: 124, timedOut: true, durationMs: 300_000 }))).toBe('Timed out · exit 124 · 5m 0s');
    expect(runStatusLabel('stopped', result({ exitCode: 143, stopped: true, durationMs: 12_000 }))).toBe('Stopped · 12s');
    expect(runStatusLabel('declined')).toBe('Declined');
  });
});

describe('a run card shows its state as an icon', () => {
  async function modal(card: GlassRunCard, post?: () => { status: number; body: unknown }) {
    const g = await loadGlass(GLASS_PAGE, runCardFleet(card), { now: NOW, hash: `#decision/${encodeURIComponent(RUN_KEY)}`, ...(post ? { post } : {}) });
    open.push(g);
    return g;
  }
  const icon = (g: GlassDom, at = '#doverlay .runstate') => g.$(`${at} .runicon`)!;

  it.each([
    ['succeeded', 'ok', latest('succeeded', result({})), 'Succeeded · exit 0 · 4.2s'],
    ['failed', 'bad', latest('failed', result({ exitCode: 3, durationMs: 72_000 })), 'Failed · exit 3 · 1m 12s'],
    ['timed-out', 'bad', latest('failed', result({ exitCode: 124, timedOut: true, durationMs: 300_000 })), 'Timed out · exit 124 · 5m 0s'],
    ['stopped', 'dim', latest('stopped', result({ exitCode: 143, stopped: true, durationMs: 12_000 })), 'Stopped · 12s'],
  ] as const)('%s: its icon in its tone, named and titled with its words, and no status text', async (status, tone, last, label) => {
    const g = await modal(glassRun(undefined, { inputs: [], latest: last }));
    const i = icon(g);
    expect(i.className).toBe(`runicon run-${status} ${tone}`);
    expect([i.getAttribute('role'), i.getAttribute('aria-label'), i.getAttribute('title')]).toEqual(['img', label, label]);
    expect(i.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(g.$('#doverlay .runstate')!.textContent!.trim()).toBe(status === 'stopped' ? 'Stopped by you' : '');
  });

  it('running: an amber spinner, with a still dot for reduced motion, named with when it started', async () => {
    const g = await modal(glassRun(undefined, { inputs: [], latest: latest('running') }), () => ({ status: 500, body: { ok: false } }));
    const i = icon(g);
    expect(i.className).toBe('runicon run-running warn');
    expect(i.getAttribute('aria-label')).toMatch(/^Running · started /);
    expect(i.querySelector('.runspin')).toBeTruthy();
    expect(i.querySelector('.rundot')).toBeTruthy();
    const css = fs.readFileSync(new URL('../../../packages/glass-ui/ui/glass.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.runicon \.runspin \{[^}]*animation: runspin/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.runicon \.runspin \{\s*display: none;\s*\}\s*\.runicon \.rundot \{\s*display: inline;/);
  });

  it('keeps elapsed time moving through silence, even when the output poll fails', async () => {
    const last = { ...latest('running')!, startedAt: new Date(NOW - 161_000).toISOString() };
    const g = await modal(glassRun(undefined, { inputs: [], latest: last }), () => ({ status: 500, body: { ok: false } }));
    expect(g.$('#doverlay .runstate')!.textContent).toContain('Running · 2m 41s');
    g.window.Date.now = () => NOW + 1000;
    await g.poll();
    expect(g.$('#doverlay .runstate')!.textContent).toContain('Running · 2m 42s');
    expect(g.$('#doverlay .runlog')).toBeNull();
  });

  it.each(['scrubbed', 'exit'] as const)('shows the last six live lines only for scrubbed output (%s)', async (output) => {
    const last = latest('running')!;
    let polls = 0;
    const raw = Array.from({ length: 12 }, (_, i) => `line-${i}`).join('\n');
    const g = await modal(glassRun(undefined, { inputs: [], output, latest: last }), () => (++polls === 1
      ? { status: 200, body: { ok: true, ...last, text: raw, next: raw.length } }
      : { status: 500, body: { ok: false } }));
    expect(g.$('#doverlay .runstate')!.textContent).toContain('Running · 1m 0s');
    if (output === 'exit') expect(g.$('#doverlay .runlog')).toBeNull();
    else expect(g.$('#doverlay .runlog')!.textContent).toBe('line-6\nline-7\nline-8\nline-9\nline-10\nline-11');
  });

  it('shows a stopped run and the captured output after a reload', async () => {
    const last = latest('stopped', result({ stopped: true, exitCode: 130 }))!;
    const g = await modal(glassRun(undefined, { inputs: [], latest: last }), () => ({ status: 200, body: { ok: true, ...last, text: 'finished 12 of 40 rows\n', next: 23 } }));
    expect(g.$('#doverlay .runstate')!.textContent).toContain('Stopped by you');
    expect(g.$('#doverlay .runlog')!.textContent).toBe('finished 12 of 40 rows');
  });

  it('the deck row shows the same icon, and a declined card the declined one', async () => {
    const d = runCardFleet(glassRun(undefined, { inputs: [], latest: latest('failed', result({ exitCode: 3 })) }));
    const g = await loadGlass(GLASS_PAGE, d, { now: NOW, hash: '#deck' });
    open.push(g);
    const row = () => g.$(`#deck .drow[data-decision="${RUN_KEY}"]`)!;
    expect(row().querySelector('.dsent .runicon')!.getAttribute('aria-label')).toBe('Failed · exit 3 · 4.2s');

    const fresh = await loadGlass(GLASS_PAGE, runCardFleet(glassRun(undefined, { inputs: [] })), {
      now: NOW,
      hash: `#decision/${encodeURIComponent(RUN_KEY)}`,
      post: () => ({ status: 201, body: { ok: true, id: 'r1' } }),
    });
    open.push(fresh);
    (fresh.$$('#doverlay .dopt').find((b) => b.textContent?.includes('Decline')) as HTMLButtonElement).click();
    await fresh.settle();
    await fresh.go('#deck');
    const declined = fresh.$(`#deck .drow[data-decision="${RUN_KEY}"] .dsent .runicon`)!;
    expect(declined.className).toBe('runicon run-declined dim');
    expect(declined.getAttribute('aria-label')).toBe('Declined');
  });
});

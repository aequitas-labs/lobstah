import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RecentRun } from '@lobstah/core';
import { askDecision, ensureLayout, prepareRunCard, readDecision, writeRunAttempt } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { buildGlassSnapshot } from '../src/glass.js';
import { createRunCleanup, RUN_PRUNE_EVERY_MS, RUN_RETIRE_EVERY_MS } from '../src/run-cleanup.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { emptyFleet, NOW } from './fixtures/glass-snapshots.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/** Finished runs leave the deck's decisions for a closed Recent runs list; the daemon withdraws their cards. */

let pages: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(pages.map((g) => g.close()));
  pages = [];
});

const MIN = 60_000;
const run = (title: string, state: RecentRun['state'], ago: number, exitCode = state === 'failed' ? 2 : 0): RecentRun => ({
  key: `decision:${title.length.toString(16).padStart(8, '0')}`,
  title,
  state,
  exitCode,
  finishedAt: new Date(NOW - ago).toISOString(),
  repo: 'lobstah',
});

describe('Recent runs on the deck', () => {
  it('lists finished runs in a closed section under decisions, each opening its card', async () => {
    const d = emptyFleet();
    d.recentRuns = [run('Publish the package', 'succeeded', 5 * MIN), run('Rotate the key', 'failed', 60 * MIN), run('Tail the logs', 'stopped', 120 * MIN)];
    const g = await loadGlass(GLASS_PAGE, d, { now: NOW, hash: '#deck' });
    pages.push(g);
    const section = g.$('#deck .decisions .recent-runs') as HTMLDetailsElement;
    expect(section.open).toBe(false);
    expect(section.querySelector('summary')!.textContent).toBe('Recent runs (3)');
    const rows = g.$$('#deck .recent-runs .recent-run');
    expect(rows.map((r) => r.querySelector('.dtitle')!.textContent)).toEqual(['Publish the package', 'Rotate the key', 'Tail the logs']);
    expect(rows.map((r) => r.querySelector('.badge')!.textContent)).toEqual(['succeeded', 'failed', 'stopped']);
    expect(rows[1]!.textContent).toContain('exit 2');
    expect(rows[0]!.querySelector('a')!.getAttribute('href')).toBe(`#decision/${encodeURIComponent(d.recentRuns[0]!.key)}`);
  });

  it('shows no section when nothing ran', async () => {
    const g = await loadGlass(GLASS_PAGE, emptyFleet(), { now: NOW, hash: '#deck' });
    pages.push(g);
    expect(g.$('#deck .recent-runs')).toBeNull();
  });
});

describe('the run cleanup on the daemon and the glass', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-recent-runs-'));
    process.env.LOBSTAH_HOME = home;
    ensureLayout();
  });
  afterEach(() => {
    removeTempDir(home);
    delete process.env.LOBSTAH_HOME;
  });

  function finished(title: string, endedAgo: number): string {
    const scriptFile = path.join(home, `${title.replace(/\W/g, '')}.sh`);
    fs.writeFileSync(scriptFile, 'echo harmless\n');
    const prepared = prepareRunCard({ scriptFile, cwd: home });
    const { meta } = askDecision({ title, askedBy: 'helm', options: ['Decline'], run: prepared, maxBytes: 1024 });
    const at = Date.now() - endedAgo;
    writeRunAttempt({ id: `22222222-2222-4222-8222-${String(endedAgo).padStart(12, '0')}`, key: meta.key, scriptSha256: prepared.card.scriptSha256, state: 'succeeded',
      startedAt: new Date(at - MIN).toISOString(), finishedAt: new Date(at).toISOString(), result: { exitCode: 0, timedOut: false, durationMs: MIN, outputBytes: 3, scrubbed: 0 } }, 'ok\n');
    return meta.key;
  }

  it('the snapshot moves a run past its grace period from decisions to Recent runs', () => {
    finished('Just finished', 30_000);
    finished('Finished earlier', 10 * MIN);
    const snapshot = buildGlassSnapshot();
    expect(snapshot.decisions?.map((d) => d.title)).toEqual(['Just finished']);
    expect(snapshot.recentRuns?.map((r) => r.title)).toEqual(['Finished earlier']);
  });

  it('the daemon withdraws finished cards every 30 seconds, not every tick', () => {
    const key = finished('Finished earlier', 10 * MIN);
    const logs: string[] = [];
    const cleanup = createRunCleanup();
    const now = Date.now();
    cleanup(now, (m) => logs.push(m));
    expect(readDecision(key)).toBeUndefined();
    expect(logs).toContain('run cleanup: 1 finished run card(s) left the glass');
    const second = finished('Also finished earlier', 11 * MIN);
    cleanup(now + RUN_RETIRE_EVERY_MS - 1, () => {});
    expect(readDecision(second)).toBeDefined();
    cleanup(now + RUN_RETIRE_EVERY_MS, () => {});
    expect(readDecision(second)).toBeUndefined();
    expect(RUN_PRUNE_EVERY_MS).toBe(3_600_000);
  });
});

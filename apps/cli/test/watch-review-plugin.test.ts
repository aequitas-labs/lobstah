import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'smol-toml';
import { registerInstalledWatch, watchInventory, watchSurfaceItems, watchSurfaceSources, WatchJournal, WatchRuntime } from '@lobstah/core';
import { disposeWatchPlugins, validateWatchPresentation } from '@lobstah/watch-types';
import { createCliWatchRegistry } from '../src/watch-automation.js';
import { runWatchItemAction } from '../src/watch-item-actions.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const plugin = fileURLToPath(new URL('../../../packages/watch-types/test/fixtures/review-plugin.mjs', import.meta.url));
let home: string;
let history: string;
let effects: string;
const configure = (command: string[]) =>
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    stringify({
      schemaVersion: 2,
      watchTypes: { 'fixture-reviews': { module: 'process', command, version: '1.0.0', allowCapabilities: ['poll', 'actions'], envAllow: ['FIXTURE_EFFECTS'] } },
    }),
  );
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-review-plugin-'));
  process.env.LOBSTAH_HOME = home;
  history = path.join(home, 'history.json');
  effects = path.join(home, 'effects.ndjson');
  vi.stubEnv('FIXTURE_EFFECTS', effects);
  fs.writeFileSync(history, JSON.stringify({ cursor: 1 }));
  configure([process.execPath, plugin]);
});
afterEach(async () => {
  await disposeWatchPlugins();
  vi.unstubAllEnvs();
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

function observe(): WatchRuntime {
  const registry = createCliWatchRegistry(() => {});
  const snapshot = registerInstalledWatch('fixture-reviews:one', { kind: 'helm', grounds: 'home' }, { history }, 'fixture-reviews', registry);
  expect(snapshot?.key).toBe('fixture-reviews:one');
  const runtime = new WatchRuntime(registry);
  runtime.checkSync('fixture-reviews:one', { everySecs: 0, now: Date.now() + 1000 });
  return runtime;
}

describe('a third review source as a process plugin', () => {
  it('fills the same slots as built-ins in every lifecycle phase, validated as presentation v2', () => {
    observe();
    const stored = new WatchJournal().read('fixture-reviews:one')!;
    expect(stored.type.installation?.kind).toBe('process');
    expect(() => validateWatchPresentation(stored.presentation, 2)).not.toThrow();
    const items = watchSurfaceItems('reviews');
    expect(items.map(({ item }) => [item.id, item.lifecycle.phase, item.lifecycle.archived ?? false])).toEqual([
      ['active', 'active', false],
      ['completed', 'completed', false],
      ['closed', 'closed', false],
      ['archived', 'completed', true],
    ]);
    expect(items[0]!.source).toEqual({ id: 'fixture-reviews', name: 'Fixture reviews', icon: { glyph: 'source' } });
  });

  it('renders from the cache after a restart without starting the plugin', async () => {
    observe();
    await disposeWatchPlugins();
    // The configured executable no longer exists: any start would fail.
    configure([path.join(home, 'missing-plugin')]);
    expect(watchSurfaceItems('reviews')).toHaveLength(4);
    const [row] = watchInventory({ everySecs: 45, daemonHeartbeat: new Date().toISOString() }).filter((entry) => entry.type === 'fixture-reviews');
    expect(row).toMatchObject({ source: { name: 'Fixture reviews' }, glyph: 'bell', health: 'healthy', links: [{ url: 'https://fixture.example.test/' }] });
  });

  it('runs its authorized action once, with a receipt, through the generic gateway', async () => {
    observe();
    const entry = watchSurfaceItems('reviews').find(({ item }) => item.id === 'active')!;
    const payload = { watch: entry.watch.key, generation: entry.watch.generation, item: 'active', control: 'approve', revision: entry.item.revision, idempotencyKey: 'click-1' };
    const registry = createCliWatchRegistry(() => {});
    expect(await runWatchItemAction(payload, 'glass', { registry })).toEqual({ status: 200, body: { ok: true } });
    expect(await runWatchItemAction(payload, 'glass', { registry })).toEqual({ status: 200, body: { ok: true } });
    const lines = fs.readFileSync(effects, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toEqual([{ action: 'approve', arguments: { item: 'active', values: { verdict: 'approve' } }, by: 'glass' }]);
    const receipts = new WatchJournal().read('fixture-reviews:one')!.actionReceipts!;
    expect(receipts.map((receipt) => [receipt.request.actionId, receipt.status, receipt.idempotencyKey])).toEqual([['approve', 'done', 'click-1']]);
  });

  it('keeps its last items, marked by the source, when its provider fails', () => {
    const runtime = observe();
    fs.writeFileSync(history, JSON.stringify({ mode: 'fail' }));
    runtime.checkSync('fixture-reviews:one', { everySecs: 0, now: Date.now() + 120_000 });
    expect(watchSurfaceItems('reviews')).toHaveLength(4);
    expect(watchSurfaceSources('reviews')).toEqual([
      expect.objectContaining({ source: expect.objectContaining({ id: 'fixture-reviews' }), health: 'stale', message: 'Fixture provider is down' }),
    ]);
  });
});

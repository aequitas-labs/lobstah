import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommandWatchType, WatchRegistry } from '@lobstah/watch-types';
import {
  appendStatus,
  builtinWatchRegistry,
  enqueue,
  ensureLayout,
  pendingIds,
  pendingWatchEvents,
  postNotice,
  releaseHeldWatches,
  runWatchCycle,
  signOnTrap,
  stowTrap,
  syncLocalWatchSources,
  unseenNotices,
  WatchRuntime,
} from '@lobstah/core';
import { buildTendReport, renderTend } from '../src/tend.js';
import { watchDoctorRow } from '../src/watch-doctor.js';
import { soakPark } from '../src/trap-park.js';
import { watchLoop } from '../../pick/src/loops/watch.js';
import { writeAck } from '../src/acks.js';
import { removeTempDir } from '../../../test/temp-dir.js';
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-local-watch-'));
  vi.stubEnv('LOBSTAH_HOME', home);
  ensureLayout();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  removeTempDir(home);
});

it('checkpoints a quiet notice and lists it in tend without a helm wake', () => {
  postNotice({ kind: 'caches-cleared', text: 'Removed a small stale cache.', quiet: true });
  const registry = builtinWatchRegistry();
  syncLocalWatchSources(registry);
  expect(unseenNotices(true)).toEqual([]);
  expect(buildTendReport().notices).toContainEqual(
    expect.objectContaining({ kind: 'caches-cleared', text: 'Removed a small stale cache.' }),
  );
  const snapshot = new WatchRuntime(registry).journal.read('local-notices:home')!;
  expect(snapshot.events).toEqual([]);
  expect(snapshot.state).toMatchObject({ rows: [{ label: 'caches-cleared', value: 'Removed a small stale cache.' }] });
});

it('preserves a question’s acknowledgment and state hash across local checkpoints', () => {
  const id = '22222222-2222-4222-8222-222222222222';
  enqueue({ id, repo: 'web', brief: 'Local signal fixture' });
  appendStatus(id, 'work', 'needs-decision', 'Choose the next step');
  const registry = builtinWatchRegistry(),
    now = Date.now();
  syncLocalWatchSources(registry, now);
  const before = buildTendReport(now).attention.find((item) => item.kind === 'question')!;
  writeAck({ key: before.key, kind: before.kind, stateHash: before.stateHash, at: new Date(now).toISOString(), by: 'fixture' });
  syncLocalWatchSources(registry, now + 60_000);
  expect(buildTendReport(now + 60_000).attention.find((item) => item.kind === 'question')).toMatchObject({
    key: before.key,
    stateHash: before.stateHash,
    acked: { by: 'fixture' },
  });
});

it('shows a source-supplied held remedy when the installed adapter cannot restore its state version', () => {
  class FutureSource extends CommandWatchType {
    readonly descriptor = { id: 'future-source', apiVersion: 1 as const, stateVersion: 1, version: '1.0.0' };
    failure(error: unknown) {
      return { kind: 'upgrade', message: String(error), remedy: 'Install future-source v2, then release this watch.' };
    }
  }
  const registry = new WatchRegistry();
  registry.register(new FutureSource());
  const runtime = new WatchRuntime(registry);
  runtime.register('future-source', 'future:item', { check: 'unused' }, { kind: 'helm', grounds: 'home' });
  runtime.journal.update('future:item', (snapshot) => {
    snapshot!.type.stateVersion = 2;
    return { snapshot, result: undefined };
  });
  runtime.checkSync('future:item');
  expect(runtime.journal.read('future:item')).toMatchObject({
    status: 'held',
    failure: { hold: true, remedy: 'Install future-source v2, then release this watch.' },
  });
  const report = buildTendReport();
  expect(report.watches.find((watch) => watch.key === 'future:item')).toMatchObject({
    heldAt: expect.any(String),
    type: { id: 'future-source', stateVersion: 2 },
  });
  expect(renderTend(report)).toContain('Install future-source v2');
  expect(watchDoctorRow(registry)).toMatchObject({ status: 'warn', detail: expect.stringContaining('Install future-source v2') });
  expect(() => releaseHeldWatches('future:item', registry)).toThrow();
  expect(runtime.journal.read('future:item')?.status).toBe('held');
  runtime.journal.update('future:item', (snapshot) => {
    snapshot!.type.stateVersion = 1;
    return { snapshot, result: undefined };
  });
  expect(releaseHeldWatches('future:item', registry)).toEqual(['future:item']);
  expect(runtime.journal.read('future:item')?.status).toBe('watching');
});

it('polls a native journal watch through the same source cycle without a legacy command record', () => {
  class NativeSignal extends CommandWatchType {
    readonly descriptor = { id: 'native-signal', apiVersion: 1 as const, stateVersion: 1, version: '1.0.0' };
    poll() {
      return {
        cursor: '1',
        events: [{ id: '1', kind: 'signal', summary: 'Native observation', at: new Date().toISOString(), data: null }],
      };
    }
  }
  const registry = new WatchRegistry();
  registry.register(new NativeSignal());
  const runtime = new WatchRuntime(registry);
  runtime.register('native-signal', 'signal:item', { check: 'unused' }, { kind: 'helm', grounds: 'home' });
  const result = runWatchCycle(45, new Date(), { registry });
  expect(result[0]?.fresh).toMatchObject([{ seq: '1', summary: 'Native observation' }]);
  expect(pendingWatchEvents(false, 'man')[0]?.events).toHaveLength(1);
});

it('buffers direct trap feedback through stow and re-soak, wakes the Stop hook and exposes the owner inbox without a headless dispatch', async () => {
  const signed = signOnTrap({ sessionId: 'first-session', harness: 'claude', worktree: home, cwd: home, ttlMs: 600_000 });
  if (!('ok' in signed)) throw new Error('trap held');
  const trapId = signed.ok.trapId,
    runtime = new WatchRuntime(builtinWatchRegistry());
  runtime.register(
    'command',
    'fixture:trap',
    { check: 'unused', brief: 'Read the fixture feedback before continuing.' },
    { kind: 'trap', trapId, grounds: 'home' },
  );
  stowTrap(trapId);
  runtime.journal.update('fixture:trap', (snapshot) => {
    snapshot!.events.push({ id: 'feedback-1', kind: 'feedback', summary: 'Buffered feedback', at: new Date().toISOString(), data: null });
    snapshot!.deliveries.push({ id: 'receipt-1', eventIds: ['feedback-1'], status: 'pending' });
    return { snapshot, result: undefined };
  });
  expect(pendingWatchEvents(false, `trap:${trapId}`)[0]?.events).toHaveLength(1);
  const resumed = signOnTrap({ sessionId: 'resumed-session', harness: 'claude', worktree: home, cwd: home, ttlMs: 600_000 });
  expect('ok' in resumed && resumed.ok.trapId).toBe(trapId);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await soakPark(trapId, '0')).toBe('woke');
  expect(output.mock.calls[0]?.[0]).toContain('Buffered feedback');
  expect(output.mock.calls[0]?.[0]).toContain(`watch inbox --owner wt:${trapId}`);
  expect(pendingIds('work')).toEqual([]);
  const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  const read = spawnSync(process.execPath, [cli, 'watch', 'inbox', '--owner', `wt:${trapId}`], {
    env: process.env,
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(read.status, read.stdout + read.stderr).toBe(0);
  expect(read.stdout).toContain('Buffered feedback');
  expect(read.stdout).toContain('Read the fixture feedback before continuing.');
  expect(pendingWatchEvents(false, `trap:${trapId}`)).toEqual([]);
  expect(pendingIds('work')).toEqual([]);
});

it('closes a native adapter once after its completed observation tail is consumed', async () => {
  let closed = 0;
  class CompletedSource extends CommandWatchType {
    readonly descriptor = { id: 'completed-source', apiVersion: 1 as const, stateVersion: 1, version: '1.0.0' };
    poll() {
      return {
        cursor: '1',
        done: true,
        events: [{ id: '1', kind: 'completed', summary: 'Completed source tail', at: new Date().toISOString(), data: null }],
      };
    }
    close(): void {
      closed++;
    }
  }
  const registry = new WatchRegistry();
  registry.register(new CompletedSource());
  const runtime = new WatchRuntime(registry);
  runtime.register('completed-source', 'completed:item', { check: 'unused' }, { kind: 'helm', grounds: 'home' });
  await watchLoop(45, () => {}, undefined, registry);
  expect(runtime.journal.read('completed:item')?.status).toBe('draining');
  expect(closed).toBe(0);
  pendingWatchEvents(true);
  await watchLoop(45, () => {}, undefined, registry);
  await watchLoop(45, () => {}, undefined, registry);
  expect(runtime.journal.read('completed:item')?.status).toBe('retired');
  expect(closed).toBe(1);
});

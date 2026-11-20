import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandWatchType, WatchRegistry } from '@lobstah/watch-types';
import type { WatchSnapshot } from '@lobstah/watch-types';
import { WatchJournal } from '../src/watch-journal.js';
import { WatchRuntime } from '../src/watch-runtime.js';
import { watchInventory } from '../src/watch-inventory.js';
import type { Watch } from '../src/watch.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-inventory-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();
const presentation = (over: Partial<WatchSnapshot['presentation']> = {}): WatchSnapshot['presentation'] => ({
  title: 'A watch',
  summary: '',
  label: 'Watch',
  tone: 'neutral',
  worker: { steps: [] },
  helm: { steps: [] },
  rows: [],
  links: [],
  actions: [],
  attention: [],
  ...over,
});
function store(journal: WatchJournal, key: string, over: Partial<WatchSnapshot> = {}): void {
  const snapshot: WatchSnapshot = {
    key,
    type: { id: 'fixture', apiVersion: 1, stateVersion: 1, version: '1.2.0' },
    reference: null,
    state: null,
    cursor: '0',
    options: {},
    owner: { kind: 'helm', grounds: 'home' },
    generation: `g-${key}`,
    status: 'watching',
    events: [],
    deliveries: [],
    presentation: presentation(),
    createdAt: at(-86_400),
    failures: 0,
    ...over,
  };
  journal.update(key, () => ({ snapshot, result: undefined }));
}
const inventory = (journal: WatchJournal, legacy: Watch[] = [], heartbeat = at(-5)) =>
  watchInventory({ now: NOW, everySecs: 45, daemonHeartbeat: heartbeat, ownerName: (owner) => (owner.kind === 'helm' ? `${owner.grounds} helm` : undefined) }, journal, legacy);
const byKey = (rows: ReturnType<typeof inventory>) => Object.fromEntries(rows.map((row) => [row.key, row]));

describe('the Watches inventory', () => {
  it('words every schedule state from the scheduler’s own facts', () => {
    const journal = new WatchJournal();
    store(journal, 'fixture:never');
    store(journal, 'fixture:scheduled', { checkedAt: at(-12), lastSuccessAt: at(-12) });
    store(journal, 'fixture:due', { checkedAt: at(-60) });
    store(journal, 'fixture:checking', { checkedAt: at(-1), lease: { token: 't', until: NOW + 60_000 } });
    store(journal, 'fixture:retry', { checkedAt: at(-60), failure: { kind: 'rate', message: 'Rate limited', retryAfterSecs: 300 }, failures: 2 });
    store(journal, 'fixture:held', { status: 'held', checkedAt: at(-120), failure: { kind: 'auth', message: 'Access expired.', remedy: 'Reconnect, then release.', hold: true }, failures: 3 });
    store(journal, 'fixture:delivery', { checkedAt: at(-10), deliveryProgress: { heldAt: at(-600), heldReason: 'fork cap' } });
    store(journal, 'fixture:draining', { status: 'draining', checkedAt: at(-10) });
    store(journal, 'fixture:closing', { status: 'closing', checkedAt: at(-10) });
    store(journal, 'fixture:outage', { checkedAt: at(-10), failure: { kind: 'provider', message: 'GitHub is down', shared: true } });
    store(journal, 'fixture:retired', { status: 'retired' });
    const rows = byKey(inventory(journal));
    expect(rows['fixture:retired']).toBeUndefined();
    expect(rows['fixture:never']).toMatchObject({ next: { state: 'due' }, health: 'not-checked' });
    expect(rows['fixture:never']!.lastAttemptAt).toBeUndefined();
    expect(rows['fixture:scheduled']).toMatchObject({ next: { state: 'scheduled', at: at(33) }, health: 'healthy', lastSuccessAt: at(-12) });
    expect(rows['fixture:due']).toMatchObject({ next: { state: 'due' } });
    expect(rows['fixture:checking']).toMatchObject({ next: { state: 'checking' }, health: 'checking' });
    // A retry-after longer than the cadence moves the next check.
    expect(rows['fixture:retry']).toMatchObject({ next: { state: 'scheduled', at: at(240) }, health: 'retrying', error: { message: 'Rate limited', failures: 2 } });
    expect(rows['fixture:held']).toMatchObject({ next: { state: 'held' }, health: 'held', error: { message: 'Access expired.', remedy: 'Reconnect, then release.' } });
    // A delivery hold still polls, and says so.
    expect(rows['fixture:delivery']).toMatchObject({ next: { state: 'scheduled' }, health: 'healthy', deliveryHeld: { since: at(-600), reason: 'fork cap' } });
    expect(rows['fixture:draining']!.next).toEqual({ state: 'draining' });
    expect(rows['fixture:closing']!.next).toEqual({ state: 'closing' });
    expect(rows['fixture:outage']!.health).toBe('stale');
  });

  it('says the daemon is offline instead of promising a time it cannot meet', () => {
    const journal = new WatchJournal();
    store(journal, 'fixture:one', { checkedAt: at(-12) });
    store(journal, 'fixture:held', { status: 'held' });
    const rows = byKey(inventory(journal, [], at(-3600)));
    expect(rows['fixture:one']).toMatchObject({ next: { state: 'offline' }, health: 'offline' });
    expect(rows['fixture:held']!.next).toEqual({ state: 'held' });
    expect(byKey(inventory(journal, [], ''))['fixture:one']!.next).toEqual({ state: 'offline' });
  });

  it('keeps a legacy record’s backoff and lists records not yet imported', () => {
    const journal = new WatchJournal();
    const legacy: Watch = {
      key: 'cmd:build',
      owner: 'dispatch:a7c2e91f',
      check: 'true',
      cursor: '0',
      createdAt: at(-7200),
      lastCheckedAt: at(-60),
      lastError: 'exit 1',
      errorKind: 'rate-limit',
      failures: 2,
      seen: 0,
      seenAt: 0,
    } as Watch;
    const [row] = inventory(journal, [legacy]);
    expect(row).toMatchObject({ key: 'cmd:build', owner: { kind: 'dispatch', id: 'a7c2e91f' }, health: 'retrying', error: { message: 'exit 1', failures: 2 } });
    // Backoff doubles the cadence per failure: 45s × 4 = 180s from the last check.
    expect(row!.next).toEqual({ state: 'scheduled', at: at(120) });
  });

  it('resolves owner names with an ID fallback and keeps the generic brand for v1 sources', () => {
    const journal = new WatchJournal();
    store(journal, 'fixture:helm');
    store(journal, 'fixture:trap', { owner: { kind: 'trap', trapId: 'pearl', grounds: 'home' } });
    const rows = byKey(inventory(journal));
    expect(rows['fixture:helm']!.owner).toEqual({ kind: 'helm', id: 'home', grounds: 'home', name: 'home helm' });
    expect(rows['fixture:trap']!.owner).toEqual({ kind: 'trap', id: 'pearl', grounds: 'home' });
    expect(rows['fixture:helm']!.source).toEqual({ id: 'fixture', name: 'fixture', icon: { glyph: 'source' } });
  });

  it('marks derived views and keeps a held source without an installed adapter', () => {
    const journal = new WatchJournal();
    store(journal, 'local:notices', { presentation: presentation({ listing: 'conditions' }) });
    store(journal, 'gone:one', { type: { id: 'gone', apiVersion: 1, stateVersion: 1, version: '1.0.0' }, status: 'held', failure: { kind: 'installation', message: 'Watch type gone has no enabled installation.', hold: true } });
    const rows = byKey(inventory(journal));
    expect(rows['local:notices']).toMatchObject({ derived: true, next: { state: 'unknown' } });
    expect(rows['gone:one']).toMatchObject({ derived: false, health: 'held', error: { message: 'Watch type gone has no enabled installation.' } });
  });

  it('orders by latest check, falls back to creation time for never-checked watches, and breaks ties by ID', () => {
    const journal = new WatchJournal();
    store(journal, 'fixture:b', { checkedAt: at(-10) });
    store(journal, 'fixture:a', { checkedAt: at(-10) });
    store(journal, 'fixture:new', { createdAt: at(-5) });
    store(journal, 'fixture:old', { checkedAt: at(-500) });
    expect(inventory(journal).map((row) => row.key)).toEqual(['fixture:new', 'fixture:a', 'fixture:b', 'fixture:old']);
  });

  it('records a successful observation separately from the attempt', () => {
    const registry = new WatchRegistry();
    registry.register(new CommandWatchType());
    const runtime = new WatchRuntime(registry);
    runtime.register('command', 'cmd:ok', { check: 'printf \'{"cursor":"1","events":[]}\'', cursor: '0' }, { kind: 'helm', grounds: 'home' });
    runtime.checkSync('cmd:ok', { now: NOW, everySecs: 0 });
    const ok = runtime.journal.read('cmd:ok')!;
    expect(ok.checkedAt).toBe(at(0));
    expect(ok.lastSuccessAt).toBe(at(0));
    runtime.register('command', 'cmd:bad', { check: 'exit 3', cursor: '0' }, { kind: 'helm', grounds: 'home' });
    runtime.checkSync('cmd:bad', { now: NOW, everySecs: 0 });
    const bad = runtime.journal.read('cmd:bad')!;
    expect(bad.checkedAt).toBe(at(0));
    expect(bad.lastSuccessAt).toBeUndefined();
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { stringify } from 'smol-toml';
import {
  ProcessWatchType,
  WatchRegistry,
  createProcessWatchType,
  disposeWatchPlugins,
  parseWatchPluginConfiguration,
} from '@lobstah/watch-types';
import { FixtureProcessWatch } from '../../watch-types/test/fixtures/process-watch.mjs';
import { WatchRuntime } from '../src/watch-runtime.js';
import { WatchJournal } from '../src/watch-journal.js';
import { WatchSubscriptionManager } from '../src/watch-subscriptions.js';
import { builtinWatchRegistry } from '../src/watch-source-registry.js';
import { registerInstalledWatch } from '../src/watch-registration.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let streams: WatchSubscriptionManager | undefined;
const program = fileURLToPath(new URL('../../watch-types/test/fixtures/process-watch.mjs', import.meta.url));
const owner = { kind: 'dispatch' as const, chainId: 'original-chain', grounds: 'home' };
const event = {
  id: 'stable-provider-1',
  kind: 'fixture:approval',
  summary: 'Review the fixture',
  at: '2026-11-19T00:00:00.000Z',
  data: {},
};
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-plugin-runtime-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(async () => {
  await streams?.dispose();
  streams = undefined;
  await disposeWatchPlugins();
  removeTempDir(home);
});
const historyFile = () => path.join(home, 'history.json');
const history = (value: unknown) => fs.writeFileSync(historyFile(), JSON.stringify(value));
const configuration = (extra: Record<string, unknown> = {}) =>
  parseWatchPluginConfiguration('fixture', {
    command: [process.execPath, program],
    version: '1.0.0',
    cwd: home,
    restartBackoffMs: 0,
    ...extra,
  });
function runtime(extra: Record<string, unknown> = {}) {
  const registry = new WatchRegistry();
  registry.register(new ProcessWatchType(configuration(extra)));
  return new WatchRuntime(registry, new WatchJournal(path.join(home, 'journal')));
}

it('holds an unsupported replacement API without advancing a stored checkpoint', () => {
  history({ cursor: 1, events: [event] });
  const first = runtime();
  first.register('fixture', 'fixture:one', { history: historyFile() }, owner);
  const committed = first.checkSync('fixture:one', { everySecs: 0 })!;
  const registry = new WatchRegistry();
  registry.register(createProcessWatchType(configuration({ command: [process.execPath, program, '--api-2'] }), {}, committed.type));
  const held = new WatchRuntime(registry, first.journal).checkSync('fixture:one', { everySecs: 0 })!;
  expect(held).toMatchObject({ status: 'held', cursor: '1', failure: { hold: true, remedy: expect.any(String) } });
  expect(held.events).toEqual(committed.events);
});

it('isolates an unexpected process exit while another watch type completes its scheduled observation', () => {
  history({ mode: 'crash' });
  const host = runtime();
  host.register('fixture', 'fixture:one', { history: historyFile() }, owner);
  class HealthyWatch extends FixtureProcessWatch {
    descriptor = { id: 'healthy', apiVersion: 1, stateVersion: 1, version: '1.0.0' };
    batchObserver = undefined;
    poll() {
      return { cursor: '7', events: [{ ...event, id: 'healthy-7' }] };
    }
  }
  host.registry.register(new HealthyWatch());
  host.register('healthy', 'fixture:healthy', { history: historyFile() }, owner);
  const results = host.checkManySync(['fixture:one', 'fixture:healthy'], { everySecs: 0 });
  expect(results.get('fixture:one')).toMatchObject({ cursor: '0', status: 'held', failure: { hold: true } });
  expect(results.get('fixture:healthy')).toMatchObject({ cursor: '7', events: [{ id: 'healthy-7' }] });
});

it('replays a restarted process event without reserving a second continuation', async () => {
  history({ cursor: 1, events: [event] });
  const first = runtime();
  first.register('fixture', 'fixture:one', { history: historyFile() }, owner);
  const observed = first.checkSync('fixture:one', { everySecs: 0 })!;
  const reserved = first.claimDelivery(observed.key, observed.deliveries[0]!.id);
  await disposeWatchPlugins();
  const second = runtime();
  const replayed = second.checkSync(observed.key, { everySecs: 0 })!;
  expect(replayed.events).toHaveLength(1);
  expect(replayed.deliveries).toHaveLength(1);
  expect(second.claimDelivery(replayed.key, replayed.deliveries[0]!.id).continuationId).toBe(reserved.continuationId);
  second.acknowledge(replayed.key, replayed.deliveries[0]!.id);
  expect(second.checkSync(replayed.key, { everySecs: 0 })!.deliveries).toMatchObject([{ status: 'delivered' }]);
});

it('loads an opt-in configured type and its defaults through generic registration', () => {
  history({ cursor: 2, events: [event] });
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    stringify({
      schemaVersion: 2,
      watchTypes: { fixture: { module: 'process', command: [process.execPath, program], version: '1.0.0', history: historyFile() } },
    }),
  );
  const registered = registerInstalledWatch('fixture:configured', owner)!;
  expect(registered.type.installation).toMatchObject({ kind: 'process', version: '1.0.0' });
  expect(new WatchRuntime(builtinWatchRegistry()).checkSync(registered.key, { everySecs: 0 })).toMatchObject({ cursor: '2' });
  const document = {
    schemaVersion: 2,
    watchTypes: { fixture: { enabled: false, module: 'process', command: [process.execPath, program], version: '1.0.0' } },
  };
  fs.writeFileSync(path.join(home, 'config.toml'), stringify(document));
  expect(new WatchRuntime(builtinWatchRegistry()).checkSync(registered.key, { everySecs: 0 })).toMatchObject({
    status: 'held',
    cursor: '2',
  });
});

it('commits streamed batches once and fences an old owner generation', async () => {
  const batch = { cursor: '1', events: [event], payload: { phase: 'failed' } };
  history({ cursor: 1, events: [event], stream: [batch, batch] });
  const host = runtime({ allowCapabilities: ['poll', 'subscribe'] });
  const registered = host.register('fixture', 'fixture:one', { history: historyFile() }, owner);
  streams = new WatchSubscriptionManager(host);
  streams.pass();
  await expect.poll(() => host.journal.read(registered.key)?.cursor).toBe('1');
  await streams.dispose();
  expect(host.journal.read(registered.key)).toMatchObject({ events: [event], deliveries: [{ status: 'pending' }] });
  expect(host.journal.read(registered.key)!.deliveries).toHaveLength(1);
  host.transfer(registered.key, { kind: 'trap', trapId: 'stable-trap', grounds: 'home' });
  expect(host.accept(registered.key, registered.generation, { ...batch, cursor: '99' })).toBe(false);
  expect(host.journal.read(registered.key)!.cursor).toBe('1');
});

it.each(['stdout', 'slow', 'malformed'])('holds invalid or overdue %s output without publishing a cursor', (mode) => {
  history({ mode, cursor: 99 });
  const host = runtime({ requestTimeoutMs: 100 });
  host.register('fixture', 'fixture:one', { history: historyFile() }, owner);
  expect(host.checkSync('fixture:one', { everySecs: 0 })).toMatchObject({ status: 'held', cursor: '0', events: [] });
});

it('backs up the prior installation bytes before a pinned release is restored', () => {
  history({ cursor: 1, events: [event] });
  const host = runtime();
  host.register('fixture', 'fixture:one', { history: historyFile() }, owner);
  host.checkSync('fixture:one', { everySecs: 0 });
  const directory = host.journal.directory;
  const original = fs.readFileSync(
    path.join(
      directory,
      fs.readdirSync(directory).find((name) => name.endsWith('.json'))!,
    ),
    'utf8',
  );
  const registry = new WatchRegistry();
  registry.register(new ProcessWatchType(configuration({ command: [process.execPath, program, '--release-2'], version: '2.0.0' })));
  const changed = new WatchRuntime(registry, host.journal).checkSync('fixture:one', { everySecs: 0 })!;
  expect(changed.type.installation?.version).toBe('2.0.0');
  const backups = fs.readdirSync(directory).filter((name) => name.endsWith('.bak'));
  expect(backups).toHaveLength(1);
  const backedUp = JSON.parse(fs.readFileSync(path.join(directory, backups[0]!), 'utf8'));
  const before = JSON.parse(original);
  // The check lease is acquired before migration; provider state and all receipts still match the original.
  expect(backedUp).toMatchObject({ type: before.type, cursor: before.cursor, events: before.events, deliveries: before.deliveries });
});

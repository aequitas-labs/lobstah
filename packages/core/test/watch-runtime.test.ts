import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BaseWatchType,
  CommandWatchType,
  WatchRegistry,
  type CommandWatchOptions,
  type CommandWatchReference,
  type CommandWatchState,
  type WatchContext,
  type WatchObservationBatch,
  type WatchCloseReason,
  type WatchResult,
  type WatchSnapshot,
} from '@lobstah/watch-types';
import { WatchRuntime } from '../src/watch-runtime.js';
import { WatchJournal } from '../src/watch-journal.js';
import { addWatch, pendingWatchEvents, readWatch, readWatchEvents, removeWatch, runWatchCheck } from '../src/watch.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const owner = { kind: 'dispatch' as const, chainId: 'chain-1', grounds: 'home' };
const now = Date.parse('2026-11-19T00:00:00Z');
const batch = (seq = 1): WatchObservationBatch<string> => ({
  cursor: String(seq),
  events: [{ id: String(seq), kind: 'changed', at: new Date(now).toISOString(), summary: 'changed', data: { seq } }],
});

/** A provider-free fixture exercises runtime boundaries instead of its private calls. */
class FixtureWatch extends BaseWatchType<CommandWatchReference, CommandWatchState, string, CommandWatchOptions> {
  private readonly command = new CommandWatchType();
  readonly descriptor = { id: 'fixture', apiVersion: 1 as const, stateVersion: 1, version: '1.0.0' };
  readonly referenceSchema = this.command.referenceSchema;
  readonly stateSchema = this.command.stateSchema;
  readonly cursorSchema = this.command.cursorSchema;
  readonly optionsSchema = this.command.optionsSchema;
  readonly bindings = this.command.bindings;
  reads = 0;
  closes = 0;
  read: () => WatchResult<WatchObservationBatch<string>> = () => batch();
  cleanup: (context?: WatchContext<CommandWatchReference, CommandWatchState, string, CommandWatchOptions>, reason?: WatchCloseReason) => WatchResult<void> = () => {};
  identify(input: string) {
    return this.command.identify(input);
  }
  key(reference: CommandWatchReference) {
    return reference.key;
  }
  initialize(reference: CommandWatchReference, options: CommandWatchOptions) {
    return this.command.initialize(reference, options);
  }
  restore(snapshot: WatchSnapshot) {
    return this.command.restore(snapshot);
  }
  poll(_context: WatchContext<CommandWatchReference, CommandWatchState, string, CommandWatchOptions>) {
    this.reads++;
    return this.read();
  }
  reduce(
    snapshot: WatchSnapshot<CommandWatchReference, CommandWatchState, string, CommandWatchOptions>,
    observations: WatchObservationBatch<string>,
  ) {
    return this.command.reduce(snapshot, observations);
  }
  present(snapshot: WatchSnapshot<CommandWatchReference, CommandWatchState, string, CommandWatchOptions>) {
    return this.command.present(snapshot);
  }
  failure(error: unknown) {
    return this.command.failure(error);
  }
  close(context?: WatchContext<CommandWatchReference, CommandWatchState, string, CommandWatchOptions>, reason?: WatchCloseReason) {
    this.closes++;
    return this.cleanup(context, reason);
  }
}

function runtime(adapter: FixtureWatch | CommandWatchType = new FixtureWatch()): WatchRuntime {
  const registry = new WatchRegistry();
  registry.register(adapter);
  return new WatchRuntime(registry, new WatchJournal(path.join(home, 'journal')));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-watch-runtime-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

describe('watch runtime durability', () => {
  it('one lease coordinates independent observers and commits cursor, event and outbox together', async () => {
    const adapter = new FixtureWatch();
    let finish!: (result: WatchObservationBatch<string>) => void;
    adapter.read = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const first = runtime(adapter),
      second = runtime(adapter);
    first.register('fixture', 'build:one', { check: 'unused' }, owner);
    const waiting = first.check('build:one', { now });
    await second.check('build:one', { now });
    expect(adapter.reads).toBe(1);
    expect(second.journal.read('build:one')?.cursor).toBe('0');
    finish(batch());
    await waiting;
    const restored = runtime(adapter).journal.read('build:one')!;
    expect(restored.cursor).toBe('1');
    expect(restored.events).toHaveLength(1);
    expect(restored.deliveries).toEqual([expect.objectContaining({ eventIds: ['1'], status: 'pending' })]);
    expect(restored.lease).toBeUndefined();
  });

  it('a claimed continuation survives restart before delivery and after delivery before receipt', async () => {
    const adapter = new FixtureWatch(),
      first = runtime(adapter);
    first.register('fixture', 'build:one', { check: 'unused' }, owner);
    const observed = (await first.check('build:one', { now }))!;
    const delivery = observed.deliveries[0];
    const claimed = first.claimDelivery(observed.key, delivery.id);
    const restarted = runtime(adapter);
    expect(restarted.claimDelivery(observed.key, delivery.id).continuationId).toBe(claimed.continuationId);
    restarted.acknowledge(observed.key, delivery.id);
    expect(runtime(adapter).claimDelivery(observed.key, delivery.id)).toMatchObject({
      continuationId: claimed.continuationId,
      status: 'delivered',
    });
  });

  it('dedupes inside one batch and across repeated observations and leaves progress on failures', async () => {
    const adapter = new FixtureWatch();
    adapter.read = () => ({ ...batch(), events: [...batch().events, ...batch().events] });
    const service = runtime(adapter);
    service.register('fixture', 'build:one', { check: 'unused' }, owner);
    await service.check('build:one', { now });
    await service.check('build:one', { now: now + 60_000 });
    const good = service.journal.read('build:one')!;
    expect(good.events).toHaveLength(1);
    expect(good.deliveries).toHaveLength(1);
    adapter.read = () => {
      throw new Error('provider unavailable');
    };
    const failed = await service.check('build:one', { now: now + 120_000 });
    expect(failed?.cursor).toBe('1');
    expect(failed?.failure?.message).toBe('provider unavailable');
    expect(failed?.deliveries).toHaveLength(1);
  });

  it('rejects a whole malformed batch before advancing its checkpoint', async () => {
    const adapter = new FixtureWatch();
    adapter.read = () => ({ ...batch(), events: [{ ...batch().events[0], at: 'invalid' }] });
    const service = runtime(adapter);
    service.register('fixture', 'build:one', { check: 'unused' }, owner);
    const result = await service.check('build:one', { now });
    expect(result?.cursor).toBe('0');
    expect(result?.events).toEqual([]);
    expect(result?.failure).toBeDefined();
  });

  it('a stale poll cannot resurrect a watch removed and re-registered while it ran', async () => {
    const adapter = new FixtureWatch();
    let finish!: (result: WatchObservationBatch<string>) => void;
    adapter.read = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const service = runtime(adapter),
      original = service.register('fixture', 'build:one', { check: 'unused' }, owner);
    const waiting = service.check(original.key, { now });
    service.retire(original.key);
    const replacement = service.register('fixture', original.key, { check: 'unused', cursor: '7' }, owner);
    expect(replacement.generation).not.toBe(original.generation);
    finish(batch());
    await waiting;
    expect(service.journal.read(original.key)?.cursor).toBe('7');
    expect(service.journal.read(original.key)?.events).toEqual([]);
  });

  it('direct trap ownership and unread events persist while no trap session exists', async () => {
    const adapter = new FixtureWatch(),
      service = runtime(adapter);
    service.register('fixture', 'build:one', { check: 'unused' }, { kind: 'trap', trapId: 'stable-trap', grounds: 'home' });
    await service.check('build:one', { now });
    expect(runtime(adapter).journal.read('build:one')).toMatchObject({
      owner: { kind: 'trap', trapId: 'stable-trap' },
      deliveries: [{ status: 'pending' }],
    });
    expect(() => service.register('fixture', 'build:one', { check: 'unused' }, owner)).toThrow('explicit transfer');
    expect(service.transfer('build:one', owner).owner).toEqual(owner);
  });

  it('collision-safe journal paths keep punctuation-distinct keys independent', () => {
    const service = runtime();
    service.register('fixture', 'build:a/b', { check: 'one' }, owner);
    service.register('fixture', 'build:a-b', { check: 'two' }, owner);
    expect(
      service.journal
        .list()
        .map((record) => record.key)
        .sort(),
    ).toEqual(['build:a-b', 'build:a/b']);
  });

  it('terminal cleanup waits for consumption and retries after a cleanup failure', async () => {
    const adapter = new FixtureWatch();
    adapter.read = () => ({ ...batch(), done: true });
    const service = runtime(adapter);
    service.register('fixture', 'build:one', { check: 'unused' }, owner);
    const snapshot = (await service.check('build:one', { now }))!;
    expect(await service.close(snapshot.key)).toBe(false);
    expect(adapter.closes).toBe(0);
    service.acknowledge(snapshot.key, snapshot.deliveries[0].id);
    adapter.cleanup = () => {
      throw new Error('try cleanup again');
    };
    expect(await service.close(snapshot.key)).toBe(false);
    expect(service.journal.read(snapshot.key)?.status).toBe('closing');
    adapter.cleanup = () => {};
    expect(await service.close(snapshot.key)).toBe(true);
    expect(service.journal.read(snapshot.key)?.status).toBe('retired');
    expect(await service.close(snapshot.key)).toBe(false);
  });

  it('removal cleans the original generation and retries with the removal reason', async () => {
    const adapter = new FixtureWatch(), service = runtime(adapter);
    const original = service.register('fixture', 'build:one', { check: 'unused' }, owner);
    const calls: Array<{ generation: string; reason?: WatchCloseReason }> = [];
    adapter.cleanup = (context, reason) => {
      calls.push({ generation: context!.snapshot.generation, reason });
      if (calls.length === 1) throw new Error('Resource unavailable');
    };
    service.retire(original.key);
    expect(service.journal.read(original.key)?.status).toBe('closing');
    expect(() => service.register('fixture', original.key, { check: 'unused' }, owner)).toThrow(/cleanup is pending/);
    expect(await service.close(original.key)).toBe(true);
    expect(calls).toEqual([
      { generation: original.generation, reason: 'removed' },
      { generation: original.generation, reason: 'removed' },
    ]);
    expect(service.journal.read(original.key)?.status).toBe('retired');
  });

  it('keeps an asynchronously removed source closing until its cleanup completes', async () => {
    const adapter = new FixtureWatch(), service = runtime(adapter);
    let finish!: () => void;
    adapter.cleanup = () => new Promise<void>(resolve => { finish = resolve; });
    const original = service.register('fixture', 'build:one', { check: 'unused' }, owner);
    service.retire(original.key);
    expect(service.journal.read(original.key)?.status).toBe('closing');
    finish();
    await Promise.resolve();
    expect(service.journal.read(original.key)?.status).toBe('retired');
  });

  it('unknown or newer adapter state is held without changing its cursor', async () => {
    const adapter = new FixtureWatch(),
      service = runtime(adapter);
    service.register('fixture', 'build:one', { check: 'unused', cursor: '17' }, owner);
    service.journal.update('build:one', (snapshot) => {
      snapshot!.type.stateVersion = 99;
      return { snapshot, result: undefined };
    });
    const held = await service.check('build:one', { now });
    expect(held?.cursor).toBe('17');
    expect(held?.status).toBe('held');
    expect(adapter.reads).toBe(0);
  });
});

it('custom-command compatibility retains cursor and events through re-add and journal restart', () => {
  const script = path.join(home, 'check.cjs');
  fs.writeFileSync(script, 'console.log(JSON.stringify({cursor:"2",events:[{seq:1,summary:"first"},{seq:2,summary:"second"}]}));');
  const first = addWatch('command:legacy', `"${process.execPath}" "${script}"`);
  runWatchCheck(first);
  const updated = addWatch(first.key, `"${process.execPath}" "${script}"`);
  expect(updated.cursor).toBe('2');
  expect(readWatchEvents(first.key)).toHaveLength(2);
  runWatchCheck(readWatch(first.key)!);
  expect(pendingWatchEvents(false)[0].events).toHaveLength(2);
  pendingWatchEvents(true);
  expect(pendingWatchEvents(false)).toEqual([]);
  removeWatch(first.key);
});

it('imports undelivered legacy observations into the journal before resuming a command', () => {
  const legacy = addWatch('command:import', `"${process.execPath}" -e "console.log(JSON.stringify({cursor:7,events:[]}))"`, {
    cursor: '7',
  });
  fs.appendFileSync(
    path.join(home, 'watches', 'command-import.events'),
    JSON.stringify({ seq: 6, summary: 'waiting before upgrade', at: new Date(now).toISOString() }) + '\n',
  );
  runWatchCheck(legacy);
  const journal = new WatchJournal().read(legacy.key)!;
  expect(journal.cursor).toBe('7');
  expect(journal.events.map((event) => event.summary)).toEqual(['waiting before upgrade']);
  expect(journal.deliveries[0].eventIds).toEqual(['6']);
});

it('adapter grouping, partial batch failures and deferral remain source-independent', () => {
  const groups: string[][] = [];
  class GroupedWatch extends CommandWatchType {
    readonly batchObserver = {
      group: (context: WatchContext<CommandWatchReference, Record<string, never>, string, CommandWatchOptions>) =>
        context.snapshot.key.split('/')[0]!,
      pollBatch: (contexts: readonly WatchContext<CommandWatchReference, Record<string, never>, string, CommandWatchOptions>[]) => {
        groups.push(contexts.map((context) => context.snapshot.key));
        return Object.fromEntries(
          contexts
            .filter((context) => !context.snapshot.key.endsWith('missing'))
            .map((context) => [
              context.snapshot.key,
              context.snapshot.key.endsWith('failure')
                ? { kind: 'provider', message: 'Temporarily unavailable', retryAfterSecs: 30 }
                : context.snapshot.key.endsWith('deferred')
                  ? { cursor: context.snapshot.cursor, events: [], deferred: true }
                  : { cursor: 'next', events: [] },
            ]),
        );
      },
    };
  }
  const instance = runtime(new GroupedWatch());
  for (const key of ['one/ok', 'one/missing', 'one/failure', 'two/ok', 'two/deferred'])
    instance.register('command', key, { check: 'unused' }, owner);
  const results = instance.checkManySync(['one/ok', 'one/missing', 'one/failure', 'two/ok', 'two/deferred'], { now: Date.now() });
  expect(groups).toEqual([
    ['one/ok', 'one/missing', 'one/failure'],
    ['two/ok', 'two/deferred'],
  ]);
  expect(results.get('one/ok')?.cursor).toBe('next');
  expect(results.get('two/ok')?.cursor).toBe('next');
  expect(results.get('one/missing')).toMatchObject({ cursor: '0', failures: 1, failure: { message: 'Watch batch omitted one/missing' } });
  expect(results.get('one/failure')).toMatchObject({
    cursor: '0',
    failures: 1,
    failure: { kind: 'provider', message: 'Temporarily unavailable' },
  });
  expect(results.get('two/deferred')).toMatchObject({ cursor: '0', failures: 0 });
  expect(results.get('two/deferred')?.checkedAt).toBeUndefined();
  expect(results.get('two/deferred')?.lease).toBeUndefined();
});

it('the synchronous batch boundary reports an async source without an unhandled rejection', async () => {
  const adapter = new FixtureWatch();
  adapter.read = () => Promise.reject(new Error('provider failed asynchronously'));
  const instance = runtime(adapter);
  instance.register('fixture', 'async:one', { check: 'unused' }, owner);
  const result = instance.checkManySync(['async:one']);
  expect(result.get('async:one')).toMatchObject({
    cursor: '0',
    failures: 1,
    failure: { message: 'An asynchronous watch requires the asynchronous runtime' },
  });
  await Promise.resolve();
});


it('runs adapter transformations outside publication locks and preserves concurrent delivery progress', () => {
  const adapter = new FixtureWatch();
  const service = runtime(adapter);
  const originalReduce = adapter.reduce.bind(adapter);
  service.register('fixture', 'build:one', { check: 'unused' }, owner);
  adapter.reduce = (snapshot, observations) => {
    expect(fs.readdirSync(service.journal.directory).filter((name) => name.endsWith('.lock'))).toEqual([]);
    service.journal.update(snapshot.key, (current) => {
      current!.deliveryProgress = { seenAt: 42, lastFollowUpId: 'reserved-work' };
      return { snapshot: current, result: undefined };
    });
    return originalReduce(snapshot, observations);
  };
  const result = service.checkSync('build:one', { now });
  expect(result).toMatchObject({ cursor: '1', deliveryProgress: { seenAt: 42, lastFollowUpId: 'reserved-work' } });
});

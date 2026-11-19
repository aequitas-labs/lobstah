import { beforeEach, afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandWatchType, WatchRegistry } from '@lobstah/watch-types';
import type {
  CommandWatchOptions,
  CommandWatchReference,
  CommandWatchState,
  WatchActionProposal,
  WatchEffectHandler,
  WatchSnapshot,
} from '@lobstah/watch-types';
import { WatchRuntime } from '../src/watch-runtime.js';
import { WatchActionRunner } from '../src/watch-actions.js';
import { WatchAutomationRunner } from '../src/watch-automation.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const owner = { kind: 'dispatch' as const, chainId: 'chain', grounds: 'home' };
const proposal = (idempotencyKey = 'operation'): WatchActionProposal => ({
  actionId: 'repair',
  expectedRevision: 'revision-1',
  idempotencyKey,
  authority: 'config:fixture',
  arguments: { revision: 1 },
});
const authority = () => ({ id: 'config:fixture', by: 'configuration', at: new Date().toISOString() });

/** A fake scheduler records concrete IDs, including an enqueue-before-ack crash. */
class ActionFixture extends CommandWatchType {
  readonly descriptor = { id: 'fixture', apiVersion: 1 as const, stateVersion: 1, version: '1.0.0' };
  calls = 0;
  work = new Set<string>();
  crash = false;
  closes = 0;
  effectHandler: WatchEffectHandler<CommandWatchReference> | undefined = {
    execution: 'sync',
    execute: (request) => {
      this.calls++;
      this.work.add(request.id);
      if (this.crash) {
        this.crash = false;
        throw new Error('crashed after enqueue');
      }
      return { workIds: [request.id] };
    },
  };
  readonly automation = { propose: () => [proposal()] };
  present(snapshot: WatchSnapshot<CommandWatchReference, CommandWatchState, string, CommandWatchOptions>) {
    return { ...super.present(snapshot), actions: [{ id: 'repair', label: 'Repair', requiresAuthority: true, automatic: true }] };
  }
  close() {
    this.closes++;
  }
}
function fixture(source = new ActionFixture()) {
  const registry = new WatchRegistry();
  registry.register(source);
  const runtime = new WatchRuntime(registry);
  runtime.register('fixture', 'fixture:one', { check: 'unused' }, owner);
  return { source, registry, runtime, actions: new WatchActionRunner(registry, runtime.journal) };
}
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-actions-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

it('binds recorded authority to the whole request and returns one result on replay', async () => {
  const { source, actions } = fixture();
  const request = actions.authorize('fixture:one', proposal(), authority());
  expect(() => actions.executeSync('fixture:one', { ...request, arguments: { revision: 2 } })).toThrow('matching recorded authority');
  expect(source.calls).toBe(0);
  const result = actions.executeSync('fixture:one', request);
  expect(await actions.execute('fixture:one', request)).toEqual(result);
  expect(actions.authorize('fixture:one', proposal(), authority()).id).toBe(request.id);
  expect(() => actions.authorize('fixture:one', { ...proposal(), expectedRevision: 'changed' }, authority())).toThrow('changed its scope');
  expect(source.calls).toBe(1);
});

it('a crash after enqueue retries the same scheduler ID rather than starting a second worker', () => {
  const { source, actions, runtime } = fixture();
  source.crash = true;
  const request = actions.authorize('fixture:one', proposal(), authority());
  expect(() => actions.executeSync('fixture:one', request)).toThrow('crashed after enqueue');
  expect(runtime.journal.read('fixture:one')?.actionReceipts?.[0].status).toBe('failed');
  expect(actions.executeSync('fixture:one', request)?.workIds).toEqual([request.id]);
  expect(source.work.size).toBe(1);
  expect(actions.executeSync('fixture:one', request)?.workIds).toEqual([request.id]);
  expect(source.calls).toBe(2);
});

it('ownership transfer invalidates old requests without clearing source progress', () => {
  const { source, runtime, actions } = fixture();
  const request = actions.authorize('fixture:one', proposal(), authority());
  runtime.transfer('fixture:one', { kind: 'helm', grounds: 'home' });
  expect(() => actions.executeSync('fixture:one', request)).toThrow('matching recorded authority');
  expect(source.calls).toBe(0);
  expect(runtime.journal.read('fixture:one')?.cursor).toBe('0');
});

it('an async effect is not invoked by a sync host, and its lease fences concurrent execution and cleanup', async () => {
  const source = new ActionFixture();
  let finish!: () => void;
  source.effectHandler = {
    execution: 'async',
    execute: async (request) => {
      source.calls++;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { workIds: [request.id] };
    },
  };
  const { actions, runtime } = fixture(source);
  const request = actions.authorize('fixture:one', proposal(), authority());
  expect(() => actions.executeSync('fixture:one', request)).toThrow('asynchronous runtime');
  expect(source.calls).toBe(0);
  const running = actions.execute('fixture:one', request);
  expect(await actions.execute('fixture:one', request)).toBeUndefined();
  runtime.journal.update('fixture:one', (snapshot) => {
    snapshot!.status = 'draining';
    return { snapshot, result: undefined };
  });
  expect(await runtime.close('fixture:one')).toBe(false);
  finish();
  await running;
  expect(await runtime.close('fixture:one')).toBe(true);
  expect(source.closes).toBe(1);
});

it('automatic effects respect the shared work cap and observers never claim another host’s pending action', () => {
  const { source, registry, runtime, actions } = fixture();
  runtime.register('fixture', 'fixture:two', { check: 'unused' }, owner);
  const work = new WatchAutomationRunner(registry, runtime.journal).runSync(['fixture:one', 'fixture:two'], Date.now(), 1, () => {});
  expect(work).toHaveLength(1);
  expect(source.calls).toBe(1);
  const next = new WatchAutomationRunner(registry, runtime.journal).runSync(['fixture:one', 'fixture:two'], Date.now(), 1, () => {});
  expect(next).toHaveLength(1); expect(source.calls).toBe(2);
  const request = actions.authorize('fixture:two', proposal('pending'), authority());
  const observer = new ActionFixture();
  observer.effectHandler = undefined;
  const readers = new WatchRegistry();
  readers.register(observer);
  expect(new WatchAutomationRunner(readers, runtime.journal).runSync(['fixture:two'], Date.now(), 3, () => {})).toEqual([]);
  const receipt = runtime.journal.read('fixture:two')?.actionReceipts?.find((entry) => entry.request.id === request.id);
  expect(receipt).toMatchObject({ status: 'pending' });
  expect(receipt?.lease).toBeUndefined();
});

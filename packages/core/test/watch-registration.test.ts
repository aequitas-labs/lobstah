import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CommandWatchType, WatchRegistry } from '@lobstah/watch-types';
import type { WatchRegistrationPolicy } from '@lobstah/watch-types';
import { ensureLayout, registerWatchEvent, syncWatchRegistrations, WatchRuntime } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-registration-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => removeTempDir(home));

function source(id: string, policy: WatchRegistrationPolicy) {
  return new (class extends CommandWatchType {
    readonly descriptor = { id, apiVersion: 1 as const, stateVersion: 1, version: '1.0.0' };
    readonly bindings = [{ event: 'explicit' as const, field: 'key', pattern: '^signal:' }];
    readonly registration = policy;
  })();
}
const owner = { kind: 'helm' as const, grounds: 'home' };
const request = { event: 'explicit' as const, fields: { key: 'signal:test' }, owner, options: {} };
const prepare = () => ({ input: 'signal:test', options: { check: 'fixture command' } });

it('publishes no registration or source write when two adapters claim one input', () => {
  const registry = new WatchRegistry();
  let writes = 0;
  registry.register(
    source('alpha', {
      prepare,
      registered() {
        writes++;
      },
    }),
  );
  registry.register(
    source('beta', {
      prepare,
      registered() {
        writes++;
      },
    }),
  );
  expect(() => registerWatchEvent(request, registry)).toThrow(/Several watch types/);
  expect(writes).toBe(0);
  expect(new WatchRuntime(registry).journal.list()).toEqual([]);
  expect(registerWatchEvent(request, registry, 'beta')?.type.id).toBe('beta');
  expect(writes).toBe(1);
});

it('checks durable ownership before invoking the registered hook', () => {
  const registry = new WatchRegistry();
  let writes = 0;
  registry.register(
    source('alpha', {
      prepare,
      registered() {
        writes++;
      },
    }),
  );
  const initial = registerWatchEvent(request, registry)!;
  expect(() => registerWatchEvent({ ...request, owner: { kind: 'trap', trapId: 'new-owner', grounds: 'home' } }, registry)).toThrow(
    /explicit transfer/,
  );
  expect(writes).toBe(1);
  expect(new WatchRuntime(registry).journal.read(initial.key)).toMatchObject({ owner, generation: initial.generation });
});

it('continues other sources after a reconciliation failure and preserves the lifecycle phase', () => {
  const registry = new WatchRegistry();
  const phases: string[] = [],
    errors: string[] = [];
  registry.register(
    source('alpha', {
      prepare,
      sync() {
        throw new Error('Installation unavailable');
      },
    }),
  );
  registry.register(
    source('beta', {
      prepare,
      sync(_now, phase) {
        phases.push(phase);
      },
    }),
  );
  syncWatchRegistrations(registry, Date.now(), (error) => errors.push(error), 'after-observe');
  expect(errors).toEqual(['Installation unavailable']);
  expect(phases).toEqual(['after-observe']);
});

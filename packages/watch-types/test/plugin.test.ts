import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ProcessWatchType,
  createProcessWatchType,
  disposeWatchPlugins,
  parseWatchPluginConfiguration,
  WATCH_PLUGIN_CAPABILITIES,
} from '../dist/index.js';
import type { WatchSnapshot, WatchValue } from '../src/model.js';
import { FixtureProcessWatch } from './fixtures/process-watch.mjs';
import { removeTempDir } from '../../../test/temp-dir.js';
let home: string;
const program = fileURLToPath(new URL('./fixtures/process-watch.mjs', import.meta.url));
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-process-watch-'));
});
afterEach(async () => {
  await disposeWatchPlugins();
  vi.unstubAllEnvs();
  removeTempDir(home);
});
const config = (extra: Record<string, unknown> = {}) =>
  parseWatchPluginConfiguration('fixture', {
    command: [process.execPath, program],
    version: '1.0.0',
    cwd: home,
    allowCapabilities: [...WATCH_PLUGIN_CAPABILITIES],
    ...extra,
  });
const historyFile = () => path.join(home, 'history.json');
const history = (value: unknown) => fs.writeFileSync(historyFile(), JSON.stringify(value));
const event = {
  id: 'event-1',
  kind: 'fixture:approval',
  summary: 'A fixture failed',
  at: '2026-11-19T00:00:00.000Z',
  data: { providerSequence: 1 },
};
function snapshot(adapter: ProcessWatchType | FixtureProcessWatch): WatchSnapshot<WatchValue, WatchValue, WatchValue, WatchValue> {
  const options = adapter.optionsSchema.parse({ history: historyFile() }),
    reference = adapter.identify('fixture:one', options)!;
  const initial = adapter.initialize(reference, options);
  return {
    key: adapter.key(reference),
    type: adapter.descriptor,
    reference,
    options,
    ...initial,
    owner: { kind: 'helm', grounds: 'home' },
    generation: 'generation-1',
    status: 'watching',
    events: [],
    deliveries: [],
    failures: 0,
    createdAt: '2026-11-19T00:00:00.000Z',
    presentation: {
      title: '',
      summary: '',
      label: '',
      tone: 'neutral',
      worker: { steps: [] },
      helm: { steps: [] },
      rows: [],
      links: [],
      actions: [],
      attention: [],
    },
  };
}

it('runs one adapter history with equal normalized events, role instructions and presentation in both hosts', async () => {
  const processAdapter = new ProcessWatchType(config()),
    local = new FixtureProcessWatch();
  let remote = snapshot(processAdapter),
    direct = snapshot(local);
  for (const value of [
    { cursor: 0, phase: 'waiting', events: [] },
    { cursor: 1, phase: 'failed', events: [event] },
    { cursor: 2, phase: 'complete', events: [], done: true },
  ]) {
    history(value);
    const now = '2026-11-19T00:00:00.000Z',
      observed = processAdapter.poll({ snapshot: remote, now }),
      expected = await local.poll({ snapshot: direct, now });
    expect(observed).toEqual(expected);
    const plan = processAdapter.reduce(remote, observed),
      baseline = local.reduce(direct, expected);
    expect(plan).toEqual(baseline);
    remote = { ...remote, ...plan };
    direct = { ...direct, ...baseline };
    expect(processAdapter.present(remote)).toEqual(local.present(direct));
  }
  expect(remote.type.installation).toMatchObject({ kind: 'process', protocolVersion: 1, executable: process.execPath, version: '1.0.0' });
});

it('passes only explicitly granted environment values to the plugin process', () => {
  vi.stubEnv('PLUGIN_ALLOWED', 'allowed-token');
  vi.stubEnv('PLUGIN_UNDECLARED', 'ambient-token');
  vi.stubEnv('LOBSTAH_HOME', '/ambient/home');
  const output = path.join(home, 'environment.json');
  history({ cursor: 0, envReport: output });
  const adapter = new ProcessWatchType(config({ envAllow: ['PLUGIN_ALLOWED'] }));
  adapter.poll({ snapshot: snapshot(adapter), now: new Date().toISOString() });
  expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual({ allowed: 'allowed-token', blocked: null, home: null });
  expect(JSON.stringify(adapter.descriptor)).not.toContain('allowed-token');
  expect(JSON.stringify(adapter.descriptor)).not.toContain('ambient-token');
});

it('rejects unsupported API majors and exposes a holdable unavailable type', () => {
  const unavailable = createProcessWatchType(config({ command: [process.execPath, program, '--api-2'] }));
  expect(unavailable).not.toBeInstanceOf(ProcessWatchType);
  expect(unavailable.failure(new Error('probe'))).toMatchObject({ hold: true, remedy: expect.any(String) });
});

it('validates malformed batches before a reducer can advance progress', () => {
  history({ cursor: 99, mode: 'malformed' });
  const adapter = new ProcessWatchType(config());
  expect(() => adapter.poll({ snapshot: snapshot(adapter), now: new Date().toISOString() })).toThrow(/observation/);
});

it('maps subscription batches and batch grouping through the declared capabilities', async () => {
  const batch = { cursor: '1', events: [event], payload: { phase: 'failed' } };
  history({ cursor: 1, phase: 'failed', events: [event], stream: [batch, batch] });
  const adapter = new ProcessWatchType(config()),
    current = snapshot(adapter),
    context = { snapshot: current, now: new Date().toISOString() };
  const streamed = [];
  for await (const value of adapter.subscriber!.subscribe(context)) streamed.push(value);
  expect(streamed).toEqual([batch, batch]);
  expect(adapter.batchObserver!.group(context)).toBe(historyFile());
  expect(adapter.batchObserver!.pollBatch([context])).toEqual({ 'fixture:one': batch });
});

it('requires configured action capability and validates the recorded authorization envelope', () => {
  history({ cursor: 0 });
  const disabled = new ProcessWatchType(config({ allowCapabilities: ['poll'] }));
  expect(disabled.effectHandler).toBeUndefined();
  const adapter = new ProcessWatchType(config()),
    output = path.join(home, 'action.json');
  const action = {
    id: 'recorded-action',
    generation: 'original-generation',
    actionId: 'acknowledge',
    reference: { key: 'fixture:one' },
    expectedRevision: 'revision-1',
    authorization: { id: 'human-request', by: 'fixture', at: '2026-11-19T00:00:00.000Z' },
    arguments: { output },
  };
  expect(adapter.effectHandler!.execute(action)).toEqual({ workIds: ['recorded-action'] });
  expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({
    generation: 'original-generation',
    authorization: action.authorization,
  });
  expect(() => adapter.effectHandler!.execute({ ...action, authorization: { ...action.authorization, by: '' } })).toThrow(/authority/);
});

it.each(['oversized', 'wrong-id'])('rejects %s wire responses before returning provider data', async (mode) => {
  const { WatchPluginTransport } = await import('../dist/plugin-transport.js');
  const transport = new WatchPluginTransport(
    config({
      command: [process.execPath, fileURLToPath(new URL('./fixtures/broken-plugin.mjs', import.meta.url)), mode],
      maxMessageBytes: 65536,
    }),
  );
  try {
    transport.callSync('watch.handshake', {});
    expect(() => transport.callSync('watch.probe', {})).toThrow(/size|bounded|request ID/);
  } finally {
    await transport.dispose();
  }
});

it('rejects a subscription notification from a stale generation', async () => {
  const { WatchPluginTransport } = await import('../dist/plugin-transport.js');
  const transport = new WatchPluginTransport(
    config({ command: [process.execPath, fileURLToPath(new URL('./fixtures/broken-plugin.mjs', import.meta.url)), 'wrong-generation'] }),
  );
  try {
    transport.callSync('watch.handshake', {});
    const collect = async () => {
      for await (const _batch of transport.subscribe(
        {},
        { protocolVersion: 1, watchKey: 'fixture:one', generation: 'current', deadline: Date.now() + 5000 },
      ))
        throw new Error('Stale notification reached the caller');
    };
    await expect(collect()).rejects.toThrow(/generation/);
  } finally {
    await transport.dispose();
  }
});

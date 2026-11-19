import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parse, stringify } from 'smol-toml';
import { disposeWatchPlugins } from '@lobstah/watch-types';
import {
  parsePrRef,
  registerWatchEvent,
  appendStatus,
  claimBait,
  enqueue,
  ensureLayout,
  readTrap,
  readTurnOwner,
  signOnTrap,
  unhandled,
  WatchJournal,
} from '@lobstah/core';
import { addCliWatch } from '../src/watch-registration.js';
import { addPrWatch } from '../src/pr-watch.js';
import { addUmeWatch } from '../src/ume-watch.js';
import { createTurnWaits, readTurnWaitRecords } from '../src/turn-waits.js';
import { createCliWatchRegistry } from '../src/watch-automation.js';
import { buildGlassSnapshot } from '../src/glass.js';
import { watchLoop } from '../../pick/src/loops/watch.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let directory: string, home: string, history: string, cleanup: string;
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const library = pathToFileURL(fileURLToPath(new URL('../../../packages/watch-types/dist/index.js', import.meta.url))).href;
const owner = '55555555-5555-4555-8555-555555555555';

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-outside-adapter-'));
  home = path.join(directory, 'home');
  history = path.join(directory, 'history.json');
  cleanup = path.join(directory, 'closed.txt');
  vi.stubEnv('LOBSTAH_HOME', home);
  vi.stubEnv('AGENT_TURN_HOME', path.join(directory, 'turns'));
  ensureLayout();
  fs.writeFileSync(history, JSON.stringify({ cursor: '0', events: [] }));
  const program = path.join(directory, 'harbor.mjs');
  // This executable and all provider fixtures live outside the checkout. Only the public contract is imported.
  fs.writeFileSync(
    program,
    `
import fs from 'node:fs';
import { CommandWatchType, serveWatchPlugin } from ${JSON.stringify(library)};
class HarborWatch extends CommandWatchType {
  descriptor = { id: 'harbor', apiVersion: 1, stateVersion: 1, version: '1.0.0',
    attentionKinds: [{ kind: 'harbor:attention', label: 'Harbor attention', defaultEnabled: true }] };
  bindings = [ { event: 'explicit', field: 'key', pattern: '^harbor:' },
    { event: 'turn-wait', field: 'read', pattern: '^harbor inspect ' } ];
  optionsSchema = { json: { type: 'object', required: ['history', 'cleanup'], additionalProperties: false,
    properties: { history: { type: 'string' }, cleanup: { type: 'string' }, cursor: { type: 'string' } } },
    parse(value) { if (!value || typeof value.history !== 'string' || typeof value.cleanup !== 'string') throw new Error('Missing history'); return value; } };
  identify(input) { return /^harbor:[a-z]+$/.test(input) ? { key: input } : undefined; }
  commands = { bindings: [{ name: 'check-ume' }], run({ args }) { return JSON.stringify({ adapter: 'harbor', input: args[0] }); } };
  registration = {
    prepare(request) {
      if (request.event === 'explicit') return { input: request.fields.key, options: request.options };
      const match = /^harbor inspect ([a-z]+)$/.exec(request.fields.read ?? '');
      if (request.fields.from !== 'harbor' || !match || request.fields.wait !== 'harbor await ' + match[1] + ' --since {cursor}') return undefined;
      return { input: 'harbor:' + match[1], options: { cursor: request.cursor ?? '0' } };
    },
    sync() {},
  };
  initialize(_reference, options) { return { state: {}, cursor: options.cursor ?? '0' }; }
  poll({ snapshot }) {
    const batch = JSON.parse(fs.readFileSync(snapshot.options.history, 'utf8'));
    return { cursor: batch.cursor, events: batch.events.filter(event => Number(event.id) > Number(snapshot.cursor)), done: batch.done ?? false };
  }
  present(snapshot) { return { title: 'Harbor watch', summary: snapshot.events.at(-1)?.summary ?? 'Waiting', label: 'Harbor', tone: 'warning',
    worker: { steps: ['Read harbor feedback and report the outcome.'] }, helm: { steps: ['Keep harbor feedback with its owner.'] },
    rows: [], links: [{ label: 'Open harbor', url: 'https://example.test/harbor' }], actions: [],
    attention: snapshot.events.length ? [{ id: 'attention', kind: 'harbor:attention', stateHash: snapshot.cursor,
      summary: 'Harbor needs attention', quiet: false, blocking: false }] : [] }; }
  close({ snapshot }, reason) { fs.appendFileSync(snapshot.options.cleanup, snapshot.key + ' ' + reason + '\\n'); }
}
await serveWatchPlugin(new HarborWatch());
`,
  );
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    stringify({
      schemaVersion: 2,
      watchTypes: {
        harbor: {
          module: 'process',
          command: [process.execPath, program],
          version: '1.0.0',
          allowCapabilities: ['poll', 'registration'],
          history,
          cleanup,
        },
      },
    }),
  );
});
afterEach(async () => {
  await disposeWatchPlugins();
  vi.unstubAllEnvs();
  removeTempDir(directory);
});
function command(...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15000, env: process.env });
  expect({ status: result.status, output: result.stdout, error: result.stderr }).toMatchObject({ status: 0, error: '' });
  return result.stdout;
}
function feedback() {
  fs.writeFileSync(
    history,
    JSON.stringify({
      cursor: '1',
      events: [{ id: '1', kind: 'feedback', at: new Date().toISOString(), summary: 'Harbor feedback arrived', data: null }],
    }),
  );
}

it('registers, polls, displays, wakes and removes a throwaway process adapter without a host edit', async () => {
  expect(command('watch', 'add', 'harbor:explicit', '--owner', 'wt:stable-owner')).toContain('registered: true');
  feedback();
  await watchLoop(
    0,
    () => {},
    undefined,
    createCliWatchRegistry(() => {}),
  );
  const snapshot = new WatchJournal().read('harbor:explicit')!;
  expect(snapshot.events.map((event) => event.id)).toEqual(['1']);
  expect(buildGlassSnapshot({ local: true }).attention).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'harbor:attention', note: 'Harbor needs attention' })]),
  );
  expect(command('watch', 'inbox', '--owner', 'wt:stable-owner')).toContain('Harbor feedback arrived');
  command('watch', 'rm', 'harbor:explicit');
  expect(fs.readFileSync(cleanup, 'utf8')).toBe('harbor:explicit removed\n');
  expect(new WatchJournal().read('harbor:explicit')!.status).toBe('retired');
});

it('adopts a tool park through its process binding and delivers one owner inbox wake', async () => {
  const signed = signOnTrap({
    worktree: directory,
    cwd: directory,
    repo: 'r',
    harness: 'codex',
    sessionId: 'outside-thread',
    ttlMs: 600000,
  });
  if (!('ok' in signed)) throw new Error('Trap held');
  enqueue({ id: owner, repo: 'r', for: 'wt:' + signed.ok.trapId, brief: 'Inspect harbor' });
  claimBait(signed.ok);
  const trap = readTrap(signed.ok.trapId)!;
  appendStatus(owner, 'work', 'paused', 'Waiting for harbor', undefined, { waitingOn: 'external' }, true);
  fs.writeFileSync(
    path.join(readTurnOwner(trap.sessionId)!.waits, 'harbor.json'),
    JSON.stringify({
      from: 'harbor',
      read: 'harbor inspect parked',
      wait: 'harbor await parked --since {cursor}',
      cwd: directory,
      cursor: '0',
    }),
  );
  const start = vi.fn(() => {
    throw new Error('Unexpected process wait');
  });
  const listeners = new Set(process.listeners('exit'));
  try {
    createTurnWaits(start).pass(Date.now(), () => {});
    expect(start).not.toHaveBeenCalled();
    expect(readTurnWaitRecords()[0].watchKey).toBe('harbor:parked');
    feedback();
    const registry = createCliWatchRegistry(() => {});
    await watchLoop(0, () => {}, undefined, registry);
    await watchLoop(0, () => {}, undefined, registry);
    expect(unhandled(owner, 'work')).toHaveLength(1);
    expect(unhandled(owner, 'work')[0].text).toContain('Harbor feedback arrived');
  } finally {
    for (const listener of process.listeners('exit')) if (!listeners.has(listener)) process.removeListener('exit', listener);
  }
});

it('leaves an ungranted process park on the ordinary turn-wait path', () => {
  const config = parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'));
  const settings = (config.watchTypes as Record<string, Record<string, unknown>>).harbor;
  settings.allowCapabilities = ['poll'];
  fs.writeFileSync(path.join(home, 'config.toml'), stringify(config));
  const registry = createCliWatchRegistry(() => {});
  expect(registry.get('harbor').registration).toBeUndefined();
  expect(
    registerWatchEvent(
      {
        event: 'turn-wait',
        fields: { from: 'harbor', read: 'harbor inspect parked', wait: 'harbor await parked --since {cursor}' },
        options: {},
        owner: { kind: 'dispatch', chainId: owner, grounds: 'home' },
      },
      registry,
    ),
  ).toBeUndefined();
  expect(new WatchJournal().list()).toEqual([]);
});

it.each(['pr', 'ume'] as const)('honors an installed process replacement through the existing %s helper', (typeId) => {
  const config = parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'));
  const types = config.watchTypes as Record<string, Record<string, unknown>>;
  const settings = types.harbor;
  const program = (settings.command as string[])[1];
  fs.writeFileSync(
    program,
    fs
      .readFileSync(program, 'utf8')
      .replace("id: 'harbor'", `id: '${typeId}'`)
      .replace("pattern: '^harbor:'", `pattern: '^${typeId}:'`)
      .replace('^harbor:[a-z]+$', `^${typeId}:.+$`),
  );
  config.watchTypes = { [typeId]: settings };
  fs.writeFileSync(path.join(home, 'config.toml'), stringify(config));
  const watch = typeId === 'pr' ? addPrWatch(parsePrRef('pr:example/repo#7')!) : addUmeWatch('external');
  expect(watch.check).toBe('');
  expect(new WatchJournal().read(watch.key)).toMatchObject({ type: { id: typeId, installation: { kind: 'process' } } });
});

it('runs a replacement adapter command only when its command capability is granted', () => {
  const config = parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'));
  const settings = (config.watchTypes as Record<string, Record<string, unknown>>).harbor;
  const program = (settings.command as string[])[1];
  fs.writeFileSync(program, fs.readFileSync(program, 'utf8').replace("id: 'harbor'", "id: 'ume'"));
  settings.allowCapabilities = ['poll', 'registration', 'commands'];
  config.watchTypes = { ume: settings };
  fs.writeFileSync(path.join(home, 'config.toml'), stringify(config));
  expect(JSON.parse(command('watch', 'check-ume', 'external'))).toEqual({ adapter: 'harbor', input: 'external' });
  settings.allowCapabilities = ['poll', 'registration'];
  fs.writeFileSync(path.join(home, 'config.toml'), stringify(config));
  const denied = spawnSync(process.execPath, [cli, 'watch', 'check-ume', 'external'], {
    encoding: 'utf8',
    timeout: 15000,
    env: process.env,
  });
  expect(denied.status).toBe(1);
  expect(denied.stdout).toContain('No installed watch type handles check-ume');
});

it('keeps the recorded owner when a compatibility helper re-registers without a new owner', () => {
  const first = addCliWatch('harbor:repeat', { forId: owner });
  const repeated = addCliWatch('harbor:repeat');
  expect(first.owner).toBe(`dispatch:${owner}`);
  expect(repeated.owner).toBe(first.owner);
  expect(new WatchJournal().read(first.key)?.owner).toMatchObject({ kind: 'dispatch', chainId: owner });
});

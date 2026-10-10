import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { agentEnvironment, backendScope, enqueue, ensureLayout, groundsErrors, loadConfig, refreshHostedViews, readHostedViews, WharfBackend } from '@lobstah/core';
import { commandScope, wharfCommand } from '../src/wharf-commands.js';
import { buildGlassSnapshot, glassDispatchJson } from '../src/glass.js';
import { buildTendReport, renderTend } from '../src/tend.js';
import { lobItems } from '../src/glass-lobs.js';
import { removeTempDir } from '../../../test/temp-dir.js';
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-hosted-')); process.env.LOBSTAH_HOME = home; ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), `
[repos.local]
path = '${home.replaceAll('\\', '/')}'
[repos.remote]
path = '${home.replaceAll('\\', '/')}'
[wharves.cloud]
url = 'https://state.invalid'
account = 'person'
tokenEnv = 'LOBSTAH_TEST_CLOUD_TOKEN'
[wharves.dev]
url = 'http://127.0.0.1:8787'
account = 'person'
tokenEnv = 'LOBSTAH_TEST_DEV_TOKEN'
[grounds.desk]
repos = ['local']
[grounds.away]
repos = ['remote']
wharf = 'cloud'
[grounds.dev]
repos = ['remote']
wharf = 'dev'
`);
  process.env.LOBSTAH_TEST_CLOUD_TOKEN = 'helm-cloud'; process.env.LOBSTAH_TEST_DEV_TOKEN = 'machine-dev';
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); delete process.env.LOBSTAH_HOME; delete process.env.LOBSTAH_TEST_CLOUD_TOKEN; delete process.env.LOBSTAH_TEST_DEV_TOKEN; removeTempDir(home); });
it('selects each grounds independently, defaulting to local without an implicit remote write', () => {
  const cfg = loadConfig(); expect(commandScope(cfg)?.kind).toBe('local');
  expect(groundsErrors(cfg)).toEqual([]);
  expect(commandScope(cfg, 'away')?.wharf).toBe('cloud'); expect(commandScope(cfg, 'dev')?.wharf).toBe('dev');
  expect(() => commandScope(cfg, undefined, 'remote')).toThrow('several grounds');
});
it('only hands a dispatch capability to an agent, removing credentials for every named wharf', () => {
  const cfg = loadConfig(); const env = agentEnvironment(cfg, backendScope(cfg, 'away'), 'd.person.dispatch.1.secret', { LOBSTAH_TEST_CLOUD_TOKEN: 'PAT', LOBSTAH_TEST_DEV_TOKEN: 'MACHINE', PATH: 'path' });
  expect(env.LOBSTAH_TEST_CLOUD_TOKEN).toBe('d.person.dispatch.1.secret'); expect(env.LOBSTAH_TEST_DEV_TOKEN).toBeUndefined();
  expect(env.LOBSTAH_GROUNDS).toBe('away'); expect(Object.values(env)).not.toContain('PAT'); expect(Object.values(env)).not.toContain('MACHINE');
  expect(() => agentEnvironment(cfg, backendScope(cfg, 'away'), 'm.person.secret')).toThrow('dispatch token');
});
it('local + two wharves coexist in glass, tend and the pet; unreachable grounds do not erase local work', async () => {
  const at = new Date().toISOString();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.startsWith('http://127.0.0.1')) throw new Error('offline');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer helm-cloud');
    return Response.json([{ id: 'remote-job', repo: 'remote', brief: '# Remote task', state: 'active', status: { verb: 'needs-decision', note: 'which?', at } }]);
  }));
  enqueue({ id: 'local-job', repo: 'local', brief: 'Local task' });
  await refreshHostedViews(loadConfig());
  const glass = buildGlassSnapshot(); expect(glass.dispatches.map((d) => d.title)).toEqual(expect.arrayContaining(['Local task', '[away@cloud] # Remote task']));
  expect(glass.backends?.find((b) => b.grounds === 'dev')?.unavailable).toMatch('unknown');
  const remote = glass.dispatches.find((d) => d.backend); expect(JSON.parse(glassDispatchJson(remote!.id)!)).toMatchObject({ brief: '# Remote task', backend: { grounds: 'away' } });
  const tend = buildTendReport(); expect(renderTend(tend)).toContain('cloud'); expect(renderTend(tend)).toContain('unknown');
  expect(lobItems(tend.attention, { lobs: true, preview: false })).toHaveLength(1);
  const observed = readHostedViews(loadConfig()).find((v) => v.wharf === 'cloud')!.observedAt;
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  await refreshHostedViews(loadConfig()); expect(readHostedViews(loadConfig()).find((v) => v.wharf === 'cloud')!.observedAt).toBe(observed);
  expect(buildGlassSnapshot().dispatches.find((d) => d.backend)?.verb).toBe('unknown');
  expect(lobItems(buildTendReport().attention, { lobs: true, preview: false })).toHaveLength(0);
});
it('remote CLI mutations use the selected wharf and never the local queue; unsupported operations refuse', async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => Response.json(JSON.parse(String(init.body)))); vi.stubGlobal('fetch', fetcher);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const flags: Record<string, string> = { '--grounds': 'away', '--repo': 'remote', '--brief-text': 'work', '--id': 'remote-job', '--session': 'helm', '--request-key': 'retry' };
  const opts = { opt: (f: string) => flags[f], has: (f: string) => f in flags, values: () => [] };
  expect(await wharfCommand('dispatch', [], opts, loadConfig())).toBe(true);
  expect(fetcher.mock.calls[0][0]).toContain('/v1/accounts/person/dispatches');
  expect(fs.readdirSync(path.join(home, 'queue'))).toEqual([]);
  await expect(wharfCommand('cull', [], opts, loadConfig())).rejects.toThrow('not supported');
});
it('wharf recover prints only its submitted recovery, without listing recoveries or falling through the outer switch', async () => {
  const recovery = { verb: 'done', note: 'preserved result' };
  const file = path.join(home, 'recovery.json'); fs.writeFileSync(file, JSON.stringify(recovery));
  const result = { preserved: true };
  const fetcher = vi.fn(async () => Response.json(result)); vi.stubGlobal('fetch', fetcher);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const flags: Record<string, string> = { '--grounds': 'away', '--request-key': 'recover-once' };
  const opts = { opt: (f: string) => flags[f], has: (f: string) => f in flags, values: () => [] };
  expect(await wharfCommand('wharf', ['recover', 'remote-job', file], opts, loadConfig())).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith('https://state.invalid/v1/accounts/person/dispatches/remote-job/recovery', expect.objectContaining({ method: 'POST', body: JSON.stringify(recovery) }));
  expect(output.mock.calls).toEqual([[JSON.stringify(result, null, 2)]]);
});
it('rejects executable evidence URLs from a configured wharf', async () => {
  const backend = new WharfBackend({ kind: 'wharf', url: 'https://state.invalid', account: 'a', tokenEnv: 'TOKEN' }, 'token', { fetch: async () => Response.json([{ id: 'x', repo: 'r', brief: 'b', state: 'done', status: { verb: 'done', at: 'now', evidence: { prUrls: ['javascript:alert(1)'] } } }]) });
  await expect(backend.list()).rejects.toThrow('evidence URL');
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { agentEnvironment, backendScope, enqueue, ensureLayout, groundsErrors, loadConfig, refreshHostedViews, readHostedViews, WharfBackend } from '@lobstah/core';
import { commandScope, wharfCommand } from '../src/wharf-commands.js';
import { buildGlassSnapshot, glassDispatchJson } from '../src/glass.js';
import { buildTendReport, renderTend } from '../src/tend.js';
import { lobItems } from '../src/glass-lobs.js';
import { removeTempDir } from '../../../test/temp-dir.js';
import { parseArgs } from '../src/usage.js';
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-hosted-')); process.env.LOBSTAH_HOME = home; ensureLayout();
  execFileSync('git', ['init', home]);
  execFileSync('git', ['-C', home, 'remote', 'add', 'origin', 'git@github.com:Test/Repo.git']);
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
  process.env.LOBSTAH_TEST_CLOUD_TOKEN = 'helm-cloud'; process.env.LOBSTAH_TEST_DEV_TOKEN = 'boat-dev';
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); delete process.env.LOBSTAH_HOME; delete process.env.LOBSTAH_TEST_CLOUD_TOKEN; delete process.env.LOBSTAH_TEST_DEV_TOKEN; removeTempDir(home); });
it('selects each grounds independently, defaulting to local without an implicit remote write', () => {
  const cfg = loadConfig(); expect(commandScope(cfg)?.kind).toBe('local');
  expect(groundsErrors(cfg)).toEqual([]);
  expect(commandScope(cfg, 'away')?.wharf).toBe('cloud'); expect(commandScope(cfg, 'dev')?.wharf).toBe('dev');
  expect(() => commandScope(cfg, undefined, 'remote')).toThrow('several grounds');
});
it('only hands a dispatch capability to an agent, removing credentials for every named wharf', () => {
  const cfg = loadConfig(); const env = agentEnvironment(cfg, backendScope(cfg, 'away'), 'd.person.dispatch.1.secret', { LOBSTAH_TEST_CLOUD_TOKEN: 'PAT', LOBSTAH_TEST_DEV_TOKEN: 'BOAT', PATH: 'path' });
  expect(env.LOBSTAH_TEST_CLOUD_TOKEN).toBe('d.person.dispatch.1.secret'); expect(env.LOBSTAH_TEST_DEV_TOKEN).toBeUndefined();
  expect(env.LOBSTAH_GROUNDS).toBe('away'); expect(Object.values(env)).not.toContain('PAT'); expect(Object.values(env)).not.toContain('BOAT');
  expect(() => agentEnvironment(cfg, backendScope(cfg, 'away'), 'b.person.secret')).toThrow('dispatch token');
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
  expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toMatchObject({ repo: 'remote', repoRemote: 'github.com/test/repo' });
  expect(fs.readdirSync(path.join(home, 'queue'))).toEqual([]);
  await expect(wharfCommand('cull', [], opts, loadConfig())).rejects.toThrow('not supported');
});
it('refuses hosted soak without a daemon, and dispatch without a usable remote, before HTTP', async () => {
  execFileSync('git', ['-C', home, 'remote', 'remove', 'origin']);
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const flags: Record<string, string> = { '--grounds': 'away', '--repo': 'remote', '--session': 'session', '--harness': 'codex', '--brief-text': 'work' };
  const opts = { opt: (f: string) => flags[f], has: (f: string) => f in flags, values: () => [] };
  await expect(wharfCommand('soak', [], opts, loadConfig())).rejects.toThrow("the boat's daemon is not running");
  await expect(wharfCommand('dispatch', [], opts, loadConfig())).rejects.toThrow('no usable origin remote');
  expect(fetcher).not.toHaveBeenCalled();
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
it('resolves addressed --boat by its current name and sends a stable ID', async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === 'GET') return Response.json([{ id: 'stable-id', name: 'laptop', revoked: 0 }]);
    return Response.json(JSON.parse(String(init.body)));
  }); vi.stubGlobal('fetch', fetcher); vi.spyOn(console, 'log').mockImplementation(() => {});
  const flags: Record<string, string> = { '--grounds': 'away', '--repo': 'remote', '--brief-text': 'work', '--boat': 'LAPTOP' };
  const opts = { opt: (f: string) => flags[f], has: (f: string) => f in flags, values: () => [] };
  await wharfCommand('dispatch', [], opts, loadConfig());
  expect(JSON.parse(String(fetcher.mock.calls[1][1].body))).toMatchObject({ boat: 'stable-id', repoRemote: 'github.com/test/repo' });
});
it('refuses boat addressing on local grounds rather than silently dropping the target', async () => {
  const flags: Record<string, string> = { '--grounds': 'desk', '--boat': 'laptop' };
  const opts = { opt: (f: string) => flags[f], has: (f: string) => f in flags, values: () => [] };
  await expect(wharfCommand('dispatch', [], opts, loadConfig())).rejects.toThrow('requires wharf grounds');
  expect(fs.readdirSync(path.join(home, 'queue'))).toEqual([]);
});
it('has no other-boat or admin CLI actions, and whoami inspects only the current boat', async () => {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ name: 'this-boat', permissions: ['work'] })); vi.stubGlobal('fetch', fetcher);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const flags: Record<string, string> = { '--grounds': 'away' };
  const opts = { opt: (f: string) => flags[f], has: (f: string) => f in flags, values: () => [] };
  for (const command of ['issue-boat', 'boats', 'boat-permissions', 'revoke-boat', 'rename-boat', 'remove-boat', 'delete-account']) {
    expect(parseArgs('wharf', [command, '--grounds', 'away'])?.error).toContain('unknown wharf subcommand');
    await expect(wharfCommand('wharf', [command], opts, loadConfig())).rejects.toThrow('choose a wharf subcommand');
  }
  await expect(wharfCommand('wharf', ['whoami', 'another-boat'], opts, loadConfig())).rejects.toThrow('no boat argument');
  expect(fetcher).not.toHaveBeenCalled();
  expect(parseArgs('wharf', ['whoami', '--grounds', 'away'])?.error).toBeUndefined();
  await wharfCommand('wharf', ['whoami'], opts, loadConfig());
  expect(fetcher).toHaveBeenCalledWith('https://state.invalid/v1/accounts/person/_boat', expect.objectContaining({ method: 'GET' }));
});

it('wharf man ask/file upload scoped Markdown and attachments, publish, and retry with stable IDs/keys', async () => {
  const detail = path.join(home, 'detail.md'), attached = path.join(home, 'image.png');
  fs.writeFileSync(detail, '# Detail\n![image](image.png)'); fs.writeFileSync(attached, 'test image bytes');
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/files')) return Response.json({ id: (init.headers as Record<string, string>)['X-File-Name'] === 'image.png' ? 'image-id' : 'markdown-id' });
    return Response.json(JSON.parse(String(init.body)));
  }); vi.stubGlobal('fetch', fetcher); vi.spyOn(console, 'log').mockImplementation(() => {});
  const flags: Record<string, string> = { '--grounds': 'away', '--session': 'helm', '--title': 'Which way?', '--detail': detail, '--request-key': 'a'.repeat(128) };
  const opts = { opt: (f: string) => flags[f], has: (f: string) => f in flags, values: (f: string) => f === '--option' ? ['One', 'Two'] : f === '--attach' ? [attached] : [] };
  for (let i = 0; i < 2; i++) expect(await wharfCommand('man:ask', [], opts, loadConfig())).toBe(true);
  expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toMatchObject({ kind: 'decision', title: 'Which way?', options: ['One', 'Two'], id: expect.stringMatching(/^[a-f0-9]{32}$/) });
  expect(fetcher.mock.calls[0][0]).toEqual(fetcher.mock.calls[4][0]);
  expect(fetcher.mock.calls[0][1].body).toEqual(fetcher.mock.calls[4][1].body);
  expect(fetcher.mock.calls[0][1].headers).toEqual(fetcher.mock.calls[4][1].headers);
  for (const [url, init] of fetcher.mock.calls) {
    expect(url).toContain('/v1/accounts/person/documents');
    expect((init.headers as Record<string, string>)['X-Lobstah-Helm']).toBe('helm');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(JSON.parse(String(fetcher.mock.calls[3][1].body))).toEqual({ markdown: 'markdown-id', attachments: ['image-id'] });
  fetcher.mockClear(); flags['--request-key'] = 'report-once';
  expect(await wharfCommand('man:file', [detail], opts, loadConfig())).toBe(true);
  expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toMatchObject({ kind: 'report', options: [] });
  expect(fs.existsSync(path.join(home, 'decisions')) ? fs.readdirSync(path.join(home, 'decisions')) : []).toEqual([]);
});

it('worker reports upload only their dispatch files and human-request CLI verbs carry the helm lease', async () => {
  const markdown = path.join(home, 'report.md'); fs.writeFileSync(markdown, '# Evidence');
  const fetcher = vi.fn(async (url: string, init: RequestInit) => url.endsWith('/files') ? Response.json({ id: 'markdown-id' }) : Response.json(init.body ? JSON.parse(String(init.body)) : []));
  vi.stubGlobal('fetch', fetcher); vi.spyOn(console, 'log').mockImplementation(() => {});
  const flags: Record<string, string> = { '--grounds': 'away', '--session': 'helm', '--report': markdown, '--request-key': 'report' };
  const opts = { opt: (f: string) => flags[f], has: (f: string) => f in flags, values: (f: string) => f === '--pr' ? ['https://github.com/test/repo/pull/1'] : [] };
  expect(await wharfCommand('report', ['job', 'done', 'Finished'], opts, loadConfig())).toBe(true);
  expect(fetcher.mock.calls[0][0]).toContain('/dispatches/job/files');
  expect(JSON.parse(String(fetcher.mock.calls[1][1].body))).toMatchObject({ verb: 'done', evidence: { files: ['markdown-id'], prUrls: ['https://github.com/test/repo/pull/1'] } });
  for (const verb of ['requests', 'request-receipt', 'request-execute']) {
    expect(parseArgs('wharf', [verb, '--grounds', 'away'])?.error).toBeUndefined();
    await wharfCommand('wharf', [verb, 'human-request'], opts, loadConfig());
  }
  expect(fetcher.mock.calls.at(-1)?.[0]).toContain('/requests/human-request/execute');
});

it('a wharf card answer reaches man wait through the ordered event cursor', async () => {
  const event = { cursor: 'generation.8', kind: 'decision-answer', note: 'card', at: new Date().toISOString() };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/helm/renew') ? {} : { cursor: event.cursor, events: [event] })));
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const flags: Record<string, string> = { '--grounds': 'away', '--session': 'helm', '--after': 'generation.7', '--timeout': '1' };
  const opts = { opt: (f: string) => flags[f], has: (f: string) => f in flags, values: () => [] };
  await wharfCommand('man:wait', [], opts, loadConfig());
  expect(JSON.parse(output.mock.calls[0]![0])).toEqual({ cursor: event.cursor, events: [event] });
});

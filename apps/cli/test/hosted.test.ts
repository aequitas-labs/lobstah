import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { agentEnvironment, appendStatus, backendScope, claimNext, enqueue, ensureLayout, glassOrigin, groundsErrors, loadConfig, refreshHostedViews, readHostedViews, WharfBackend } from '@lobstah/core';
import { hostedGlassLink } from '../src/hosted-view.js';
import { ackItemExists } from '../src/acks.js';
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
    if (url.endsWith('/documents')) return Response.json([]);
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
it('a wharf item carries its grounds and its hosted glass link once the wharf names its glass; a local item carries neither', async () => {
  const at = new Date().toISOString();
  const answer = (glass?: string) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('http://127.0.0.1')) throw new Error('offline');
    return Response.json(url.endsWith('/documents') ? [] : [{ id: 'remote-job', repo: 'remote', brief: '# Remote task', state: 'active', status: { verb: 'needs-decision', note: 'which?', at } }],
      { headers: glass ? { 'X-Lobstah-Glass': glass } : {} });
  }));
  const item = () => buildTendReport().attention.find((a) => a.note?.startsWith('[away@cloud]'))!;
  // An older wharf names no glass: the item says where it is from, and the click stays as it was.
  answer(); await refreshHostedViews(loadConfig());
  expect(item()).toMatchObject({ kind: 'question', grounds: 'away', wharf: 'cloud' }); expect(item().glass).toBeUndefined();
  // Only an exact HTTPS origin is an address a click may open.
  for (const refused of ['http://glass.example', 'https://glass.example/path', 'https://user:secret@glass.example', 'javascript:alert(1)', 'https://glass.example/#job/x']) {
    answer(refused); await refreshHostedViews(loadConfig()); expect(item().glass, refused).toBeUndefined();
  }
  answer('https://glass.example'); await refreshHostedViews(loadConfig());
  expect(item()).toMatchObject({ grounds: 'away', wharf: 'cloud', glass: 'https://glass.example/#job/remote-job' });
  expect(readHostedViews(loadConfig()).find((v) => v.wharf === 'cloud')!.glass).toBe('https://glass.example');
  // One answer without the header, or an unreachable wharf, keeps the last address named.
  answer(); await refreshHostedViews(loadConfig()); expect(item().glass).toBe('https://glass.example/#job/remote-job');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); })); await refreshHostedViews(loadConfig());
  expect(item()).toMatchObject({ quiet: true, glass: 'https://glass.example/#job/remote-job' });
  enqueue({ id: 'local-job', repo: 'local', brief: 'Local task' }); claimNext('work'); appendStatus('local-job', 'work', 'needs-decision', 'local question');
  const local = buildTendReport().attention.find((a) => a.id === 'local-job')!;
  expect(local.kind).toBe('question'); expect(local.grounds).toBeUndefined(); expect(local.wharf).toBeUndefined(); expect(local.glass).toBeUndefined();
});
/** One wharf account as the daemon's poll sees it: jobs, documents, and every path asked. */
function wharf(jobs: unknown[], documents: unknown[] | Response, asked: string[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    asked.push(new URL(url).pathname.split('/').at(-1)!);
    const headers = { 'X-Lobstah-Glass': 'https://glass.example' };
    if (url.endsWith('/documents')) return documents instanceof Response ? documents.clone() : Response.json(documents, { headers });
    return Response.json(jobs, { headers });
  }));
  return asked;
}
const card = (extra: Record<string, unknown> = {}) => ({ id: 'card', kind: 'decision', title: 'Choose the next catch', options: ['Keep it small', 'Split the work'], at: '2026-10-10T16:50:00.000Z', author: 'boat:b1', published: true, markdown: { id: 'md', name: 'detail.md', size: 40 }, attachments: [{ id: 'image', name: 'lob.png', size: 100 }], ...extra });
const filed = (extra: Record<string, unknown> = {}) => ({ id: 'progress', kind: 'report', title: 'Wharf progress', at: '2026-10-10T16:45:00.000Z', author: 'boat:b1', published: true, markdown: { id: 'report-md', name: 'report.md', size: 40 }, attachments: [], ...extra });
/** Reports walk only when attentionKinds asks for them, on a wharf as on local grounds. */
const config = (edit: (toml: string) => string) => fs.writeFileSync(path.join(home, 'config.toml'), "attentionKinds = ['question', 'decision', 'report']\n" + edit(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')));
/** Only the reachable wharf: the default config's second one answers nothing in every other test. */
const oneWharf = () => config((toml) => toml.replace(/\[grounds\.dev\][^[]*/, ''));
const wharfItems = () => buildTendReport().attention.filter((a) => a.wharf);
it('decisions and reports filed on a wharf reach the attention feed with their grounds, wharf and hosted glass link', async () => {
  oneWharf(); wharf([], [card(), filed(), { ...card(), id: 'draft', published: false }, { ...card(), id: 'gone', withdrawn: true }]);
  await refreshHostedViews(loadConfig());
  const [report, decision] = wharfItems(); expect(wharfItems()).toHaveLength(2);
  expect(decision).toMatchObject({ kind: 'decision', verb: 'decision', note: '[away@cloud] Choose the next catch', at: '2026-10-10T16:50:00.000Z',
    grounds: 'away', wharf: 'cloud', glass: 'https://glass.example/#decision/card', quiet: false });
  expect(report).toMatchObject({ kind: 'report', verb: 'report', note: '[away@cloud] Wharf progress', grounds: 'away', wharf: 'cloud', glass: 'https://glass.example/#report/progress' });
  expect(decision.key).toMatch(/^decision:srv-[0-9a-f]{40}$/); expect(report.key).toMatch(/^report:srv-[0-9a-f]{40}$/);
  // The local glass has no card or page for them: their lobs open the hosted glass.
  expect(lobItems(wharfItems(), { lobs: true, preview: false }).map((l) => l.href)).toEqual(['https://glass.example/#report/progress', 'https://glass.example/#decision/card']);
  // The boat keeps what an item needs and nothing of the content.
  expect(readHostedViews(loadConfig())[0]!.documents).toEqual([
    { id: 'card', kind: 'decision', title: 'Choose the next catch', at: '2026-10-10T16:50:00.000Z' },
    { id: 'progress', kind: 'report', title: 'Wharf progress', at: '2026-10-10T16:45:00.000Z' },
  ]);
  expect(fs.readFileSync(path.join(home, 'hosted-snapshots.json'), 'utf8')).not.toMatch(/Keep it small|detail\.md|lob\.png/);
  // Without `report` in attentionKinds (the default), only the decision walks, as on local grounds.
  fs.writeFileSync(path.join(home, 'config.toml'), fs.readFileSync(path.join(home, 'config.toml'), 'utf8').replace(/^attentionKinds.*\n/, ''));
  expect(wharfItems().map((a) => a.kind)).toEqual(['decision']);
});
/** The same wharf, also taking acks: each one is logged, and answered as the wharf would. */
function ackingWharf(jobs: Array<Record<string, any>>, documents: Array<Record<string, any>>, acks: string[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = { 'X-Lobstah-Glass': 'https://glass.example' }; const [, kind, id] = /\/(documents|dispatches)\/([^/]+)\/ack$/.exec(url) ?? [];
    if (!kind) return Response.json(url.endsWith('/documents') ? documents : jobs, { headers });
    expect(init.method).toBe('POST'); expect((init.headers as Record<string, string>).Authorization).toBe('Bearer helm-cloud'); expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
    acks.push(`${kind}/${id} ${String(init.body)}`);
    if (kind === 'documents') { const doc = documents.find((d) => d.id === id)!; doc.ack ??= { at: '2026-10-10T18:00:00.000Z', by: 'boat:this-boat' }; return Response.json(doc, { headers }); }
    const found = jobs.find((d) => d.id === id)!; const at = JSON.parse(String(init.body)).at;
    if (found.status.at !== at) return Response.json({ error: 'the job has no such current status; read it again before acknowledging' }, { status: 409 });
    found.ack ??= { status: at, at: '2026-10-10T18:00:00.000Z', by: 'boat:this-boat' }; return Response.json(found.ack, { headers });
  }));
  return acks;
}
const flags = (values: Record<string, string> = {}) => ({ opt: (f: string) => values[f], has: (f: string) => f in values, values: () => [] });
const staleDocuments = () => { const file = path.join(home, 'hosted-snapshots.json'); const rows = JSON.parse(fs.readFileSync(file, 'utf8')); for (const r of rows) r.documentsAt = '2026-10-10T00:00:00.000Z'; fs.writeFileSync(file, JSON.stringify(rows)); };
it('attention ack for a wharf item tells the wharf, writes no local ack file, and shows at once; unack refuses', async () => {
  oneWharf(); vi.spyOn(console, 'log').mockImplementation(() => {});
  const at = '2026-10-10T16:40:00.000Z';
  const jobs = [{ id: 'remote-job', repo: 'remote', brief: '# Remote task', state: 'active', status: { verb: 'needs-decision', note: 'which?', at } }];
  const acks = ackingWharf(jobs, [card(), filed()]); await refreshHostedViews(loadConfig());
  const item = (kind: string) => wharfItems().find((a) => a.kind === kind)!;
  const keys = { report: item('report').key, decision: item('decision').key, question: item('question').key };
  expect(wharfItems().some((a) => a.acked)).toBe(false);
  // The pet's call for each kind: `lobstah attention ack <key> --by pet`.
  for (const key of Object.values(keys)) expect(await wharfCommand('attention', ['ack', key], flags({ '--by': 'pet' }), loadConfig())).toBe(true);
  expect(acks).toEqual(['documents/progress {}', 'documents/card {}', `dispatches/remote-job ${JSON.stringify({ at })}`]);
  // The wharf is the record: nothing under ~/.lobstah/acks, and the boat's cache shows the ack before its next read.
  expect(fs.existsSync(path.join(home, 'acks'))).toBe(false);
  for (const kind of ['report', 'decision', 'question']) expect(item(kind).acked, kind).toEqual({ at: '2026-10-10T18:00:00.000Z', by: 'boat:this-boat' });
  expect(lobItems(wharfItems(), { lobs: true, preview: false })).toEqual([]);
  // A read that was already in flight, answered without the ack, does not un-acknowledge it here.
  const before = [card(), filed()]; const stale = [{ ...jobs[0], ack: undefined }];
  staleDocuments(); wharf(stale, before); await refreshHostedViews(loadConfig());
  for (const kind of ['report', 'decision', 'question']) expect(item(kind).acked, kind).toBeTruthy();
  // The job reports again: the new status stands unacknowledged, and it acks under its new time.
  const later = '2026-10-10T19:00:00.000Z'; jobs[0]!.status = { verb: 'blocked', note: 'stuck', at: later }; delete (jobs[0] as Record<string, unknown>).ack;
  ackingWharf(jobs, [card(), filed()], acks); await refreshHostedViews(loadConfig());
  expect(item('question')).toMatchObject({ note: '[away@cloud] stuck' }); expect(item('question').acked).toBeUndefined();
  expect(await wharfCommand('attention', ['ack', keys.question], flags(), loadConfig())).toBe(true);
  expect(acks.at(-1)).toBe(`dispatches/remote-job ${JSON.stringify({ at: later })}`); expect(item('question').acked).toBeTruthy();
  // An acknowledgement on a wharf stands; a key this boat does not know is an error, not a local file.
  await expect(wharfCommand('attention', ['unack', keys.report], flags(), loadConfig())).rejects.toThrow('stands');
  await expect(wharfCommand('attention', ['ack', 'report:srv-' + '0'.repeat(40)], flags(), loadConfig())).rejects.toThrow('no wharf item');
  expect(fs.existsSync(path.join(home, 'acks'))).toBe(false);
});
it('a wharf decision stands until answered or withdrawn, a report until acknowledged; another boat’s ack shows here', async () => {
  oneWharf(); wharf([], [card(), filed()]); await refreshHostedViews(loadConfig());
  const report = wharfItems().find((a) => a.kind === 'report')!, decision = wharfItems().find((a) => a.kind === 'decision')!;
  expect(ackItemExists(report.key)).toBe(true); expect(ackItemExists(decision.key)).toBe(true);
  // Acknowledged elsewhere (another boat's pet, or the report opened in the hosted glass): it stops walking here too.
  staleDocuments(); wharf([], [card(), filed({ ack: { at: '2026-10-10T17:30:00.000Z', by: 'person' } })]); await refreshHostedViews(loadConfig());
  expect(wharfItems().find((a) => a.kind === 'report')!.acked).toEqual({ at: '2026-10-10T17:30:00.000Z', by: 'person' });
  expect(lobItems(wharfItems(), { lobs: true, preview: false }).map((l) => l.href)).toEqual(['https://glass.example/#decision/card']);
  // Answered on the wharf: the decision is no longer attention.
  staleDocuments(); wharf([], [card({ answer: { option: 'Keep it small', at: '2026-10-10T17:00:00.000Z', by: 'person' } }), filed()]); await refreshHostedViews(loadConfig());
  expect(wharfItems().map((a) => a.kind)).toEqual(['report']); expect(ackItemExists(decision.key)).toBe(false); expect(ackItemExists(report.key)).toBe(true);
  expect(JSON.stringify(readHostedViews(loadConfig()))).not.toContain('Keep it small');
  // Withdrawn or deleted there: gone here.
  staleDocuments(); wharf([], []); await refreshHostedViews(loadConfig());
  expect(wharfItems()).toEqual([]); expect(ackItemExists(report.key)).toBe(false);
  // An unreachable wharf is unknown, not gone: the items go quiet, and nothing of theirs is culled as an orphan.
  staleDocuments(); wharf([], [filed()]); await refreshHostedViews(loadConfig());
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); })); await refreshHostedViews(loadConfig());
  expect(wharfItems()).toEqual([expect.objectContaining({ kind: 'report', quiet: true })]); expect(ackItemExists('report:srv-' + '0'.repeat(40))).toBe(true);
});
it('acks of local items stay on this boat for every grounds layout, without a request or a credential', async () => {
  const fetcher = vi.fn(async () => { throw new Error('a local acknowledgement must not reach a wharf'); }); vi.stubGlobal('fetch', fetcher);
  const layouts = [(toml: string) => toml, (toml: string) => toml.replace(/\[grounds\.desk\][^[]*/, ''), (toml: string) => toml.replace(/\[grounds\.desk\][^[]*/, '').replace(/\[grounds\.dev\][^[]*/, '')];
  const original = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  delete process.env.LOBSTAH_TEST_CLOUD_TOKEN; delete process.env.LOBSTAH_TEST_DEV_TOKEN;
  for (const layout of layouts) {
    fs.writeFileSync(path.join(home, 'config.toml'), layout(original));
    // false: the local handler takes it, and writes ~/.lobstah/acks.
    for (const key of ['work:0a1b2c3d', 'pr:o/r#1', 'decision:0a1b2c3d']) {
      expect(await wharfCommand('attention', ['ack', key], flags({ '--by': 'pet' }), loadConfig())).toBe(false);
      expect(await wharfCommand('attention', ['unack', key], flags(), loadConfig())).toBe(false);
      expect(await wharfCommand('attention', ['ack', key], flags({ '--grounds': 'away' }), loadConfig())).toBe(false);
    }
  }
  expect(fetcher).not.toHaveBeenCalled();
});
it('reads documents on the existing poll, at most every thirty seconds, and never opens another channel', async () => {
  oneWharf(); const asked = wharf([], [filed()]);
  await refreshHostedViews(loadConfig()); await refreshHostedViews(loadConfig()); await refreshHostedViews(loadConfig());
  expect(asked).toEqual(['dispatches', 'documents', 'dispatches', 'dispatches']); expect(wharfItems()).toHaveLength(1);
  const file = path.join(home, 'hosted-snapshots.json'); const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  rows[0].documentsAt = new Date(Date.now() - 31_000).toISOString(); fs.writeFileSync(file, JSON.stringify(rows));
  await refreshHostedViews(loadConfig()); expect(asked.slice(4)).toEqual(['dispatches', 'documents']);
});
it('a wharf without documents still shows its jobs; a boat without read gets nothing; a malformed list is unknown state', async () => {
  oneWharf(); const at = new Date().toISOString();
  const job = { id: 'remote-job', repo: 'remote', brief: '# Remote task', state: 'active', status: { verb: 'needs-decision', note: 'which?', at } };
  wharf([job], Response.json({ error: 'route not found' }, { status: 404 })); await refreshHostedViews(loadConfig());
  expect(readHostedViews(loadConfig())[0]).toMatchObject({ documents: [] }); expect(readHostedViews(loadConfig())[0]!.unavailable).toBeUndefined();
  expect(wharfItems().map((a) => a.kind)).toEqual(['question']);
  // A work-only boat is refused the job list itself, so it never asks for documents.
  fs.rmSync(path.join(home, 'hosted-snapshots.json')); const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { asked.push(url.split('/').at(-1)!); return Response.json({ error: 'read permission required' }, { status: 403 }); }));
  await refreshHostedViews(loadConfig()); expect(asked).toEqual(['dispatches']); expect(wharfItems()).toEqual([]);
  fs.rmSync(path.join(home, 'hosted-snapshots.json')); wharf([job], [{ id: '../x', kind: 'decision', title: 't', at, published: true }]); await refreshHostedViews(loadConfig());
  expect(readHostedViews(loadConfig())[0]!.unavailable).toMatch('unknown'); expect(wharfItems()).toEqual([]);
});
it('a decision about a job hides that job’s raw question, and each document shows under one grounds', async () => {
  config((toml) => toml.replace(/\[grounds\.dev\][^[]*/, "[grounds.second]\nrepos = ['local']\nwharf = 'cloud'\n").replace(/\[grounds\.desk\][^[]*/, ''));
  const asked = '2026-10-10T16:40:00.000Z';
  const jobs = [
    { id: 'remote-job', repo: 'remote', brief: '# Remote task', state: 'active', status: { verb: 'needs-decision', note: 'which?', at: asked } },
    { id: 'local-job', repo: 'local', brief: '# Second task', state: 'active', status: { verb: 'needs-decision', note: 'second?', at: asked } },
  ];
  wharf(jobs, [card({ dispatch: 'remote-job' }), filed()]); await refreshHostedViews(loadConfig());
  const items = wharfItems();
  // The framed question is hidden; the other grounds' question still stands.
  expect(items.map((a) => `${a.kind} ${a.grounds}`).sort()).toEqual(['decision away', 'question second', 'report away']);
  const decision = items.find((a) => a.kind === 'decision')!; expect(decision).toMatchObject({ repo: 'remote', lane: 'work' });
  // The decision is not second's to show: its job belongs to away's repo.
  expect(readHostedViews(loadConfig()).find((v) => v.grounds === 'second')!.documents!.map((d) => d.id)).toEqual(['progress']);
});
it('builds hosted glass links for the item kinds the glass routes, from safe ids only', () => {
  expect(hostedGlassLink({ glass: 'https://glass.example' }, 'decision', 'card_1')).toBe('https://glass.example/#decision/card_1');
  expect(hostedGlassLink({ glass: 'https://glass.example' }, 'report', 'r-1')).toBe('https://glass.example/#report/r-1');
  expect(hostedGlassLink({ glass: 'https://glass.example' }, 'job', '../boats')).toBeUndefined();
  expect(hostedGlassLink({}, 'job', 'job')).toBeUndefined();
  expect(glassOrigin('http://127.0.0.1:8788')).toBe('http://127.0.0.1:8788'); expect(glassOrigin('https://glass.example/')).toBeUndefined(); expect(glassOrigin(null)).toBeUndefined();
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

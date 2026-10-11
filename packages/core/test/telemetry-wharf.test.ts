import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { ensureLayout, enqueue, claimNext, appendStatus } from '../src/index.js';
import { configPath, loadConfig } from '../src/config.js';
import { telemetryContext, isHostedWharf } from '../src/telemetry-context.js';
import { observeLocalCatch } from '../src/catch-context.js';
import { takeHelm } from '../src/helm.js';
import { statsPath, readStatsStore, recordWharfCatch, recordCatch } from '../src/stats.js';
import { buildTelemetryPayload, serializeTelemetryPayload } from '../src/telemetry.js';
import { anonymousTelemetryPost } from '../src/telemetry-transport.js';
import { refreshHostedViews } from '../src/hosted-cache.js';
import { usageBucket, groundsBucket } from '../src/telemetry-usage.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const ID = '3b0c8f9e-6a1d-4c2e-9f3a-1b2c3d4e5f60';
let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-wharf-usage-')); process.env.LOBSTAH_HOME = home; ensureLayout(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); delete process.env.TEST_WHARF_TOKEN; delete process.env.LOBSTAH_HOME; removeTempDir(home); });
function config() {
  fs.writeFileSync(configPath(), `[wharves.secret-wharf]\nurl = "https://api.lobstah.dev"\naccount = "secret-account"\ntokenEnv = "TEST_WHARF_TOKEN"\n[grounds.secret-ground]\nrepos = []\nwharf = "secret-wharf"\n[grounds.second-ground]\nrepos = []\nwharf = "secret-wharf"\n[grounds.local-ground]\nrepos = []\n`);
  return loadConfig();
}
function snapshot(now = NOW, boats: number | null = 4, helmLive: boolean | null = true) {
  const base = { wharf: 'secret-wharf', url: 'https://api.lobstah.dev', account: 'secret-account', observedAt: new Date(now).toISOString(), dispatches: [], usage: { boats, helmLive, boatAccess: { work: true, read: true, helm: false }, observedAt: new Date(now).toISOString() } };
  fs.writeFileSync(path.join(home, 'hosted-snapshots.json'), JSON.stringify([{ ...base, grounds: 'secret-ground' }, { ...base, grounds: 'second-ground' }]));
}
it('classifies only the exact build-time project origin, never lookalikes or loopback', () => {
  expect(isHostedWharf('https://api.lobstah.dev/v1')).toBe(true);
  for (const origin of ['http://api.lobstah.dev', 'https://api.lobstah.dev:444', 'https://api.lobstah.dev.evil.test', 'https://lobstah.dev', 'http://127.0.0.1:8787', 'bad']) expect(isHostedWharf(origin)).toBe(false);
});
it('uses one cached account roster/helm for several grounds, buckets counts and scrubs all identities', () => {
  const cfg = config(); snapshot();
  expect(telemetryContext(cfg, NOW)).toEqual({ grounds: { total: '3-5', local: '1', wharf: '2' }, wharf: 'hosted', boats: '3-5', boatAccess: { work: true, read: true, helm: false }, remoteHelms: 1, remoteHelmsUnknown: false });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const p = buildTelemetryPayload(ID, NOW);
  expect(p).toMatchObject({ helms: 'one', helm: null, boats: '3-5' });
  const wire = serializeTelemetryPayload(p);
  for (const secret of ['secret-wharf', 'secret-account', 'secret-ground', 'second-ground', 'api.lobstah.dev', 'TEST_WHARF_TOKEN', home, '12:00:00']) expect(wire).not.toContain(secret);
  expect(fetch).not.toHaveBeenCalled();
});
it('missing, stale and unreadable observations remain unknown, not one boat or no helm', () => {
  const cfg = config();
  for (const setup of [() => {}, () => snapshot(NOW - 60_000), () => snapshot(NOW, null, null)]) {
    setup(); expect(telemetryContext(cfg, NOW)).toMatchObject({ boats: null, remoteHelmsUnknown: true });
    expect(buildTelemetryPayload(ID, NOW).helms).toBeNull();
  }
  snapshot();
  takeHelm({ sessionId: 'local', grounds: { name: 'local-ground', repos: [] }, ttlMs: 60_000, now: NOW });
  expect(buildTelemetryPayload(ID, NOW)).toMatchObject({ helms: 'several', helm: null });
});
it('labels mixed wharves without an address and scrubs injected nested names from the client wire', () => {
  const cfg = config(); snapshot();
  cfg.wharves.dev = { kind: 'wharf', url: 'http://127.0.0.1:8787', account: 'private', tokenEnv: 'SECRET' };
  cfg.grounds.dev = { repos: [], wharf: 'dev' };
  expect(telemetryContext(cfg, NOW)).toMatchObject({ wharf: 'both', boats: null });
  const p = buildTelemetryPayload(ID, NOW);
  for (const nested of ['catches', 'grounds', 'boatAccess'] as const) Object.assign(p[nested], { accountId: 'secret-account', boatName: 'user-name', wharfAddress: 'private-host', observedAt: '12:34:56' });
  const wire = serializeTelemetryPayload(p);
  for (const secret of ['secret-account', 'user-name', 'private-host', '12:34:56', 'accountId', 'boatName', 'wharfAddress', 'observedAt']) expect(wire).not.toContain(secret);
});
it('uses existing reads for work-only access without fetching a private roster or linking an install id', async () => {
  const cfg = config(); process.env.TEST_WHARF_TOKEN = 'secret-token';
  const reads: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); reads.push(url);
    expect(JSON.stringify(init)).not.toContain(ID);
    if (url.endsWith('/_boat')) return Response.json({ permissions: ['work'], name: 'user-chosen-name' });
    return Response.json({ error: 'read denied' }, { status: 403 });
  }));
  await refreshHostedViews(cfg);
  expect(reads.filter((r) => r.endsWith('/_boat'))).toHaveLength(1);
  expect(reads.some((r) => r.endsWith('/glass') || r.endsWith('/boats'))).toBe(false);
  expect(telemetryContext(cfg, Date.now())).toMatchObject({ boats: null, boatAccess: { work: true, read: false, helm: false } });
});
it('attributes new local catches at claim OR finish and preserves historical unknowns', () => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  fs.writeFileSync(configPath(), '[helm]\nttlSecs = 1\n');
  const desc = (id: string) => ({ id, repo: 'repo', brief: 'test' });
  enqueue(desc('claim')); claimNext('work');
  takeHelm({ sessionId: 'local', grounds: { name: 'home', repos: ['repo'] }, ttlMs: 1_000, now: NOW });
  enqueue(desc('finish')); claimNext('work');
  appendStatus('claim', 'work', 'done', 'done'); // No helm at claim, live at finish.
  vi.setSystemTime(NOW + 2_000);
  appendStatus('claim', 'work', 'done', 'retry after helm expired');
  expect(JSON.parse(fs.readFileSync(path.join(home, 'state', 'claim.catch-context'), 'utf8')).helm).toBe(true);
  appendStatus('finish', 'work', 'done', 'done'); // Live at claim, expired at finish.
  enqueue(desc('none')); claimNext('work'); appendStatus('none', 'work', 'done', 'done');
  fs.writeFileSync(path.join(home, 'state', 'legacy.status'), JSON.stringify({ verb: 'done', at: new Date(NOW).toISOString() }) + '\n');
  recordCatch('legacy', 'work', NOW + 2_000);
  expect(buildTelemetryPayload(ID, NOW + 2_000).catches).toMatchObject({ today: 4, withHelm: '2', withoutHelm: '1', helmUnknown: '1', onLocal: '3-5', onWharf: '0', locationUnknown: '1' });
  // No claim evidence in an old dispatch: seeing no helm now does not prove absence at claim.
  enqueue(desc('old')); observeLocalCatch('old', 'work', 'finish', NOW + 2_000);
  expect(JSON.parse(fs.readFileSync(path.join(home, 'state', 'old.catch-context'), 'utf8')).helm).toBeNull();
});
it('deduplicates wharf retry receipts and dates them by the accepted completion, not the retry', () => {
  const at = new Date(NOW).toISOString();
  recordWharfCatch('hashed-receipt', true, at, NOW);
  recordWharfCatch('hashed-receipt', true, at, NOW + 86400_000);
  expect(readStatsStore(NOW).totalCatches).toBe(1);
  expect(buildTelemetryPayload(ID, NOW).catches).toMatchObject({ today: 1, withHelm: '1', onWharf: '1' });
  // A pre-upgrade UTC table gains no invented attribution.
  fs.writeFileSync(statsPath(), JSON.stringify({ version: 1, totalCatches: 2, perTrap: {}, day: '2026-10-11', catchesToday: 2, daily: {}, counted: [], utc: { date: '2026-10-11', catches: 2, perTrap: {}, byWorker: [] } }));
  expect(buildTelemetryPayload(ID, NOW).catches).toMatchObject({ helmUnknown: '2', locationUnknown: '2' });
});
it('uses fixed small buckets at every boundary', () => {
  expect([0, 1, 2, 3, 5, 6, 10, 11, 1000].map(usageBucket)).toEqual(['0', '1', '2', '3-5', '3-5', '6-10', '6-10', '11+', '11+']);
  expect([0, 1, 2, 3, 5, 6, 1000].map(groundsBucket)).toEqual(['0', '1', '2', '3-5', '3-5', '6+', '6+']);
});
it('sends over fresh connections without wharf credentials, cookies, user agent, or redirects', async () => {
  const headers: http.IncomingHttpHeaders[] = [], sockets = new Set<unknown>();
  const server = http.createServer((req, res) => { headers.push(req.headers); sockets.add(req.socket); req.resume(); res.writeHead(302, { Location: '/forbidden' }); res.end(); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address() as { port: number };
    for (let i = 0; i < 2; i++) expect((await anonymousTelemetryPost(`http://127.0.0.1:${address.port}/daily`, { body: '{}', headers: { Authorization: 'secret-wharf-token', Cookie: 'wharf-cookie', 'User-Agent': 'account-name' } })).status).toBe(302);
    expect(sockets.size).toBe(2); expect(headers).toHaveLength(2);
    for (const h of headers) { expect(h.authorization).toBeUndefined(); expect(h.cookie).toBeUndefined(); expect(h['user-agent']).toBeUndefined(); }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

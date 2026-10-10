import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BackendError, brokerAddressFile, brokerRequest, ensureLayout, loadConfig, saveBrokerAgent, type BrokerAgent, type ClaimReceipt } from '@lobstah/core';
import { BROKER_LIVENESS_MS, startWharfBroker, WharfTrapBroker, type BrokerOptions } from '../src/wharf-trap-broker.js';
import { wharfCommand } from '../src/wharf-commands.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string, now: number, alive: boolean;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-broker-')); process.env.LOBSTAH_HOME = home; ensureLayout();
  now = Date.now(); alive = true;
  fs.writeFileSync(path.join(home, 'config.toml'), `
[repos.repo]
path = '${home.replaceAll('\\', '/')}'
[wharves.cloud]
url = 'https://state.invalid'
account = 'person'
tokenEnv = 'BROKER_TEST_BOAT'
[grounds.away]
repos = ['repo']
wharf = 'cloud'
`);
});
afterEach(() => { vi.restoreAllMocks(); delete process.env.LOBSTAH_HOME; delete process.env.LOBSTAH_WHARF_SESSION_PID; removeTempDir(home); });
const receipt: ClaimReceipt = { dispatch: { id: 'job', repo: 'repo', brief: 'work' }, epoch: 1, token: 'd.person.job.1.job-secret', leaseUntil: new Date(Date.now() + 90000).toISOString() };
function fixture(extra: Partial<BrokerOptions> = {}) {
  const request = vi.fn(async () => ({})), claim = vi.fn(async () => receipt);
  const prepare = vi.fn(async () => home), launch = vi.fn(async () => {}), validateClaim = vi.fn(async () => {});
  const options: BrokerOptions = { config: loadConfig, now: () => now, alive: () => alive,
    backend: () => ({ request, claim }), prepare, launch, validateClaim, identity: () => 'github.com/test/repo', inbox: async () => [], ...extra };
  return { broker: new WharfTrapBroker(options), options, request, claim, prepare, launch, validateClaim };
}
const body = (a: BrokerAgent) => ({ grounds: a.grounds, session: a.session, capability: a.capability });
async function signOn(broker: WharfTrapBroker) {
  const t = await broker.ticket('away', 'repo');
  return broker.signOn({ ...t, session: 'session', pid: 123, harness: 'codex' });
}

it('binds a short-lived ticket to one trap, repo, request and grounds; only one concurrent sign-on wins', async () => {
  const f = fixture(), t = await f.broker.ticket('away', 'repo', 'request');
  for (const field of ['trap', 'repo', 'request', 'grounds']) await expect(f.broker.signOn({ ...t, [field]: 'foreign', session: 'session', pid: 123 })).rejects.toThrow('binding mismatch');
  const results = await Promise.allSettled([1, 2].map(() => f.broker.signOn({ ...t, session: 'session', pid: 123 })));
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(f.request.mock.calls.filter((c) => c[0] === 'workers/sign-on')).toHaveLength(1);
  await expect(f.broker.signOn({ ...t, session: 'session', pid: 123 })).rejects.toThrow('consumed');
});
it('refuses unknown repos before preparing, and tickets that expire during preparation or before sign-on', async () => {
  const f = fixture(); await expect(f.broker.ticket('away', 'foreign')).rejects.toThrow('not configured'); expect(f.prepare).not.toHaveBeenCalled();
  const t = await f.broker.ticket('away', 'repo'); now += 180001;
  await expect(f.broker.signOn({ ...t, session: 'session', pid: 123 })).rejects.toThrow('expired');
  f.prepare.mockImplementation(async () => { now += 180001; return home; });
  await expect(f.broker.ticket('away', 'repo')).rejects.toThrow('expired before launch');
  expect(f.launch).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
});
it('two different tickets cannot sign concurrent sessions on in the same worktree', async () => {
  const f = fixture(), first = await f.broker.ticket('away', 'repo'), second = await f.broker.ticket('away', 'repo');
  const results = await Promise.allSettled([first, second].map((t) => f.broker.signOn({ ...t, session: t.trap, pid: 123 })));
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(f.request).toHaveBeenCalledTimes(1);
});
it('serialises polls, redelivers an unreported brief and then only delivers explicit inbox messages', async () => {
  const f = fixture({ inbox: async () => [{ id: '1', text: 'answer', received: false }, { id: '2', text: 'old', received: true }] });
  const a = await signOn(f.broker);
  const polls = await Promise.all([1, 2].map(() => f.broker.handle('poll', body(a))));
  expect(polls).toEqual([{ claim: receipt }, { claim: receipt }]); expect(f.claim).toHaveBeenCalledTimes(1);
  await f.broker.handle('progress', { ...body(a), dispatch: 'job' });
  expect(await f.broker.handle('poll', body(a))).toEqual({ claim: null, dispatch: 'job', messages: [{ id: '1', text: 'answer', received: false }] });
  await f.broker.handle('finish', { ...body(a), dispatch: 'job' }); await f.broker.handle('poll', body(a)); expect(f.claim).toHaveBeenCalledTimes(2);
});
it('renews only while the exact session process and its heartbeat are live; end stops renewal', async () => {
  const f = fixture(), a = await signOn(f.broker); f.request.mockClear();
  await f.broker.poll(); expect(f.request).toHaveBeenCalledTimes(1);
  now += BROKER_LIVENESS_MS; await f.broker.poll(); expect(f.request).toHaveBeenCalledTimes(1);
  await f.broker.handle('heartbeat', body(a)); expect(f.request).toHaveBeenCalledTimes(2);
  alive = false; await f.broker.poll(); expect(f.request).toHaveBeenCalledTimes(2);
  await expect(f.broker.handle('heartbeat', body(a))).rejects.toThrow('gone');
  alive = true; await expect(f.broker.handle('heartbeat', body(a))).rejects.toThrow('unknown'); // PID reuse cannot revive a dead session.
  const next = await signOn(f.broker); await f.broker.handle('end', body(next));
  f.request.mockClear(); await f.broker.poll(); expect(f.request).not.toHaveBeenCalled();
});
it('drops an expired or replaced claim instead of returning a stale job token', async () => {
  const f = fixture(), a = await signOn(f.broker); await f.broker.handle('poll', body(a));
  f.validateClaim.mockRejectedValue(new BackendError(409, 'stale claim epoch'));
  expect(await f.broker.handle('heartbeat', body(a))).toEqual({ claim: null });
  f.claim.mockResolvedValue(null!); expect(await f.broker.handle('poll', body(a))).toEqual({ claim: null });
});
it('stowing during an in-flight renewal never goes on to claim another dispatch', async () => {
  const f = fixture(), a = await signOn(f.broker);
  let release!: () => void; f.request.mockImplementation(() => new Promise((resolve) => { release = () => resolve({}); }));
  const poll = f.broker.handle('poll', body(a)); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await f.broker.handle('end', body(a)); release(); await poll;
  expect(f.claim).not.toHaveBeenCalled(); await f.broker.poll(); expect(f.request).toHaveBeenCalledTimes(2);
});
it('defaults glass starts off, then accepts one authorized configured repo request without arbitrary launch fields', async () => {
  const f = fixture(); await f.broker.poll(); expect(f.request).not.toHaveBeenCalled();
  fs.appendFileSync(path.join(home, 'config.toml'), '\n[soak]\nacceptWharfStarts = true\n');
  f.request.mockImplementation(async (route: string) => route === 'requests/starts' ? [{ id: 'start', repo: 'github.com/test/repo', expiresAt: new Date(now + 60000).toISOString(), command: 'arbitrary', harness: 'foreign' }] : {});
  await Promise.all([f.broker.poll(), f.broker.poll()]);
  expect(f.launch).toHaveBeenCalledTimes(1);
  expect(f.launch.mock.calls[0][0]).toMatchObject({ repo: 'repo', grounds: 'away', request: 'start', worktree: home });
  expect(f.launch.mock.calls[0][0]).not.toHaveProperty('command'); expect(f.launch.mock.calls[0][0]).not.toHaveProperty('harness');
});
it('refuses an unconfigured glass repo and never starts expired requests, including preparation that crosses expiry', async () => {
  fs.appendFileSync(path.join(home, 'config.toml'), '\n[soak]\nacceptWharfStarts = true\n');
  const f = fixture(); f.request.mockImplementation(async (route: string) => route === 'requests/starts' ? [
    { id: 'foreign', repo: 'github.com/test/other', expiresAt: new Date(now + 60000).toISOString() },
    { id: 'expired', repo: 'github.com/test/repo', expiresAt: new Date(now - 1).toISOString() },
  ] : {});
  await f.broker.poll(); expect(f.request).toHaveBeenCalledWith('requests/foreign/start', { refused: 'repo is not configured on this boat' }, 'refuse-foreign');
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
  f.request.mockImplementation(async (route: string) => route === 'requests/starts' ? [{ id: 'late', repo: 'github.com/test/repo', expiresAt: new Date(now + 1).toISOString() }] : {});
  f.prepare.mockImplementation(async () => { now += 2; return home; });
  await expect(f.broker.poll()).rejects.toThrow('expired before launch'); expect(f.launch).not.toHaveBeenCalled();
});
it('uses the same bounded local interface for manual soak and throw, returning only tickets and job capabilities', async () => {
  const f = fixture(), running = await startWharfBroker(f.options);
  try {
    const t = await brokerRequest<Record<string, unknown>>('ticket', { grounds: 'away', repo: 'repo', cwd: home });
    const a = await brokerRequest<BrokerAgent>('sign-on', { ...t, session: 'session', pid: 123 });
    const result = await brokerRequest('poll', body(a)); expect(result).toEqual({ claim: receipt });
    await brokerRequest('launch', { grounds: 'away', repo: 'repo', command: 'ignored' }); expect(f.launch).toHaveBeenCalledTimes(1);
    for (const route of ['credentials', '_boat', 'helm/take', 'dispatches', 'proxy']) await expect(brokerRequest(route, body(a))).rejects.toThrow('action not available');
    expect(JSON.stringify({ t, a, result })).not.toContain('boat-secret');
    const address = JSON.parse(fs.readFileSync(brokerAddressFile(), 'utf8'));
    expect((await fetch(`http://127.0.0.1:${address.port}/ticket`, { method: 'POST', headers: { Origin: 'https://foreign.invalid', 'X-Lobstah-Broker': address.nonce }, body: '{}' })).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${address.port}/ticket`, { method: 'POST', body: '{}' })).status).toBe(400);
  } finally { await running.close(); }
  await expect(brokerRequest('ticket', {})).rejects.toThrow("the boat's daemon is not running");
});
it('a bound coding agent cannot invoke global reads, login or helm using the boat credential', async () => {
  saveBrokerAgent({ grounds: 'away', repo: 'repo', trap: 'test-crab', session: 'session', capability: 'secret', worktree: home }, home);
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(home);
  const opts = { opt: () => undefined, has: () => false, values: () => [] };
  await expect(wharfCommand('stats', [], opts, loadConfig())).rejects.toThrow('only its own catch');
  await expect(wharfCommand('wharf', ['login'], opts, loadConfig())).rejects.toThrow('boat credential');
  await expect(wharfCommand('man:helm', [], opts, loadConfig())).rejects.toThrow('helm seat'); cwd.mockRestore();
});
it('manual CLI soak, report and inbox share broker sign-on/renew without ever reading a boat credential', async () => {
  const f = fixture(), running = await startWharfBroker(f.options);
  vi.spyOn(process, 'cwd').mockReturnValue(home); process.env.LOBSTAH_WHARF_SESSION_PID = '123';
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const flags: Record<string, string> = { '--grounds': 'away', '--repo': 'repo', '--session': 'session', '--harness': 'codex' };
  const opts = { opt: (f: string) => flags[f], has: (f: string) => f in flags, values: () => [] };
  const originalFetch = globalThis.fetch;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1:')) return originalFetch(url, init);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${receipt.token}`);
    return Response.json(String(url).endsWith('/messages') ? [{ id: '1', text: 'answer', received: false }] : {});
  });
  try {
    await wharfCommand('soak', [], opts, loadConfig());
    expect(JSON.parse(output.mock.calls.at(-1)![0]).claim).toEqual(receipt);
    await wharfCommand('report', ['job', 'working', 'started'], opts, loadConfig());
    await wharfCommand('inbox', ['job'], opts, loadConfig());
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/dispatches/job/report'))).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/dispatches/job/messages'))).toBe(true);
    await wharfCommand('stow', [], opts, loadConfig());
  } finally { await running.close(); }
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { askDecision, ensureLayout, listGrants, loadConfig, readDecisionAnswer } from '@lobstah/core';
import type { MirrorStatus, WharfMirrorCall } from '@lobstah/core';
import { serveGlass } from '../src/glass.js';
import { askPermission } from '../src/grants-cli.js';
import { MIRROR_IDLE_PASS_MS, MIRROR_IDLE_PUT_MS, MIRROR_WATCHED_PASS_MS, WharfMirror, loopbackGlass, startWharfMirror } from '../src/wharf-mirror.js';
import type { LocalGlass, MirrorWharf } from '../src/wharf-mirror.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * The daemon's mirror: this machine's glass on a wharf's hosted glass. It
 * puts the local snapshot (never the page token) when it changes, and
 * carries out on the local glass, over loopback, the calls a person makes
 * on the hosted glass, refusing any the hosted glass may not make.
 */

let home: string;
let server: Server | undefined;
let port: number;
let now: number;

/** A wharf that records what the mirror sends it and hands it the calls a test queues. */
class FakeWharf implements MirrorWharf {
  puts: Array<Record<string, unknown>> = [];
  rawPuts: Buffer[] = [];
  queued: WharfMirrorCall[] = [];
  taken: string[] = [];
  answers = new Map<string, { status: number; contentType: string; body: string }>();
  files = new Map<string, { name: string; bytes: Uint8Array }>();
  watchedUntil?: string;
  async putMirrorSnapshot(gzip: Uint8Array) {
    const raw = gunzipSync(gzip);
    this.rawPuts.push(raw);
    this.puts.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
    return { etag: 'e'.repeat(64), bytes: gzip.byteLength, at: new Date(now).toISOString() };
  }
  async mirrorCalls() {
    const calls = this.queued;
    this.queued = [];
    return { calls, ...(this.watchedUntil ? { watchedUntil: this.watchedUntil } : {}) };
  }
  async takeMirrorCall(id: string) { this.taken.push(id); }
  async answerMirrorCall(id: string, status: number, contentType: string, body: Uint8Array) {
    this.answers.set(id, { status, contentType, body: Buffer.from(body).toString('utf8') });
  }
  async mirrorFile(id: string) { return this.files.get(id)!; }
}

/** The loopback glass, with every path and request kind the mirror sent it written down. */
function recordingGlass(): LocalGlass & { gets: string[]; requests: string[] } {
  const glass = loopbackGlass(port);
  const gets: string[] = [], requests: string[] = [];
  return {
    gets, requests,
    get: (p, etag) => { gets.push(p); return glass.get(p, etag); },
    request: (kind, payload, token) => { requests.push(kind); return glass.request(kind, payload, token); },
  };
}

const call = (id: string, body: { read: string } | { write: { kind: string; payload: unknown } }, files?: string[]): WharfMirrorCall =>
  ({ id, boat: 'boat-1', ...body, ...(files ? { files } : {}), at: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString(), state: 'queued', by: 'person' }) as WharfMirrorCall;

function mirror(wharf: FakeWharf, glass: LocalGlass = loopbackGlass(port)): WharfMirror {
  return new WharfMirror({ wharf: 'lobstah', backend: wharf, glass, now: () => now, writeStatus: (_status: MirrorStatus) => {} });
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-wharf-mirror-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '');
  server = serveGlass(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
  now = Date.parse('2026-11-09T12:00:00.000Z');
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
  vi.unstubAllGlobals();
});

describe('the snapshot', () => {
  it('puts a changed snapshot on the next pass while a hosted glass is open, within five seconds', async () => {
    const wharf = new FakeWharf();
    wharf.watchedUntil = new Date(now + 30_000).toISOString();
    const m = mirror(wharf);
    expect(await m.pass()).toBe(MIRROR_WATCHED_PASS_MS);
    expect(MIRROR_WATCHED_PASS_MS).toBeLessThanOrEqual(5_000);
    expect(wharf.puts).toHaveLength(1);
    // Nothing changed: nothing is put.
    now += MIRROR_WATCHED_PASS_MS;
    await m.pass();
    expect(wharf.puts).toHaveLength(1);
    // The fleet changes: the next pass, one interval later, puts it.
    askDecision({ title: 'Ship the tray?', options: ['Yes', 'No'], askedBy: 'helm', maxBytes: 1_000_000 });
    now += MIRROR_WATCHED_PASS_MS;
    await m.pass();
    expect(wharf.puts).toHaveLength(2);
    expect((wharf.puts[1]!.decisions as Array<{ title: string }>).map((d) => d.title)).toEqual(['Ship the tray?']);
  });

  it('puts a changed snapshot at most every five minutes while no hosted glass is open', async () => {
    const wharf = new FakeWharf();
    const m = mirror(wharf);
    expect(await m.pass()).toBe(MIRROR_IDLE_PASS_MS);
    expect(wharf.puts).toHaveLength(1);
    askDecision({ title: 'Ship the tray?', options: ['Yes', 'No'], askedBy: 'helm', maxBytes: 1_000_000 });
    now += MIRROR_IDLE_PASS_MS;
    await m.pass();
    expect(wharf.puts).toHaveLength(1);
    now += MIRROR_IDLE_PUT_MS;
    await m.pass();
    expect(wharf.puts).toHaveLength(2);
  });

  it('never sends the page token', async () => {
    const token = ((await (await fetch(`http://127.0.0.1:${port}/data`)).json()) as { focusToken: string }).focusToken;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const wharf = new FakeWharf();
    await mirror(wharf).pass();
    expect(wharf.puts[0]).not.toHaveProperty('focusToken');
    expect(wharf.rawPuts[0]!.toString('utf8')).not.toContain(token);
  });
});

describe('relayed calls', () => {
  it('carries out an allowed read and answers with the local glass’s own status and body', async () => {
    const wharf = new FakeWharf();
    wharf.queued = [call('stats', { read: '/data/stats' })];
    await mirror(wharf).pass();
    expect(wharf.taken).toEqual(['stats']);
    const answer = wharf.answers.get('stats')!;
    expect(answer.status).toBe(200);
    expect(answer.contentType).toMatch(/^application\/json/);
    expect(JSON.parse(answer.body)).toHaveProperty('catchesToday');
  });

  it('refuses a call outside the allowlist without calling the local glass', async () => {
    const wharf = new FakeWharf();
    const glass = recordingGlass();
    wharf.queued = [
      call('focus', { write: { kind: 'focus', payload: { trapId: 'x' } } }),
      call('raw', { read: '/api/focus/x' }),
      call('climb', { read: '/data/dispatch/%2e%2e' }),
    ];
    await mirror(wharf, glass).pass();
    for (const id of ['focus', 'raw', 'climb']) {
      expect(wharf.answers.get(id)?.status, id).toBe(403);
    }
    expect(glass.requests).toEqual([]);
    expect(glass.gets).toEqual(['/data']);
  });

  it('records a relayed decision answer as by: wharf', async () => {
    const { meta } = askDecision({ title: 'Ship the tray?', options: ['Yes', 'No'], askedBy: 'helm', maxBytes: 1_000_000 });
    const wharf = new FakeWharf();
    wharf.queued = [call('answer', { write: { kind: 'decision-answer', payload: { key: meta.key, option: 'Yes' } } })];
    await mirror(wharf).pass();
    expect(wharf.answers.get('answer')?.status).toBe(201);
    expect(readDecisionAnswer(meta.key)).toMatchObject({ option: 'Yes', by: 'wharf' });
  });

  it('brings the files a person attached on the hosted glass to the local answer', async () => {
    const { meta } = askDecision({ title: 'Which tray?', askedBy: 'helm', maxBytes: 1_000_000 });
    const wharf = new FakeWharf();
    wharf.files.set('file-1', { name: 'tray.txt', bytes: new TextEncoder().encode('the wide one') });
    wharf.queued = [call('answer', { write: { kind: 'decision-answer', payload: { key: meta.key, text: 'see the file' } } }, ['file-1'])];
    await mirror(wharf).pass();
    expect(wharf.answers.get('answer')?.status).toBe(201);
    const answer = readDecisionAnswer(meta.key)!;
    expect(answer.attachments.map((a) => a.name)).toEqual(['tray.txt']);
    expect(fs.readFileSync(answer.attachments[0]!.path, 'utf8')).toBe('the wide one');
  });

  it('lets a person allow a permission card from the hosted glass, as from the local one', async () => {
    const card = askPermission({ dispatch: 'job-1', lane: 'work', ask: { command: 'npm publish --dry-run', harness: 'claude' } });
    const wharf = new FakeWharf();
    wharf.queued = [call('allow', { write: { kind: 'decision-answer', payload: { key: card.key, option: 'Allow once' } } })];
    await mirror(wharf).pass();
    expect(wharf.answers.get('allow')?.status).toBe(201);
    expect(listGrants().grants.map((g) => g.command)).toContain('npm publish --dry-run');
  });
});

describe('without [glass] mirror', () => {
  it('makes no wharf request', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[wharves.lobstah]\nurl = "https://api.lobstah.test"\naccount = "acct"\ntokenEnv = "LOBSTAH_TEST_WHARF"\n');
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    expect(startWharfMirror(loadConfig(), () => {})).toBeUndefined();
    expect(fetched).not.toHaveBeenCalled();
  });

  it('refuses a mirror that names no configured wharf', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[glass]\nmirror = "nowhere"\n');
    expect(() => loadConfig()).toThrow(/\[glass\] mirror must name a wharf/);
  });
});

describe('enrolling this machine as a mirror boat', () => {
  const BOAT_TOKEN = 'b.acct.boat-1.abcdefghijklmnopqrstuvwxyz012345';
  const options = (flags: Record<string, string | true>) => ({
    opt: (flag: string) => (typeof flags[flag] === 'string' ? (flags[flag] as string) : undefined),
    has: (flag: string) => flag in flags,
    values: () => [] as string[],
  });
  beforeEach(() => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[wharves.lobstah]\nurl = "https://api.lobstah.test"\naccount = "acct"\ntokenEnv = "LOBSTAH_TEST_WHARF"\n\n[glass]\nmirror = "lobstah"\n');
  });

  it('asks for a mirror boat, saves its credential, and whoami names it with its mirror', async () => {
    const asked: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/v1/auth/device/code')) return Response.json({ device_code: 'device', user_code: 'ABCD-EFGH', verification_uri: 'https://glass.lobstah.test/device', expires_in: 600, interval: 1 });
      if (url.endsWith('/v1/auth/device/token')) return Response.json({ token: BOAT_TOKEN, id: 'boat-1', name: 'studio', permissions: ['mirror', 'read'] });
      if (url.endsWith('/v1/accounts/acct/_boat')) return Response.json({ id: 'boat-1', name: 'studio', permissions: ['mirror', 'read'] });
      throw new Error(`unexpected request ${url}`);
    }));
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    const { wharfCommand } = await import('../src/wharf-commands.js');
    expect(await wharfCommand('wharf', ['login'], options({ '--wharf': 'lobstah', '--mirror': true, '--name': 'studio' }), loadConfig())).toBe(true);
    expect(asked[0]!.body).toMatchObject({ account: 'acct', name: 'studio', steering: 'read', mirror: true });
    expect(lines.join('\n')).toContain('Approve boat studio (mirror + read)');
    expect(JSON.parse(fs.readFileSync(path.join(home, 'credentials', 'wharf-lobstah.json'), 'utf8')).token).toBe(BOAT_TOKEN);
    lines.length = 0;
    expect(await wharfCommand('wharf', ['whoami'], options({ '--wharf': 'lobstah' }), loadConfig())).toBe(true);
    expect(lines.join('\n')).toMatch(/boat: studio/);
    expect(lines.join('\n')).toMatch(/permissions: mirror \+ read/);
    expect(lines.join('\n')).toMatch(/mirror: never/);
  });

  it('refuses --wharf login without --mirror, since it has no grounds to work in', async () => {
    const { wharfCommand } = await import('../src/wharf-commands.js');
    await expect(wharfCommand('wharf', ['login'], options({ '--wharf': 'lobstah' }), loadConfig())).rejects.toThrow(/--mirror/);
  });
});

describe('the doctor’s wharf mirror row', () => {
  it('warns with the login command, then says how recently the snapshot was put', async () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[wharves.lobstah]\nurl = "https://api.lobstah.test"\naccount = "acct"\ntokenEnv = "LOBSTAH_TEST_WHARF"\n\n[glass]\nmirror = "lobstah"\n');
    const { mirrorRow } = await import('../src/doctor.js');
    const { writeMirrorStatus } = await import('@lobstah/core');
    expect(mirrorRow(loadConfig(), now)).toMatchObject({ check: 'wharf mirror', status: 'warn', detail: expect.stringContaining('lobstah wharf login --wharf lobstah --mirror') });
    process.env.LOBSTAH_TEST_WHARF = 'b.acct.boat-1.abcdefghijklmnopqrstuvwxyz012345';
    try {
      expect(mirrorRow(loadConfig(), now)).toMatchObject({ status: 'warn', detail: expect.stringContaining('no snapshot put yet') });
      writeMirrorStatus({ wharf: 'lobstah', lastPutAt: new Date(now - 60_000).toISOString(), calls: 2, at: new Date(now).toISOString() });
      expect(mirrorRow(loadConfig(), now)).toMatchObject({ status: 'ok', detail: expect.stringContaining('2 calls carried out') });
      expect(mirrorRow(loadConfig(), now + 10 * 60_000)).toMatchObject({ status: 'warn', detail: expect.stringContaining('longer ago') });
    } finally { delete process.env.LOBSTAH_TEST_WHARF; }
  });

  it('is absent without [glass] mirror', async () => {
    const { mirrorRow } = await import('../src/doctor.js');
    expect(mirrorRow(loadConfig(), now)).toBeUndefined();
  });
});

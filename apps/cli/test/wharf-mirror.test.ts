import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ANSWER_INLINE_MAX_BYTES, askDecision, claimBait, decodeFrame, enqueue, ensureLayout, listGrants, listNotices, loadConfig, readDecisionAnswer, settlePermissionCards, signOnTrap } from '@lobstah/core';
import type { ClientSocketMessage, MirrorStatus, WharfMirrorCall } from '@lobstah/core';
import { serveGlass } from '../src/glass.js';
import { askPermission } from '../src/grants-cli.js';
import { MIRROR_IDLE_READ_MS, MIRROR_STALE_NOTICE_MS, MIRROR_WATCHED_READ_MS, WharfMirror, loopbackGlass, startWharfMirror } from '../src/wharf-mirror.js';
import type { LocalGlass, MirrorChannel, MirrorWharf } from '../src/wharf-mirror.js';
import { readOtherBoats } from '../src/wharf-attention.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * The daemon's mirror: this machine's glass on a wharf's hosted glass, over
 * its socket. While a glass is open it sends the local snapshot (never the
 * page token) each time it changes; it carries out on the local glass, over
 * loopback, the calls pushed to it, refusing any the hosted glass may not
 * make; and with no glass open and nothing changing it sends nothing.
 */

let home: string;
let server: Server | undefined;
let port: number;
let now: number;

/** A wharf and its socket in one: what the mirror sends on the socket (frames, messages) and over HTTP. */
class FakeWharf implements MirrorWharf, MirrorChannel {
  puts: Array<Record<string, unknown>> = [];
  rawPuts: Buffer[] = [];
  messages: ClientSocketMessage[] = [];
  answers = new Map<string, { status: number; contentType: string; body: string; over: 'socket' | 'http' }>();
  http: string[] = [];
  files = new Map<string, { name: string; bytes: Uint8Array }>();
  open = true;
  connected() { return this.open; }
  send(message: ClientSocketMessage) {
    if (!this.open) return false;
    this.messages.push(message);
    return true;
  }
  sendFrame(bytes: Uint8Array) {
    if (!this.open) return false;
    const frame = decodeFrame(bytes)!;
    if (frame.header.t === 'snapshot') {
      const raw = gunzipSync(frame.payload);
      this.rawPuts.push(raw);
      this.puts.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
    } else this.answers.set(frame.header.id, { status: frame.header.status, contentType: frame.header.contentType, body: Buffer.from(frame.payload).toString('utf8'), over: 'socket' });
    return true;
  }
  /** Everything the mirror sent the wharf, on the socket or over HTTP, pings aside. */
  sent(): number { return this.puts.length + this.messages.length + this.answers.size + this.http.length; }
  async takeMirrorCall(id: string) { this.http.push(`take ${id}`); }
  async answerMirrorCall(id: string, status: number, contentType: string, body: Uint8Array) {
    this.http.push(`answer ${id}`);
    this.answers.set(id, { status, contentType, body: Buffer.from(body).toString('utf8'), over: 'http' });
  }
  async mirrorFile(id: string) { this.http.push(`file ${id}`); return this.files.get(id)!; }
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

function mirror(wharf: FakeWharf, glass: LocalGlass = loopbackGlass(port), glassPort?: number): WharfMirror {
  return new WharfMirror({ wharf: 'lobstah', backend: wharf, channel: wharf, glass, now: () => now, writeStatus: (_status: MirrorStatus) => {}, ...(glassPort ? { glassPort } : {}) });
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
  it('retries ECONNRESET with a bounded delay and sends the snapshot after recovery', async () => {
    const wharf = new FakeWharf();
    const glass = loopbackGlass(port);
    let failing = true;
    const statuses: MirrorStatus[] = [];
    const m = new WharfMirror({ wharf: 'lobstah', backend: wharf, channel: wharf, now: () => now,
      glass: { ...glass, get: async (path, etag) => {
        if (failing) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
        return glass.get(path, etag);
      } }, writeStatus: status => statuses.push({ ...status }) });
    await m.onWatch(true);
    expect(wharf.puts).toEqual([]);
    expect(statuses.at(-1)?.error).toContain('ECONNRESET');
    for (let attempt = 0; attempt < 8; attempt++) {
      const delay = await m.read();
      expect(delay).toBeGreaterThanOrEqual(MIRROR_WATCHED_READ_MS);
      expect(delay).toBeLessThanOrEqual(MIRROR_IDLE_READ_MS);
      now += delay;
    }
    failing = false;
    expect(await m.read()).toBe(MIRROR_WATCHED_READ_MS);
    expect(wharf.puts).toHaveLength(1);
    expect(statuses.at(-1)?.error).toBeUndefined();
    expect(statuses.at(-1)?.lastPutAt).toBe(new Date(now).toISOString());
  });

  it('keeps a disconnected mirror error visible and raises one attention notice per outage', async () => {
    const wharf = new FakeWharf();
    wharf.open = false;
    const statuses: MirrorStatus[] = [];
    const m = new WharfMirror({ wharf: 'lobstah', backend: wharf, channel: wharf, glass: loopbackGlass(port),
      now: () => now, writeStatus: status => statuses.push({ ...status }) });
    m.onError(new Error('Unexpected server response: 401'));
    await m.read();
    expect(statuses.at(-1)?.error).toContain('401');
    now += MIRROR_STALE_NOTICE_MS - 1;
    await m.read();
    expect(listNotices()).toEqual([]);
    now++;
    await m.read();
    await m.read();
    expect(listNotices().map(notice => notice.kind)).toEqual(['wharf-mirror-stale']);
    wharf.open = true;
    m.onReconnect();
    await m.read();
    expect(statuses.at(-1)?.error).toBeUndefined();
    wharf.open = false;
    now += MIRROR_STALE_NOTICE_MS;
    await m.read();
    expect(listNotices().filter(notice => notice.kind === 'wharf-mirror-stale')).toHaveLength(2);
  });

  it('sends the snapshot the moment a glass opens, within two seconds, then each change while it stays open', async () => {
    const wharf = new FakeWharf();
    const m = mirror(wharf);
    const started = Date.now();
    await m.onWatch(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(wharf.puts).toHaveLength(1);
    // Nothing changed: nothing is sent.
    now += MIRROR_WATCHED_READ_MS;
    expect(await m.read()).toBe(MIRROR_WATCHED_READ_MS);
    expect(wharf.puts).toHaveLength(1);
    // The fleet changes: the next read, one interval later, sends it.
    askDecision({ title: 'Ship the tray?', options: ['Yes', 'No'], askedBy: 'helm', maxBytes: 1_000_000 });
    now += MIRROR_WATCHED_READ_MS;
    await m.read();
    expect(wharf.puts).toHaveLength(2);
    expect((wharf.puts[1]!.decisions as Array<{ key: string; title: string }>).map((d) => d.title)).toEqual(['Ship the tray?']);
    // The glass closes: changes stay on the boat.
    await m.onWatch(false);
    askDecision({ title: 'And the lid?', options: ['Yes', 'No'], askedBy: 'helm', maxBytes: 1_000_000 });
    await m.read();
    expect(wharf.puts).toHaveLength(2);
  });

  it('sends the wharf nothing at all, on the socket or over HTTP, while no glass is open and nothing changes', async () => {
    const wharf = new FakeWharf();
    const m = mirror(wharf);
    // The first read sends the pet's walking list once.
    expect(await m.read()).toBe(MIRROR_IDLE_READ_MS);
    const first = wharf.sent();
    // Ten minutes of reads, every 30 seconds.
    for (let i = 0; i < 20; i++) {
      now += MIRROR_IDLE_READ_MS;
      await m.read();
    }
    expect(wharf.sent()).toBe(first);
    expect(wharf.puts).toEqual([]);
    expect(wharf.http).toEqual([]);
    expect(listNotices()).toEqual([]);
  });

  it('sends the whole snapshot again after the socket reconnects, while a glass is open', async () => {
    const wharf = new FakeWharf();
    const m = mirror(wharf);
    await m.onWatch(true);
    m.onReconnect();
    await m.read();
    expect(wharf.puts).toHaveLength(2);
  });

  it('never sends the page token', async () => {
    const token = ((await (await fetch(`http://127.0.0.1:${port}/data`)).json()) as { focusToken: string }).focusToken;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const wharf = new FakeWharf();
    await mirror(wharf).onWatch(true);
    expect(wharf.puts[0]).not.toHaveProperty('focusToken');
    expect(wharf.rawPuts[0]!.toString('utf8')).not.toContain(token);
  });

  it('names where this glass listens and this mirror’s id, for the probe', async () => {
    const wharf = new FakeWharf();
    await mirror(wharf, loopbackGlass(port), port).onWatch(true);
    expect(wharf.puts[0]!.mirror).toMatchObject({ port, id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });
});

describe('attention lists', () => {
  it('sends its own walking list when it changes, and keeps the other boats’ lists pushed to it', async () => {
    const wharf = new FakeWharf();
    const m = mirror(wharf);
    await m.read();
    expect(wharf.messages.filter((x) => x.t === 'attention')).toHaveLength(1);
    await m.read();
    expect(wharf.messages.filter((x) => x.t === 'attention')).toHaveLength(1);
    m.onAttention([{ boat: 'south', name: 'south', at: new Date(now).toISOString(), etag: 's'.repeat(64), attention: [{ key: 'work:s' }] }]);
    expect(readOtherBoats()).toMatchObject({ wharf: 'lobstah', boats: [{ boat: 'south', attention: [{ key: 'work:s' }] }] });
  });
});

describe('relayed calls', () => {
  it('removes a finished tool permission from both glasses and refuses an already queued late answer', async () => {
    const worktree = path.join(home, 'worktree');
    fs.mkdirSync(worktree);
    const session = 'mirror-waiting-trap';
    const signed = signOnTrap({ sessionId: session, harness: 'claude', repo: 'web', worktree, cwd: worktree, ttlMs: 60_000 });
    if (!('ok' in signed)) throw new Error('could not sign on');
    enqueue({ id: 'mirror-work', repo: 'web', brief: 'Check the release' });
    claimBait(signed.ok);
    const card = askPermission({ dispatch: 'mirror-work', lane: 'work', ask: {
      session, tool: 'Bash', call: { id: 'mirror-call' }, command: 'pnpm exec check-release', harness: 'claude',
    } });
    const wharf = new FakeWharf();
    const m = mirror(wharf);
    await m.onWatch(true);
    expect((wharf.puts.at(-1)!.decisions as Array<{ key: string }>).map(item => item.key)).toContain(card.key);
    // The person's click is pushed after the call ended on the boat.
    settlePermissionCards({ session_id: session, hook_event_name: 'PostToolBatch', tool_calls: [{ tool_use_id: 'mirror-call' }] });
    await m.onCall(call('late-allow', { write: { kind: 'decision-answer', payload: { key: card.key, option: 'Allow once' } } }));
    now += MIRROR_WATCHED_READ_MS;
    await m.read();
    expect(wharf.puts.at(-1)!.decisions).toEqual([]);
    expect(wharf.answers.get('late-allow')?.status).toBe(404);
    const snapshot = await (await fetch(`http://127.0.0.1:${port}/data`)).json() as { focusToken: string; decisions: unknown[] };
    expect(snapshot.decisions).toEqual([]);
    const localAnswer = await fetch(`http://127.0.0.1:${port}/requests`, {
      method: 'POST', headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-Lobstah-Token': snapshot.focusToken },
      body: JSON.stringify({ kind: 'decision-answer', payload: { key: card.key, option: 'Allow once' } }),
    });
    expect(localAnswer.status).toBe(404);
    expect(readDecisionAnswer(card.key)).toBeUndefined();
    expect(listGrants().grants).toEqual([]);
  });

  it('carries out an allowed read and answers on the socket with the local glass’s own status and body, within a second of it', async () => {
    const wharf = new FakeWharf();
    const glass = loopbackGlass(port);
    let answeredAt = 0;
    const timed: LocalGlass = { get: async (p, etag) => { const r = await glass.get(p, etag); answeredAt = Date.now(); return r; }, request: glass.request };
    await mirror(wharf, timed).onCall(call('stats', { read: '/data/stats' }));
    expect(Date.now() - answeredAt).toBeLessThan(1_000);
    const answer = wharf.answers.get('stats')!;
    expect(answer).toMatchObject({ status: 200, over: 'socket' });
    expect(answer.contentType).toMatch(/^application\/json/);
    expect(JSON.parse(answer.body)).toHaveProperty('catchesToday');
    expect(wharf.http).toEqual([]);
  });

  it('answers a call pushed twice once', async () => {
    const wharf = new FakeWharf();
    const glass = recordingGlass();
    const m = mirror(wharf, glass);
    await m.onCall(call('stats', { read: '/data/stats' }));
    await m.onCall(call('stats', { read: '/data/stats' }));
    expect(glass.gets.filter((g) => g === '/data/stats')).toHaveLength(1);
  });

  it('answers over HTTP, taking the call first, when the answer is too large for a frame', async () => {
    const wharf = new FakeWharf();
    const big: LocalGlass = { get: async () => ({ status: 200, contentType: 'text/plain', body: Buffer.alloc(ANSWER_INLINE_MAX_BYTES + 1, 97) }), request: loopbackGlass(port).request };
    await mirror(wharf, big).onCall(call('big', { read: '/data/stats' }));
    expect(wharf.http).toEqual(['take big', 'answer big']);
    expect(wharf.answers.get('big')).toMatchObject({ status: 200, over: 'http' });
  });

  it('refuses a call outside the allowlist without calling the local glass', async () => {
    const wharf = new FakeWharf();
    const glass = recordingGlass();
    const m = mirror(wharf, glass);
    for (const c of [
      call('review-settings', { write: { kind: 'review-mode', payload: { mode: 'auto-review', publish: true } } }),
      call('helm-chat', { write: { kind: 'helm-chat', payload: { grounds: 'fleet', chat: 'brief' } } }),
      call('focus', { write: { kind: 'focus', payload: { trapId: 'x' } } }),
      call('raw', { read: '/api/focus/x' }),
      call('climb', { read: '/data/dispatch/%2e%2e' }),
    ]) await m.onCall(c);
    for (const id of ['review-settings', 'helm-chat', 'focus', 'raw', 'climb']) {
      expect(wharf.answers.get(id)?.status, id).toBe(403);
    }
    expect(glass.requests).toEqual([]);
    expect(glass.gets).toEqual([]);
  });

  it('records a relayed decision answer as by: wharf', async () => {
    const { meta } = askDecision({ title: 'Ship the tray?', options: ['Yes', 'No'], askedBy: 'helm', maxBytes: 1_000_000 });
    const wharf = new FakeWharf();
    await mirror(wharf).onCall(call('answer', { write: { kind: 'decision-answer', payload: { key: meta.key, option: 'Yes' } } }));
    expect(wharf.answers.get('answer')?.status).toBe(201);
    expect(readDecisionAnswer(meta.key)).toMatchObject({ option: 'Yes', by: 'wharf' });
  });

  it('brings the files a person attached on the hosted glass to the local answer', async () => {
    const { meta } = askDecision({ title: 'Which tray?', askedBy: 'helm', maxBytes: 1_000_000 });
    const wharf = new FakeWharf();
    wharf.files.set('file-1', { name: 'tray.txt', bytes: new TextEncoder().encode('the wide one') });
    await mirror(wharf).onCall(call('answer', { write: { kind: 'decision-answer', payload: { key: meta.key, text: 'see the file' } } }, ['file-1']));
    expect(wharf.answers.get('answer')?.status).toBe(201);
    const answer = readDecisionAnswer(meta.key)!;
    expect(answer.attachments.map((a) => a.name)).toEqual(['tray.txt']);
    expect(fs.readFileSync(answer.attachments[0]!.path, 'utf8')).toBe('the wide one');
  });

  it('lets a person allow a permission card from the hosted glass, as from the local one', async () => {
    const card = askPermission({ dispatch: 'job-1', lane: 'work', ask: { command: 'npm publish --dry-run', harness: 'claude' } });
    const wharf = new FakeWharf();
    await mirror(wharf).onCall(call('allow', { write: { kind: 'decision-answer', payload: { key: card.key, option: 'Allow once' } } }));
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

  it("asks for attention beside mirror, so this Mac's pet walks every boat, and refuses it alone", async () => {
    const asked: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/v1/auth/device/code')) return Response.json({ device_code: 'device', user_code: 'ABCD-EFGH', verification_uri: 'https://glass.lobstah.test/device', expires_in: 600, interval: 1 });
      if (url.endsWith('/v1/auth/device/token')) return Response.json({ token: BOAT_TOKEN, id: 'boat-1', name: 'studio', permissions: ['mirror', 'attention', 'read'] });
      throw new Error(`unexpected request ${url}`);
    }));
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    const { wharfCommand } = await import('../src/wharf-commands.js');
    expect(await wharfCommand('wharf', ['login'], options({ '--wharf': 'lobstah', '--mirror': true, '--attention': true, '--name': 'studio' }), loadConfig())).toBe(true);
    expect(asked[0]!.body).toMatchObject({ steering: 'read', mirror: true, attention: true });
    expect(lines.join('\n')).toContain('Approve boat studio (mirror + attention + read)');
    await expect(wharfCommand('wharf', ['login'], options({ '--wharf': 'lobstah', '--attention': true }), loadConfig())).rejects.toThrow(/--mirror/);
  });

  it('without --wharf, acts on the one wharf the mirror is logged in to', async () => {
    fs.mkdirSync(path.join(home, 'credentials'), { recursive: true });
    fs.writeFileSync(path.join(home, 'credentials', 'wharf-lobstah.json'), JSON.stringify({ url: 'https://api.lobstah.test', account: 'acct', token: BOAT_TOKEN }));
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      if (String(input).endsWith('/v1/accounts/acct/_boat')) return Response.json({ id: 'boat-1', name: 'studio', permissions: ['mirror', 'read'] });
      throw new Error(`unexpected request ${String(input)}`);
    }));
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    const { wharfCommand } = await import('../src/wharf-commands.js');
    expect(await wharfCommand('wharf', ['whoami'], options({}), loadConfig())).toBe(true);
    expect(lines.join('\n')).toMatch(/wharf: lobstah/);
    expect(lines.join('\n')).toMatch(/boat: studio/);
  });

  it('without --wharf, says to add it and names the wharves when it is logged in to none or several', async () => {
    const { wharfCommand } = await import('../src/wharf-commands.js');
    await expect(wharfCommand('wharf', ['whoami'], options({}), loadConfig())).rejects.toThrow('add --wharf <name>: this boat is logged in to none of lobstah');
    fs.writeFileSync(path.join(home, 'config.toml'), '[wharves.lobstah]\nurl = "https://api.lobstah.test"\naccount = "acct"\ntokenEnv = "LOBSTAH_TEST_WHARF"\n\n[wharves.staging]\nurl = "https://api.staging.test"\naccount = "acct2"\ntokenEnv = "LOBSTAH_TEST_WHARF_2"\n');
    fs.mkdirSync(path.join(home, 'credentials'), { recursive: true });
    fs.writeFileSync(path.join(home, 'credentials', 'wharf-lobstah.json'), JSON.stringify({ url: 'https://api.lobstah.test', account: 'acct', token: BOAT_TOKEN }));
    fs.writeFileSync(path.join(home, 'credentials', 'wharf-staging.json'), JSON.stringify({ url: 'https://api.staging.test', account: 'acct2', token: 'b.acct2.boat-2.abcdefghijklmnopqrstuvwxyz012345' }));
    await expect(wharfCommand('wharf', ['whoami'], options({}), loadConfig())).rejects.toThrow('add --wharf <name>: this boat is logged in to lobstah, staging');
  });

  it('refuses --wharf login without --mirror, since it has no grounds to work in', async () => {
    const { wharfCommand } = await import('../src/wharf-commands.js');
    await expect(wharfCommand('wharf', ['login'], options({ '--wharf': 'lobstah' }), loadConfig())).rejects.toThrow(/--mirror/);
  });
});

describe('the doctor’s wharf mirror row', () => {
  it('warns with the login command, then says whether the mirror is running and connected', async () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[wharves.lobstah]\nurl = "https://api.lobstah.test"\naccount = "acct"\ntokenEnv = "LOBSTAH_TEST_WHARF"\n\n[glass]\nmirror = "lobstah"\n');
    const { mirrorRow } = await import('../src/doctor.js');
    const { writeMirrorStatus } = await import('@lobstah/core');
    expect(mirrorRow(loadConfig(), now)).toMatchObject({ check: 'wharf mirror', status: 'warn', detail: expect.stringContaining('lobstah wharf login --wharf lobstah --mirror') });
    process.env.LOBSTAH_TEST_WHARF = 'b.acct.boat-1.abcdefghijklmnopqrstuvwxyz012345';
    try {
      expect(mirrorRow(loadConfig(), now)).toMatchObject({ status: 'warn', detail: expect.stringContaining('has not run yet') });
      // Unwatched, a mirror puts nothing for hours and is still fine: it reads and stays connected.
      writeMirrorStatus({ wharf: 'lobstah', lastPutAt: new Date(now - 6 * 3600_000).toISOString(), connected: true, calls: 2, at: new Date(now).toISOString() });
      expect(mirrorRow(loadConfig(), now)).toMatchObject({ status: 'ok', detail: expect.stringContaining('2 calls carried out') });
      expect(mirrorRow(loadConfig(), now + 10 * 60_000)).toMatchObject({ status: 'warn', detail: expect.stringContaining('longer ago') });
      writeMirrorStatus({ wharf: 'lobstah', connected: false, calls: 0, at: new Date(now).toISOString() });
      expect(mirrorRow(loadConfig(), now)).toMatchObject({ status: 'warn', detail: expect.stringContaining('not connected') });
    } finally { delete process.env.LOBSTAH_TEST_WHARF; }
  });

  it('is absent without [glass] mirror', async () => {
    const { mirrorRow } = await import('../src/doctor.js');
    expect(mirrorRow(loadConfig(), now)).toBeUndefined();
  });
});

describe('the local glass’s focus probe for the hosted glass', () => {
  const HOSTED = 'https://glass.lobstah.test';
  let focused: string[];
  let probeServer: Server | undefined;
  let probeBase: string;
  beforeEach(async () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[wharves.lobstah]\nurl = "https://api.lobstah.test"\naccount = "acct"\ntokenEnv = "LOBSTAH_TEST_WHARF"\n\n[glass]\nmirror = "lobstah"\n');
    const { writeMirrorStatus } = await import('@lobstah/core');
    writeMirrorStatus({ wharf: 'lobstah', id: 'mirror-1', glass: HOSTED, calls: 0, at: new Date(now).toISOString() });
    focused = [];
    probeServer = serveGlass(0, { focus: async (reg) => { focused.push(reg.trapId); return { focused: true } as never; } });
    await new Promise<void>((resolve) => probeServer!.once('listening', resolve));
    probeBase = `http://127.0.0.1:${(probeServer.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    if (probeServer) await new Promise<void>((resolve) => probeServer!.close(() => resolve()));
  });

  it('answers the hosted glass’s origin with this mirror’s id and a focus token, across the private network', async () => {
    const preflight = await fetch(`${probeBase}/api/mirror/probe`, { method: 'OPTIONS', headers: { Origin: HOSTED, 'Access-Control-Request-Private-Network': 'true' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(HOSTED);
    expect(preflight.headers.get('access-control-allow-private-network')).toBe('true');
    const probe = await fetch(`${probeBase}/api/mirror/probe`, { headers: { Origin: HOSTED } });
    expect(probe.status).toBe(200);
    const answer = (await probe.json()) as { mirror: string; token: string };
    expect(answer.mirror).toBe('mirror-1');
    expect(answer.token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses any other origin', async () => {
    for (const origin of ['https://elsewhere.test', probeBase]) {
      expect((await fetch(`${probeBase}/api/mirror/probe`, { headers: { Origin: origin } })).status, origin).toBe(403);
    }
    expect((await fetch(`${probeBase}/api/mirror/probe`)).status).toBe(403);
  });

  it('raises a window with its token and opens nothing else with it', async () => {
    const { token } = (await (await fetch(`${probeBase}/api/mirror/probe`, { headers: { Origin: HOSTED } })).json()) as { token: string };
    // Past the token: the trap is not live here, so focus says so.
    const focus = await fetch(`${probeBase}/api/mirror/focus/no-such-trap`, { method: 'POST', headers: { Origin: HOSTED, 'x-lobstah-focus-token': token } });
    expect(focus.status).toBe(409);
    expect((await fetch(`${probeBase}/api/mirror/focus/no-such-trap`, { method: 'POST', headers: { Origin: HOSTED, 'x-lobstah-focus-token': 'f'.repeat(64) } })).status).toBe(403);
    // The token is not this page's write token, and the hosted origin is not this page's origin.
    const write = await fetch(`${probeBase}/requests`, { method: 'POST', headers: { Origin: HOSTED, 'content-type': 'application/json', 'x-lobstah-token': token }, body: JSON.stringify({ kind: 'grant-revoke', payload: { id: 'g-1' } }) });
    expect(write.status).toBe(403);
    expect((await fetch(`${probeBase}/api/focus/no-such-trap`, { method: 'POST', headers: { Origin: HOSTED, 'x-lobstah-focus-token': token } })).status).toBe(403);
    expect(focused).toEqual([]);
  });

  it('answers nothing without [glass] mirror', async () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '');
    expect((await fetch(`${probeBase}/api/mirror/probe`, { headers: { Origin: HOSTED } })).status).toBe(403);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendStatus, claimNext, enqueue, ensureLayout, loadConfig, writeMirrorStatus } from '@lobstah/core';
import type { ClientSocketMessage, MirrorStatus, WharfAttentionList, WharfMirrorCall } from '@lobstah/core';
import { serveGlass } from '../src/glass.js';
import { WharfMirror, loopbackGlass } from '../src/wharf-mirror.js';
import type { MirrorChannel, MirrorWharf } from '../src/wharf-mirror.js';
import { otherBoatsAttention, otherBoatsPath, readOtherBoats, writeOtherBoats } from '../src/wharf-attention.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * Every boat's items on this Mac's pet: the mirror sends this boat's walking
 * list on its socket when it changes and keeps the other boats' lists the
 * wharf pushes to it, `attention --json` walks them with their boat's name,
 * and an ack of one goes through the wharf to the boat that owns it.
 */

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;
let server: Server | undefined;
let wharfServer: Server | undefined;
let port: number;
let now: number;

/** A wharf and its socket: the lists the mirror sends, and the calls it answers. */
class FakeWharf implements MirrorWharf, MirrorChannel {
  attentionSends: unknown[][] = [];
  answered: string[] = [];
  /** Whether the socket is open: a closed one sends nothing. */
  open = true;
  connected() { return this.open; }
  send(message: ClientSocketMessage) {
    if (!this.open) return false;
    if (message.t === 'attention') this.attentionSends.push(message.attention);
    return true;
  }
  sendFrame() { return this.open; }
  async takeMirrorCall() {}
  async answerMirrorCall(id: string) { this.answered.push(id); }
  async mirrorFile() { return { name: 'x', bytes: new Uint8Array() }; }
}
const mirror = (wharf: FakeWharf) =>
  new WharfMirror({ wharf: 'lobstah', backend: wharf, channel: wharf, glass: loopbackGlass(port), now: () => now, writeStatus: (_s: MirrorStatus) => {} });

const Q = '11111111-1111-1111-1111-111111111111';
function question(note: string): void {
  enqueue({ id: Q, repo: 'web', brief: 'b' }, 'work');
  claimNext('work');
  appendStatus(Q, 'work', 'needs-decision', note);
}
const item = (key: string, extra: Record<string, unknown> = {}) =>
  ({ key, kind: 'question', stateHash: `${key}-1`, id: key, lane: 'work', verb: 'needs-decision', note: 'Which port?', at: '2026-11-09T11:00:00.000Z', ...extra });
const list = (boat: string, name: string, attention: unknown[], etag = `${boat}-1`): WharfAttentionList => ({ boat, name, at: '2026-11-09T11:30:00.000Z', etag, attention });

const MIRRORED = `[glass]\nmirror = "lobstah"\n[wharves.lobstah]\nurl = "http://127.0.0.1:1"\naccount = "acct"\ntokenEnv = "TEST_WHARF_TOKEN"\n`;
const lobstah = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, LOBSTAH_HOME: home, TEST_WHARF_TOKEN: 'b.acct.boat-me.secret' }, timeout: 10_000 });
const walking = () => (JSON.parse(lobstah('attention', '--json').stdout) as { attention: Array<Record<string, unknown>> }).attention;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-wharf-attention-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), 'attentionKinds = ["question", "pr:draft"]\n');
  server = serveGlass(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
  now = Date.parse('2026-11-09T12:00:00.000Z');
});
afterEach(async () => {
  for (const s of [server, wharfServer]) if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  server = wharfServer = undefined;
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

describe("the mirror sends this boat's list", () => {
  it('without ages, and again only when an item changes', async () => {
    question('Which port?');
    const wharf = new FakeWharf();
    const m = mirror(wharf);
    await m.read();
    await m.read();
    expect(wharf.attentionSends).toHaveLength(1);
    expect(wharf.attentionSends[0]).toEqual([expect.objectContaining({ key: `work:${Q}`, kind: 'question', note: 'Which port?' })]);
    expect(wharf.attentionSends[0]![0]).not.toHaveProperty('ageSecs');
    appendStatus(Q, 'work', 'needs-decision', 'Which port, 80 or 443?');
    await m.read();
    expect(wharf.attentionSends).toHaveLength(2);
  });

  it('sends it once the socket is back, and again after a reconnect', async () => {
    question('Which port?');
    const wharf = Object.assign(new FakeWharf(), { open: false });
    const m = mirror(wharf);
    await m.read();
    expect(wharf.attentionSends).toHaveLength(0);
    wharf.open = true;
    await m.read();
    expect(wharf.attentionSends).toHaveLength(1);
    // A reconnect may have lost what the wharf held: the next read sends it again.
    m.onReconnect();
    await m.read();
    expect(wharf.attentionSends).toHaveLength(2);
  });
});

describe('a list that cannot go out', () => {
  it('never holds a relayed call', async () => {
    question('Which port?');
    const wharf = Object.assign(new FakeWharf(), { open: false });
    const m = mirror(wharf);
    await m.read();
    await m.onCall({ id: 'call-1', boat: 'me', read: '/data/stats', at: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString(), state: 'queued', by: 'person' } as WharfMirrorCall);
    // With the socket down the answer goes over HTTP.
    expect(wharf.answered).toEqual(['call-1']);
  });
});

describe("the other boats' lists", () => {
  it('are kept as the wharf pushes them, each push replacing the last', () => {
    const wharf = new FakeWharf();
    const m = mirror(wharf);
    m.onAttention([list('boat-n', 'north', [item('work:n')])]);
    expect(readOtherBoats()?.boats).toEqual([expect.objectContaining({ boat: 'boat-n', name: 'north', attention: [item('work:n')] })]);
    m.onAttention([list('boat-n', 'north', [], 'boat-n-2')]);
    expect(readOtherBoats()?.boats[0]?.attention).toEqual([]);
  });
});

describe('the pet walks every boat', () => {
  const cache = (boats: WharfAttentionList[]) =>
    writeOtherBoats({ wharf: 'lobstah', at: new Date().toISOString(), boats: boats.map((b) => ({ ...b, attention: b.attention ?? [] })) });

  it("lists another boat's question with its boat's name, keyed by that boat, opening on the hosted glass", () => {
    fs.appendFileSync(path.join(home, 'config.toml'), MIRRORED);
    writeMirrorStatus({ wharf: 'lobstah', calls: 0, at: new Date().toISOString(), glass: 'https://glass.test' });
    question('Mine?');
    cache([list('boat-n', 'north', [item('work:n')])]);
    const items = walking();
    expect(items.map((a) => a.key)).toEqual([`work:${Q}`, '@boat-n/work:n']);
    expect(items[1]).toMatchObject({ kind: 'question', note: '[north] Which port?', stateHash: 'work:n-1', boat: { id: 'boat-n', name: 'north' },
      glass: `https://glass.test/#decision/${encodeURIComponent('work:n')}` });
  });

  it('walks a PR that several boats watch once', () => {
    fs.appendFileSync(path.join(home, 'config.toml'), MIRRORED);
    const pr = (extra = {}) => item('pr:acme/web#9', { kind: 'pr:draft', verb: 'pr:draft', prUrl: 'https://github.com/acme/web/pull/9', ...extra });
    cache([list('boat-n', 'north', [pr()]), list('boat-s', 'south', [pr(), item('work:s')])]);
    expect(walking().map((a) => a.key)).toEqual(['@boat-n/pr:acme/web#9', '@boat-s/work:s']);
  });

  it('walks an item of a wharf grounds once: from this boat when it views that grounds, else from the boat that does', () => {
    fs.appendFileSync(path.join(home, 'config.toml'), MIRRORED);
    const hosted = (key: string, grounds: string) => item(key, { grounds, wharf: 'lobstah', note: `[${grounds}@lobstah] Which base?` });
    cache([list('boat-n', 'north', [hosted('work:srv-viewed', 'shared'), hosted('work:srv-other', 'theirs')])]);
    // This boat's own view of the shared grounds already walks its items (hostedAttention).
    const mine = [{ key: `work:srv-${'a'.repeat(40)}`, grounds: 'shared', wharf: 'lobstah' }];
    const others = otherBoatsAttention(loadConfig(), mine);
    expect(others.map((a) => a.key)).toEqual(['@boat-n/work:srv-other']);
    expect(otherBoatsAttention(loadConfig(), []).map((a) => a.key)).toEqual(['@boat-n/work:srv-viewed', '@boat-n/work:srv-other']);
  });

  it('walks no other boat on a Mac that mirrors to no wharf', () => {
    question('Mine?');
    cache([list('boat-n', 'north', [item('work:n')])]);
    expect(walking().map((a) => a.key)).toEqual([`work:${Q}`]);
  });

  it("acks another boat's item on that boat, through the wharf, and stops walking it here at once", async () => {
    const asked: Array<{ path: string; auth?: string; body: unknown }> = [];
    wharfServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        asked.push({ path: req.url ?? '', auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'call-1', boat: 'boat-n' }));
      });
    });
    await new Promise<void>((resolve) => wharfServer!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(wharfServer.address() as AddressInfo).port}`;
    fs.appendFileSync(path.join(home, 'config.toml'), MIRRORED.replace('http://127.0.0.1:1', url));
    cache([list('boat-n', 'north', [item('work:n')])]);
    // The pet's ack runs in the background (spawnSync would hold the event loop this fake wharf answers on).
    const result = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [cli, 'attention', 'ack', '@boat-n/work:n', '--by', 'pet'],
        { env: { ...process.env, LOBSTAH_HOME: home, TEST_WHARF_TOKEN: 'b.acct.boat-me.secret' } });
      let stderr = '';
      child.stderr.on('data', (c: Buffer) => (stderr += c));
      child.on('exit', (status: number | null) => resolve({ status, stderr }));
    });
    expect(result.status, result.stderr).toBe(0);
    expect(asked).toEqual([{ path: '/v1/accounts/acct/mirror/attention/acks', auth: 'Bearer b.acct.boat-me.secret', body: { boat: 'boat-n', key: 'work:n', stateHash: 'work:n-1' } }]);
    expect(walking().find((a) => a.key === '@boat-n/work:n')?.acked).toMatchObject({ by: 'pet' });
    expect(lobstah('attention', 'unack', '@boat-n/work:n').status).not.toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BackendError, appendStatus, claimNext, enqueue, ensureLayout, writeMirrorStatus } from '@lobstah/core';
import type { MirrorStatus, WharfAttentionList, WharfMirrorCall } from '@lobstah/core';
import { serveGlass } from '../src/glass.js';
import { MIRROR_ATTENTION_OFF_MS, MIRROR_ATTENTION_READ_MS, WharfMirror, loopbackGlass } from '../src/wharf-mirror.js';
import type { MirrorWharf } from '../src/wharf-mirror.js';
import { otherBoatsPath, readOtherBoats, writeOtherBoats } from '../src/wharf-attention.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * Every boat's items on this Mac's pet: the mirror puts this boat's walking
 * list when it changes and reads the other boats' lists on a hint (or every
 * five minutes), `attention --json` walks them with their boat's name, and
 * an ack of one goes through the wharf to the boat that owns it.
 */

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;
let server: Server | undefined;
let wharfServer: Server | undefined;
let port: number;
let now: number;

/** A wharf that records the lists the mirror puts and answers its reads from `others`. */
class FakeWharf implements MirrorWharf {
  attentionPuts: unknown[][] = [];
  reads: Array<Record<string, string>> = [];
  others: WharfAttentionList[] = [];
  refuse?: number;
  refusePut?: number;
  queued: WharfMirrorCall[] = [];
  answered: string[] = [];
  async putMirrorSnapshot(gzip: Uint8Array) { return { etag: 'e'.repeat(64), bytes: gzip.byteLength, at: new Date(now).toISOString() }; }
  async mirrorCalls(): Promise<{ calls: WharfMirrorCall[] }> { const calls = this.queued; this.queued = []; return { calls }; }
  async takeMirrorCall() {}
  async answerMirrorCall(id: string) { this.answered.push(id); }
  async mirrorFile() { return { name: 'x', bytes: new Uint8Array() }; }
  async putMirrorAttention(attention: unknown[]) {
    if (this.refusePut) throw new BackendError(this.refusePut, 'route not found');
    this.attentionPuts.push(attention);
    return { etag: 'a'.repeat(64), at: new Date(now).toISOString(), changed: true };
  }
  async mirrorAttention(known: Record<string, string> = {}) {
    if (this.refuse) throw new BackendError(this.refuse, 'attention permission required');
    this.reads.push(known);
    return this.others.map((b) => (known[b.boat] === b.etag ? { boat: b.boat, name: b.name, at: b.at, etag: b.etag, unchanged: true as const } : b));
  }
}
const mirror = (wharf: FakeWharf) =>
  new WharfMirror({ wharf: 'lobstah', backend: wharf, glass: loopbackGlass(port), now: () => now, writeStatus: (_s: MirrorStatus) => {} });

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

describe("the mirror puts this boat's list", () => {
  it('without ages, and again only when an item changes', async () => {
    question('Which port?');
    const wharf = new FakeWharf();
    const m = mirror(wharf);
    await m.pass();
    await m.pass();
    expect(wharf.attentionPuts).toHaveLength(1);
    expect(wharf.attentionPuts[0]).toEqual([expect.objectContaining({ key: `work:${Q}`, kind: 'question', note: 'Which port?' })]);
    expect(wharf.attentionPuts[0]![0]).not.toHaveProperty('ageSecs');
    appendStatus(Q, 'work', 'needs-decision', 'Which port, 80 or 443?');
    await m.pass();
    expect(wharf.attentionPuts).toHaveLength(2);
  });

  it('waits half an hour before putting again on a wharf without the route', async () => {
    question('Which port?');
    const wharf = Object.assign(new FakeWharf(), { refusePut: 404 });
    const m = mirror(wharf);
    await m.pass();
    wharf.refusePut = undefined;
    await m.pass();
    expect(wharf.attentionPuts).toHaveLength(0);
    now += MIRROR_ATTENTION_OFF_MS;
    await m.pass();
    expect(wharf.attentionPuts).toHaveLength(1);
  });
});

describe('a failing list', () => {
  it('never holds a relayed call', async () => {
    question('Which port?');
    const wharf = Object.assign(new FakeWharf(), { refusePut: 500, refuse: 500 });
    wharf.queued = [{ id: 'call-1', boat: 'me', read: '/data/stats', at: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString(), state: 'queued', by: 'person' } as WharfMirrorCall];
    await mirror(wharf).pass({ attention: true });
    expect(wharf.answered).toEqual(['call-1']);
  });
});

describe("the mirror reads the other boats' lists", () => {
  it('at once, then on a hint or every five minutes, keeping the lists it already holds', async () => {
    const wharf = new FakeWharf();
    wharf.others = [list('boat-n', 'north', [item('work:n')])];
    const m = mirror(wharf);
    await m.pass();
    expect(readOtherBoats()?.boats).toEqual([expect.objectContaining({ boat: 'boat-n', name: 'north', attention: [item('work:n')] })]);
    await m.pass();
    expect(wharf.reads).toHaveLength(1);
    await m.pass({ attention: true });
    expect(wharf.reads[1]).toEqual({ 'boat-n': 'boat-n-1' });
    expect(readOtherBoats()?.boats[0]?.attention).toEqual([item('work:n')]);
    now += MIRROR_ATTENTION_READ_MS;
    wharf.others = [list('boat-n', 'north', [], 'boat-n-2')];
    await m.pass();
    expect(readOtherBoats()?.boats[0]?.attention).toEqual([]);
  });

  it.each([403, 404])('removes the lists and waits half an hour when the wharf answers %i', async (status) => {
    writeOtherBoats({ wharf: 'lobstah', at: new Date(now).toISOString(), boats: [{ ...list('boat-n', 'north', [item('work:n')]), attention: [item('work:n')] }] });
    const wharf = Object.assign(new FakeWharf(), { refuse: status });
    const m = mirror(wharf);
    await m.pass({ attention: true });
    expect(fs.existsSync(otherBoatsPath())).toBe(false);
    wharf.refuse = undefined;
    await m.pass({ attention: true });
    expect(wharf.reads).toHaveLength(0);
    now += MIRROR_ATTENTION_OFF_MS;
    await m.pass();
    expect(wharf.reads).toHaveLength(1);
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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeFrame, ensureLayout, listNotices, listThreads, loadConfig, noteThread, resolveGrounds, resolveThread, takeHelm, threadSummaries, triageThread } from '@lobstah/core';
import type { ClientSocketMessage, MirrorStatus, WharfMirrorCall } from '@lobstah/core';
import { serveGlass } from '../src/glass.js';
import { WharfMirror, loopbackGlass } from '../src/wharf-mirror.js';
import type { MirrorChannel, MirrorWharf } from '../src/wharf-mirror.js';
import { localGrounds, slackThreadSynced, slackThreadsToSync } from '../src/slack-threads.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * A Slack message for this boat's own helm: the wharf relays it as a
 * `helm-request` call, the local glass opens a helm thread for it, and the
 * mirror tells the wharf where it stands and sends the helm's responses.
 */

let home: string;
let server: Server | undefined;
let port: number;

/** A wharf and its socket: the answers and messages the mirror sends, and its request updates. */
class FakeWharf implements MirrorWharf, MirrorChannel {
  messages: ClientSocketMessage[] = [];
  answers = new Map<string, { status: number; body: Record<string, unknown> }>();
  updates: Array<{ id: string; update: unknown }> = [];
  open = true;
  connected() { return this.open; }
  send(message: ClientSocketMessage) { if (!this.open) return false; this.messages.push(message); return true; }
  sendFrame(bytes: Uint8Array) {
    const frame = decodeFrame(bytes)!;
    if (frame.header.t === 'answer') this.answers.set(frame.header.id, { status: frame.header.status, body: JSON.parse(Buffer.from(frame.payload).toString('utf8')) });
    return true;
  }
  async takeMirrorCall() {}
  async answerMirrorCall() {}
  async mirrorFile(): Promise<{ name: string; bytes: Uint8Array }> { throw new Error('no files'); }
  async updateMirrorRequest(id: string, update: unknown) { this.updates.push({ id, update }); }
}
function mirror(wharf: FakeWharf): WharfMirror {
  return new WharfMirror({ wharf: 'lobstah', backend: wharf, channel: wharf, glass: loopbackGlass(port), writeStatus: (_s: MirrorStatus) => {},
    slackThreads: { grounds: () => localGrounds(loadConfig()), pending: () => slackThreadsToSync(loadConfig(), 'lobstah'), synced: slackThreadSynced } });
}
const REQUEST = 'slack-D1-1700000000-000100';
const relay = (id: string, payload: Record<string, unknown>): WharfMirrorCall =>
  ({ id, boat: 'boat-1', write: { kind: 'helm-request', payload }, at: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), state: 'queued', by: 'wharf' }) as WharfMirrorCall;
const slackRequest = (extra: Record<string, unknown> = {}) => ({ request: REQUEST, grounds: 'home', text: 'Investigate the flaky checkout', by: 'person-1', at: '2026-11-19T12:00:00.000Z', ...extra });
const followUp = (text: string, source: string) => slackRequest({ followUp: { text, at: '2026-11-19T12:05:00.000Z', source } });
const signOnHelm = () => takeHelm({ sessionId: 'helm-session', grounds: resolveGrounds(loadConfig(), 'home'), ttlMs: loadConfig().helm.ttlSecs * 1000 });
const threads = () => listThreads('home');
const replies = (wharf: FakeWharf) => wharf.updates.flatMap((u) => ('reply' in (u.update as object) ? [(u.update as { reply: string }).reply] : []));

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-slack-threads-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[wharves.lobstah]\nurl = "https://api.lobstah.test"\naccount = "acct"\ntokenEnv = "LOBSTAH_TEST_WHARF"\n\n[glass]\nmirror = "lobstah"\n');
  server = serveGlass(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

describe('a Slack message relayed to this boat', () => {
  it('opens a helm thread that waits for the helm, wakes it, and tells the wharf when a helm signs on', async () => {
    const wharf = new FakeWharf(), m = mirror(wharf);
    await m.onCall(relay('c1', slackRequest()));
    const [item] = threads();
    expect(wharf.answers.get('c1')).toEqual({ status: 201, body: { ok: true, thread: item!.id, state: 'queued' } });
    expect(item).toMatchObject({ grounds: 'home', kind: 'untriaged', state: 'open', title: 'Investigate the flaky checkout',
      relay: { wharf: 'lobstah', request: REQUEST, by: 'person-1', told: 'queued' } });
    expect(item!.rounds[0]!.entries).toEqual([{ by: 'person', via: 'slack', text: 'Investigate the flaky checkout', attachments: [], at: expect.any(String) }]);
    // It shows on the Threads page like any other conversation, waiting for the helm.
    expect(threadSummaries('home')).toMatchObject([{ id: item!.id, waitingForHelm: true }]);
    expect(listNotices().find((n) => n.kind === 'thread')).toMatchObject({ refId: item!.id, grounds: 'home' });

    await m.read();
    expect(wharf.updates).toEqual([]);
    signOnHelm();
    await m.read();
    expect(wharf.updates).toEqual([{ id: REQUEST, update: { state: 'delivered' } }]);
    await m.read();
    expect(wharf.updates).toHaveLength(1);
  });

  it('goes straight to the helm that holds its grounds', async () => {
    signOnHelm();
    const wharf = new FakeWharf();
    await mirror(wharf).onCall(relay('c1', slackRequest()));
    expect(wharf.answers.get('c1')?.body.state).toBe('delivered');
  });

  it('sends each helm response back to the Slack thread once', async () => {
    signOnHelm();
    const wharf = new FakeWharf(), m = mirror(wharf);
    await m.onCall(relay('c1', slackRequest()));
    const id = threads()[0]!.id;
    triageThread(id, 'thread');
    await m.read();
    noteThread(id, { decided: ['Retry the payment call'], open: ['Which region fails?'] });
    await m.read();
    resolveThread(id, 'answered', 'Fixed on main.');
    await m.read();
    await m.read();
    expect(wharf.updates.map((u) => u.id)).toEqual([REQUEST, REQUEST, REQUEST]);
    expect(replies(wharf)).toEqual(['Discussion started', 'Decided\n• Retry the payment call\n\nStill open\n• Which region fails?', 'Fixed on main.']);
    // A resolved conversation never counts as unread in the glass.
    expect(threadSummaries('home')[0]).toMatchObject({ waitingForHelm: false, unreadResponse: false });
  });

  it('says where a dispatched thread went', async () => {
    const wharf = new FakeWharf(), m = mirror(wharf);
    await m.onCall(relay('c1', slackRequest()));
    resolveThread(threads()[0]!.id, 'dispatched:d-1', 'On it.');
    await m.read();
    expect(replies(wharf)).toEqual(['On it.\nDispatched as d-1.']);
  });

  it('is one thread however often it is relayed, and what the person adds joins it once', async () => {
    const wharf = new FakeWharf(), m = mirror(wharf);
    await m.onCall(relay('c1', slackRequest()));
    await m.onCall(relay('c2', slackRequest()));
    await m.onCall(relay('c3', followUp('On main', '1700000000.000200')));
    await m.onCall(relay('c4', followUp('On main', '1700000000.000200')));
    const [item, ...others] = threads();
    expect(others).toEqual([]);
    expect(wharf.answers.get('c4')?.body).toMatchObject({ ok: true, thread: item!.id });
    expect(item!.rounds.map((r) => r.entries.map((e) => ('text' in e ? e.text : '')))).toEqual([['Investigate the flaky checkout'], ['On main']]);
    expect(item!.relay?.sources).toEqual(['1700000000.000200']);
  });

  it('reopens a resolved thread when the person adds to it, and waits for the helm again', async () => {
    signOnHelm();
    const wharf = new FakeWharf(), m = mirror(wharf);
    await m.onCall(relay('c1', slackRequest()));
    const id = threads()[0]!.id;
    resolveThread(id, 'answered', 'Fixed on main.');
    await m.read();
    await m.onCall(relay('c2', followUp('Still failing on the release branch', '1700000000.000300')));
    expect(wharf.answers.get('c2')).toEqual({ status: 201, body: { ok: true, thread: id, state: 'delivered' } });
    const [item] = threads();
    expect(item).toMatchObject({ id, state: 'open' });
    expect(item!.outcome).toBeUndefined();
    expect(item!.rounds.at(-1)!.entries).toEqual([{ by: 'person', via: 'slack', text: 'Still failing on the release branch', attachments: [], at: expect.any(String) }]);
    expect(threadSummaries('home')[0]).toMatchObject({ id, waitingForHelm: true });
    // Reopening is no helm response: nothing more goes back until the helm answers.
    await m.read();
    expect(replies(wharf)).toEqual(['Fixed on main.']);
  });

  it('refuses a grounds this boat does not run locally', async () => {
    const wharf = new FakeWharf();
    await mirror(wharf).onCall(relay('c1', slackRequest({ grounds: 'away' })));
    expect(wharf.answers.get('c1')).toMatchObject({ status: 404, body: { ok: false } });
    expect(threads()).toEqual([]);
  });

  it('is never taken from this glass’s own page, only from the mirror’s relay', async () => {
    const token = JSON.parse((await loopbackGlass(port).get('/data')).body.toString('utf8')).focusToken as string;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/requests', headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-Lobstah-Token': token } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end(JSON.stringify({ kind: 'helm-request', payload: slackRequest() }));
    });
    expect(status).toBe(403);
    expect(threads()).toEqual([]);
  });
});

describe('the local grounds the mirror reports', () => {
  it('sends them once per socket, again after a reconnect, and leaves out grounds hosted on a wharf', async () => {
    fs.appendFileSync(path.join(home, 'config.toml'), '\n[repos.app]\npath = "/tmp/app"\n\n[grounds.home]\nrepos = []\n\n[grounds.away]\nrepos = ["app"]\nwharf = "lobstah"\n');
    expect(localGrounds(loadConfig())).toEqual(['home']);
    const wharf = new FakeWharf(), m = mirror(wharf);
    await m.read();
    await m.read();
    expect(wharf.messages.filter((x) => x.t === 'grounds')).toEqual([{ t: 'grounds', grounds: ['home'] }]);
    m.onReconnect();
    expect(wharf.messages.filter((x) => x.t === 'grounds')).toHaveLength(2);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { askDecision, ensureLayout, prepareRunCard } from '@lobstah/core';
import { serveGlass } from '../src/glass.js';
import { RunChallenges, addRunPasskey } from '../src/run-passkey.js';
import { RUN_WINDOW_MS, RunWindows } from '../src/run-window.js';
import { RunRegistry } from '../src/run-exec.js';
import { SoftPasskey } from './fixtures/soft-passkey.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * Run from the hosted glass (ume 2ec9c88b-193, intent hosted-run): a relayed
 * Run needs a phone's passkey, checked against the origin and relying party
 * it was paired for, or that page's 15-minute window key. The Mac's own
 * passkey never confirms a relayed Run, and a phone's never a local one.
 */

const GLASS = 'https://glass.test';

let home: string;
let server: Server | undefined;
let port: number;
let clock: number;
let runs: RunRegistry;
let passkeysFile: string;
let hostedFile: string;
let phone: SoftPasskey;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-run-hosted-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  clock = Date.now();
  runs = new RunRegistry();
  passkeysFile = path.join(home, 'run', 'passkeys.json');
  hostedFile = path.join(home, 'run', 'hosted-passkeys.json');
  phone = new SoftPasskey('glass.test');
  addRunPasskey({ credentialId: phone.credentialId.toString('base64url'), publicKey: phone.spki.toString('base64url'), alg: -7, createdAt: new Date().toISOString(), signCount: 0, origin: GLASS, rpId: 'glass.test' }, hostedFile);
  server = serveGlass(0, {
    runChallenges: new RunChallenges(() => clock),
    runWindows: new RunWindows(() => clock),
    confirmPasskeyRegistration: async () => undefined,
    passkeysFile,
    hostedPasskeysFile: hostedFile,
    runs,
  });
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  await runs.settled();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

function call(host: string, url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const req = httpRequest(`http://127.0.0.1:${port}${url}`, { method: init.method ?? 'GET', headers: { Host: host, ...(body ? { 'content-type': 'application/json' } : {}), ...init.headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** A request from the hosted glass, as the boat's mirror loop posts it to its own glass. */
async function relayed(kind: string, payload: unknown) {
  const host = `127.0.0.1:${port}`;
  const token = (await call(host, '/data')).json.focusToken as string;
  return call(host, '/requests', { method: 'POST', body: { kind, payload }, headers: { Origin: `http://${host}`, 'x-lobstah-token': token, 'x-lobstah-relay': 'wharf' } });
}

/** A request from the Mac's own glass page at localhost. */
async function local(kind: string, payload: unknown) {
  const host = `localhost:${port}`;
  const token = (await call(host, '/data')).json.focusToken as string;
  return call(host, '/requests', { method: 'POST', body: { kind, payload }, headers: { Origin: `http://${host}`, 'x-lobstah-token': token } });
}

function runCard(opts: { interactive?: boolean; inputs?: string[] } = {}): { key: string; sha256: string } {
  const file = path.join(home, `s-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(file, '#!/bin/bash\necho hi\n');
  const run = prepareRunCard({ scriptFile: file, cwd: home, ...(opts.interactive ? { interactive: true } : {}), ...(opts.inputs ? { inputs: opts.inputs } : {}) });
  const { meta } = askDecision({ title: 'Run it', options: ['Decline'], askedBy: 'helm', run, maxBytes: 1024 });
  return { key: meta.key, sha256: run.card.scriptSha256 };
}

/** The page's window key: P-256, as WebCrypto makes it. */
function windowKey(): { spki: string; privateKey: KeyObject } {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { spki: (pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url'), privateKey: pair.privateKey };
}
const signWith = (key: KeyObject, challenge: string) => sign('sha256', Buffer.from(challenge), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');

/** A hosted Run confirmed with the phone's passkey, optionally opening a window. */
async function passkeyRun(card: { key: string; sha256: string }, opts: { passkey?: SoftPasskey; origin?: string; window?: string } = {}) {
  const asked = await relayed('run-challenge', card);
  expect(asked.status).toBe(200);
  const assertion = (opts.passkey ?? phone).assert(asked.json.challenge as string, opts.origin ?? GLASS);
  return relayed('run', { key: card.key, ...assertion, inputs: {}, ...(opts.window ? { windowKey: opts.window } : {}) });
}

describe('a Run from the hosted glass', () => {
  it("asks for the phone's passkey for the hosted glass, and runs once it signs", async () => {
    const card = runCard();
    const asked = await relayed('run-challenge', card);
    expect(asked.json).toMatchObject({ ok: true, rpId: 'glass.test', credentialIds: [phone.credentialId.toString('base64url')], sha256: card.sha256 });
    const res = await relayed('run', { key: card.key, ...phone.assert(asked.json.challenge as string, GLASS), inputs: {} });
    expect(res.status).toBe(202);
    await runs.settled();
    expect((await relayed('run-output', { key: card.key })).json).toMatchObject({ ok: true, state: 'succeeded' });
  });

  it("never takes the Mac's passkey through the relay, nor the phone's on the Mac", async () => {
    const mac = new SoftPasskey('localhost');
    addRunPasskey({ credentialId: mac.credentialId.toString('base64url'), publicKey: mac.spki.toString('base64url'), alg: -7, createdAt: new Date().toISOString(), signCount: 0 }, passkeysFile);
    const card = runCard();
    // The Mac's passkey signing a relayed challenge, as the hosted origin or the Mac's.
    expect((await passkeyRun(card, { passkey: mac })).status).toBe(403);
    expect((await passkeyRun(card, { passkey: mac, origin: `http://localhost:${port}` })).status).toBe(403);
    // The phone's passkey with the wrong origin.
    expect((await passkeyRun(card, { origin: `http://localhost:${port}` })).status).toBe(403);
    // The phone's passkey on the Mac's own page.
    const asked = await local('run-challenge', card);
    expect(asked.status).toBe(200);
    expect((await local('run', { key: card.key, ...phone.assert(asked.json.challenge as string, GLASS), inputs: {} })).status).toBe(403);
    // The Mac's passkey registration never goes through the relay.
    expect((await relayed('run-passkey-challenge', {})).status).toBe(403);
  });

  it('says to pair first when no phone passkey is paired, and keeps interactive cards on the Mac', async () => {
    fs.rmSync(hostedFile);
    const none = await relayed('run-challenge', runCard());
    expect(none.status).toBe(409);
    expect(none.json.reason).toBe('Pair this phone first: run lobstah run passkey add --hosted on the Mac.');
    const interactive = await relayed('run-challenge', runCard({ interactive: true }));
    expect(interactive.json.reason).toBe('Interactive cards run from the Mac.');
    // Until inputs are sealed to the boat, a secret never crosses the wharf; a text input may.
    const secret = await relayed('run-challenge', runCard({ inputs: ['TOKEN'] }));
    expect(secret.json.reason).toBe('Secret inputs are typed on the Mac for now.');
  });
});

describe('the 15-minute window', () => {
  it("opens on a passkey Run, then lets the page's window key sign later runs without a passkey", async () => {
    const page = windowKey();
    const first = await passkeyRun(runCard(), { window: page.spki });
    expect(first.status).toBe(202);
    expect(first.json.windowUntil).toBe(clock + RUN_WINDOW_MS);
    const id = first.json.window as string;
    const card = runCard();
    const asked = await relayed('run-challenge', { ...card, window: id });
    expect(asked.json).toMatchObject({ ok: true, window: id });
    expect(asked.json.rpId).toBeUndefined();
    const res = await relayed('run', { key: card.key, challenge: asked.json.challenge, window: id, windowSignature: signWith(page.privateKey, asked.json.challenge as string), inputs: {} });
    expect(res.status).toBe(202);
  });

  it('refuses a wrong key, another card, the other glass, and a window past 15 minutes', async () => {
    const page = windowKey();
    const id = (await passkeyRun(runCard(), { window: page.spki })).json.window as string;
    const card = runCard();
    // Another key's signature.
    let asked = await relayed('run-challenge', { ...card, window: id });
    expect((await relayed('run', { key: card.key, challenge: asked.json.challenge, window: id, windowSignature: signWith(windowKey().privateKey, asked.json.challenge as string), inputs: {} })).status).toBe(403);
    // A challenge issued for one card, sent for another.
    asked = await relayed('run-challenge', { ...card, window: id });
    const other = runCard();
    expect((await relayed('run', { key: other.key, challenge: asked.json.challenge, window: id, windowSignature: signWith(page.privateKey, asked.json.challenge as string), inputs: {} })).status).toBe(403);
    // A window opened on the hosted glass is no window on the Mac's own page.
    const mac = await local('run-challenge', { ...card, window: id });
    expect(mac.json.window).toBeUndefined();
    // Past 15 minutes the window is gone: the boat asks for the passkey again.
    clock += RUN_WINDOW_MS + 1;
    const late = await relayed('run-challenge', { ...card, window: id });
    expect(late.json.window).toBeUndefined();
    expect(late.json.rpId).toBe('glass.test');
  });

  it('refuses a window key that is not a P-256 public key, and starts nothing', async () => {
    const card = runCard();
    const res = await passkeyRun(card, { window: 'not-a-key-'.repeat(5) });
    expect(res.status).toBe(400);
    expect(runs.get(card.key)).toBeUndefined();
  });
});

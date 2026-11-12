import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { askDecision, decisionDir, ensureLayout, prepareRunCard, readDecisionAnswer } from '@lobstah/core';
import { serveGlass } from '../src/glass.js';
import { PASSKEY_DIALOG_PROMPT, RUN_CHALLENGE_MS, RunChallenges, macPasswordGate, readRunPasskeys } from '../src/run-passkey.js';
import { RunRegistry } from '../src/run-exec.js';
import { SoftPasskey } from './fixtures/soft-passkey.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * Run cards, PR 2 (ume 3ef69c1d-026, intent run-passkey): Chris registers a
 * passkey once, and a Run is confirmed by an assertion from it over a fresh,
 * single-use challenge bound to the card and its script hash. The glass
 * answers at localhost (the WebAuthn relying party) as well as 127.0.0.1, and
 * at no other name.
 */

let home: string;
let server: Server | undefined;
let port: number;
let clock: number;
let challenges: RunChallenges;
let confirm: () => Promise<string | undefined>;
let passkeysFile: string;
let runs: RunRegistry;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-run-passkey-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  clock = Date.now();
  challenges = new RunChallenges(() => clock);
  confirm = async () => undefined;
  passkeysFile = path.join(home, 'run', 'passkeys.json');
  runs = new RunRegistry();
  server = serveGlass(0, { runChallenges: challenges, confirmPasskeyRegistration: () => confirm(), passkeysFile, runs });
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  await runs.settled();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

/** A request with a chosen Host, as a browser at that address (or a rebound name) sends it. */
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

const localhost = () => `localhost:${port}`;
const ip = () => `127.0.0.1:${port}`;
const token = async (host: string) => (await call(host, '/data')).json.focusToken as string;

/** A page at `host` posting one glass request with its token. */
async function post(host: string, kind: string, payload: unknown) {
  return call(host, '/requests', { method: 'POST', body: { kind, payload }, headers: { Origin: `http://${host}`, 'x-lobstah-token': await token(host) } });
}

const origin = () => `http://localhost:${port}`;

function runCard(body = '#!/bin/bash\necho hi\n'): { key: string; sha256: string } {
  const file = path.join(home, `s-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(file, body);
  const run = prepareRunCard({ scriptFile: file, cwd: home });
  const { meta } = askDecision({ title: 'Run it', options: ['Decline'], askedBy: 'helm', run, maxBytes: 1024 });
  return { key: meta.key, sha256: run.card.scriptSha256 };
}

async function register(passkey = new SoftPasskey()) {
  const challenge = (await post(localhost(), 'run-passkey-challenge', {})).json.challenge as string;
  return { passkey, res: await post(localhost(), 'run-passkey-register', passkey.register(challenge, origin())) };
}

async function runChallenge(card: { key: string; sha256: string }) {
  return post(localhost(), 'run-challenge', card);
}

describe('registering the run passkey', () => {
  it('stores a verified passkey once Chris allows it, and only its public key', async () => {
    const { passkey, res } = await register();
    expect(res.status).toBe(201);
    expect(readRunPasskeys(passkeysFile)).toEqual([
      expect.objectContaining({ credentialId: passkey.credentialId.toString('base64url'), publicKey: passkey.spki.toString('base64url'), alg: -7 }),
    ]);
  });

  it('stores nothing when Chris refuses it outside the browser', async () => {
    confirm = async () => 'Chris declined the passkey.';
    const { res } = await register();
    expect(res.status).toBe(403);
    expect(res.json.reason).toBe('Chris declined the passkey.');
    expect(readRunPasskeys(passkeysFile)).toEqual([]);
  });

  it('refuses a passkey that did not verify the user', async () => {
    const challenge = (await post(localhost(), 'run-passkey-challenge', {})).json.challenge as string;
    const res = await post(localhost(), 'run-passkey-register', new SoftPasskey().register(challenge, origin(), 0x01));
    expect(res.status).toBe(403);
    expect(res.json.reason).toContain('did not verify the user');
  });

  it('registers another passkey only with consent from a current one', async () => {
    const { passkey: first } = await register();
    const second = new SoftPasskey();
    const bare = await register(second);
    expect(bare.res.status).toBe(403);
    expect(bare.res.json.reason).toContain('confirm with it to register another');
    const start = (await post(localhost(), 'run-passkey-challenge', {})).json;
    expect(start.credentialIds).toEqual([first.credentialId.toString('base64url')]);
    const stranger = await post(localhost(), 'run-passkey-register', { ...second.register(start.challenge as string, origin()), existing: new SoftPasskey().assert(start.existingChallenge as string, origin()) });
    expect(stranger.status).toBe(403);
    const again = (await post(localhost(), 'run-passkey-challenge', {})).json;
    const ok = await post(localhost(), 'run-passkey-register', { ...second.register(again.challenge as string, origin()), existing: first.assert(again.existingChallenge as string, origin()) });
    expect(ok.status).toBe(201);
    expect(readRunPasskeys(passkeysFile)).toHaveLength(2);
  });

  it("asks with macOS's own password dialog, and refuses without the password or off macOS", async () => {
    const calls: string[][] = [];
    const allowed = macPasswordGate(async (command, args) => (calls.push([command, ...args]), 0), 'darwin');
    expect(await allowed()).toBeUndefined();
    expect(calls[0]![0]).toBe('/usr/bin/osascript');
    expect(calls[0]![2]).toContain('with administrator privileges');
    expect(calls[0]![2]).toContain(PASSKEY_DIALOG_PROMPT);
    expect(await macPasswordGate(async () => 1, 'darwin')()).toBe("The macOS password wasn't given, so the passkey was not stored.");
    expect(await macPasswordGate(async () => 0, 'linux')()).toContain('macOS');
  });

  it('works only from the localhost page, and says where', async () => {
    const res = await post(ip(), 'run-passkey-challenge', {});
    expect(res.status).toBe(409);
    expect(res.json.reason).toContain(`http://localhost:${port}`);
  });
});

describe('confirming a Run with the passkey', () => {
  it('accepts an assertion from the registered passkey over a fresh challenge, and spends the challenge', async () => {
    const { passkey } = await register();
    const card = runCard();
    const challenge = (await runChallenge(card)).json.challenge as string;
    const assertion = passkey.assert(challenge, origin());
    const ok = await post(localhost(), 'run', { key: card.key, ...assertion, inputs: {} });
    expect(ok.status).toBe(202);
    expect(ok.json).toMatchObject({ ok: true, running: true, key: card.key });
    const replay = await post(localhost(), 'run', { key: card.key, ...assertion });
    expect(replay.status).toBe(403);
    expect(replay.json.reason).toContain('unknown, spent or older than two minutes');
  });

  it('refuses a challenge older than 120 seconds', async () => {
    const { passkey } = await register();
    const card = runCard();
    const challenge = (await runChallenge(card)).json.challenge as string;
    clock += RUN_CHALLENGE_MS + 1_000;
    const res = await post(localhost(), 'run', { key: card.key, ...passkey.assert(challenge, origin()) });
    expect(res.status).toBe(403);
  });

  it('refuses an unregistered key, a signature over another challenge, and an assertion for another card', async () => {
    const { passkey } = await register();
    const card = runCard();
    const other = runCard('#!/bin/bash\necho other\n');
    const stranger = new SoftPasskey();
    let challenge = (await runChallenge(card)).json.challenge as string;
    expect((await post(localhost(), 'run', { key: card.key, ...stranger.assert(challenge, origin()) })).status).toBe(403);
    challenge = (await runChallenge(card)).json.challenge as string;
    const signed = passkey.assert(challenge, origin());
    const forged = { ...signed, signature: passkey.assert((await runChallenge(card)).json.challenge as string, origin()).signature };
    expect((await post(localhost(), 'run', { key: card.key, ...forged })).status).toBe(403);
    challenge = (await runChallenge(card)).json.challenge as string;
    const moved = await post(localhost(), 'run', { key: other.key, ...passkey.assert(challenge, origin()) });
    expect(moved.status).toBe(403);
    expect(moved.json.reason).toContain('different card');
  });

  it('issues no challenge for a script hash the card does not have, or a stored copy that changed', async () => {
    await register();
    const card = runCard();
    expect((await runChallenge({ key: card.key, sha256: '0'.repeat(64) })).status).toBe(409);
    fs.writeFileSync(path.join(decisionDir(card.key)!, 'run', 'script'), 'echo changed\n');
    const res = await runChallenge(card);
    expect(res.status).toBe(409);
    expect(res.json.reason).toContain('This script changed after it was proposed');
  });

  it('asks for a passkey before issuing a run challenge', async () => {
    const res = await runChallenge(runCard());
    expect(res.status).toBe(409);
    expect(res.json.reason).toContain('Set up a passkey in Configuration');
  });
});

describe('the hosts the glass answers', () => {
  it('refuses writes at any name but 127.0.0.1 or localhost on its own port', async () => {
    const t = await token(ip());
    for (const host of ['evil.test', `evil.test:${port}`, `localhost:${port + 1}`, `127.0.0.1:${port + 1}`, `[::1]:${port}`]) {
      const res = await call(host, '/requests', { method: 'POST', body: { kind: 'run-passkey-challenge', payload: {} }, headers: { Origin: `http://${host}`, 'x-lobstah-token': t } });
      expect(res.status, host).toBe(403);
    }
  });

  it('takes a decision answer with the page token alone, at either name, with no passkey', async () => {
    for (const host of [ip(), localhost()]) {
      const { meta } = askDecision({ title: `Ship from ${host}?`, options: ['Yes', 'No'], askedBy: 'helm', maxBytes: 1024 });
      const res = await post(host, 'decision-answer', { key: meta.key, option: 'Yes', files: [] });
      expect(res.status, host).toBe(201);
      expect(readDecisionAnswer(meta.key)?.option).toBe('Yes');
    }
  });
});

describe('the passkey in the glass', () => {
  it('Settings counts the registered passkeys and links the 127.0.0.1 page to localhost to register one', async () => {
    const { GLASS_PAGE } = await import('../src/glass-page.generated.js');
    const { loadGlass } = await import('./glass-dom.js');
    const { emptyFleet, NOW } = await import('./fixtures/glass-snapshots.js');
    const d = emptyFleet();
    d.runPasskeys = { count: 0 };
    const none = await loadGlass(GLASS_PAGE, d, { now: NOW, hash: '#settings' });
    try {
      const section = none.$('#settings .runpasskeys')!;
      expect(section.textContent).toContain('No passkey yet');
      expect(section.querySelector('a')?.getAttribute('href')).toMatch(/^http:\/\/localhost(:\d+)?\/#settings$/);
    } finally {
      await none.close();
    }
    d.runPasskeys = { count: 1, newestAt: new Date(NOW).toISOString() };
    const one = await loadGlass(GLASS_PAGE, d, { now: NOW, hash: '#settings' });
    try {
      expect(one.$('#settings .runpasskeys')!.textContent).toContain('1 passkey registered');
    } finally {
      await one.close();
    }
  });
});

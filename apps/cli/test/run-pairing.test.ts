import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ensureLayout } from '@lobstah/core';
import { serveGlass } from '../src/glass.js';
import { RunChallenges, readRunPasskeys } from '../src/run-passkey.js';
import { PAIRING_MS, endPairing, issuePairing, pairingBoatName, pairingOrigin, pendingPairing } from '../src/run-pairing.js';
import { RunRegistry } from '../src/run-exec.js';
import { SoftPasskey } from './fixtures/soft-passkey.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * Pairing a phone's passkey with a boat (ume 2ec9c88b-193, intent
 * run-access): `lobstah run passkey add --hosted` issues one code, and the
 * boat takes a passkey for the hosted glass only under that code, within
 * five minutes, once, from a ceremony whose origin is the hosted glass.
 */

const GLASS = 'https://glass.test';

let home: string;
let server: Server | undefined;
let port: number;
let runs: RunRegistry;
let passkeysFile: string;
let hostedFile: string;
let pairFile: string;
let challenges: RunChallenges;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-run-pairing-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  runs = new RunRegistry();
  passkeysFile = path.join(home, 'run', 'passkeys.json');
  hostedFile = path.join(home, 'run', 'hosted-passkeys.json');
  pairFile = path.join(home, 'run', 'pairing.json');
  challenges = new RunChallenges();
  server = serveGlass(0, { runChallenges: challenges, confirmPasskeyRegistration: async () => undefined, passkeysFile, hostedPasskeysFile: hostedFile, pairingFile: pairFile, runs });
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  await runs.settled();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

function call(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const host = `127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const req = httpRequest(`http://${host}${url}`, { method: init.method ?? 'GET', headers: { Host: host, ...(body ? { 'content-type': 'application/json' } : {}), ...init.headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** A relayed request, as the boat's mirror loop posts it to its own glass. */
async function relayed(kind: string, payload: unknown) {
  const token = (await call('/data')).json.focusToken as string;
  return call('/requests', { method: 'POST', body: { kind, payload }, headers: { Origin: `http://127.0.0.1:${port}`, 'x-lobstah-token': token, 'x-lobstah-relay': 'wharf' } });
}

async function pair(code: string, passkey = new SoftPasskey('glass.test'), origin = GLASS) {
  const challenge = await relayed('run-pair-challenge', { pair: code });
  if (challenge.status !== 200) return challenge;
  expect(challenge.json.rpId).toBe('glass.test');
  return relayed('run-pair-register', { pair: code, registration: passkey.register(challenge.json.challenge as string, origin) });
}

describe('a pairing code', () => {
  it('names an https hosted glass, or http on this machine for tests', () => {
    expect(pairingOrigin('https://glass.lobstah.dev')).toEqual({ origin: 'https://glass.lobstah.dev', rpId: 'glass.lobstah.dev' });
    expect(pairingOrigin('http://localhost:8787')).toEqual({ origin: 'http://localhost:8787', rpId: 'localhost' });
    for (const bad of ['http://glass.lobstah.dev', 'https://glass.lobstah.dev/passkey', 'https://user@glass.lobstah.dev', 'nope']) expect(pairingOrigin(bad)).toBeUndefined();
  });

  it('works for five minutes, only as issued, and a newer one replaces it', () => {
    const t = Date.parse('2026-11-11T08:00:00Z');
    const code = issuePairing(GLASS, t, pairFile);
    expect(fs.readFileSync(pairFile, 'utf8')).not.toContain(code);
    expect(pendingPairing(code, t + PAIRING_MS, pairFile)).toMatchObject({ origin: GLASS, rpId: 'glass.test' });
    expect(pendingPairing(code, t + PAIRING_MS + 1, pairFile)).toBeUndefined();
    expect(pendingPairing(code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A'), t, pairFile)).toBeUndefined();
    const newer = issuePairing(GLASS, t, pairFile);
    expect(pendingPairing(code, t, pairFile)).toBeUndefined();
    expect(pendingPairing(newer, t, pairFile)).toBeTruthy();
    endPairing(pairFile);
    expect(pendingPairing(newer, t, pairFile)).toBeUndefined();
  });
});

describe("the pairing link's boat", () => {
  const status = { wharf: 'lobstah', glass: 'https://glass.lobstah.dev', calls: 0, at: '2026-11-11T00:00:00.000Z' };

  it("asks the wharf for this boat's name when the mirror hasn't recorded it", async () => {
    const asked: string[] = [];
    const name = await pairingBoatName(status, async (wharf) => {
      asked.push(wharf);
      return { id: 'b-1', name: 'studio', permissions: ['mirror'] };
    });
    expect(name).toBe('studio');
    expect(asked).toEqual(['lobstah']);
  });

  it("uses a recorded name, and has none when there's no hosted glass or the wharf names none", async () => {
    const never = async () => { throw new Error('not asked'); };
    expect(await pairingBoatName({ ...status, boat: 'mini' }, never)).toBe('mini');
    expect(await pairingBoatName({ ...status, glass: undefined }, never)).toBeUndefined();
    expect(await pairingBoatName(undefined, never)).toBeUndefined();
    expect(await pairingBoatName(status, async () => ({ id: 'b-1' }))).toBeUndefined();
  });
});

describe('pairing through the relay', () => {
  it('stores the phone passkey for the hosted glass, apart from the Mac’s own, and spends the code', async () => {
    const code = issuePairing(GLASS, Date.now(), pairFile);
    const passkey = new SoftPasskey('glass.test');
    const res = await pair(code, passkey);
    expect(res.status).toBe(201);
    expect(readRunPasskeys(hostedFile)).toEqual([
      expect.objectContaining({ credentialId: passkey.credentialId.toString('base64url'), publicKey: passkey.spki.toString('base64url'), origin: GLASS, rpId: 'glass.test' }),
    ]);
    expect(readRunPasskeys(passkeysFile)).toEqual([]);
    // The snapshot counts it, never shows it.
    expect((await call('/data')).json.runPasskeys).toMatchObject({ count: 0, hosted: 1 });
    // The code worked once.
    expect((await pair(code)).status).toBe(403);
  });

  it('refuses an unknown or expired code before issuing a challenge', async () => {
    const res = await relayed('run-pair-challenge', { pair: 'x'.repeat(24) });
    expect(res.status).toBe(403);
    expect(res.json.reason).toContain('run passkey add --hosted');
    const code = issuePairing(GLASS, Date.now() - PAIRING_MS - 1, pairFile);
    expect((await relayed('run-pair-challenge', { pair: code })).status).toBe(403);
  });

  it('refuses a passkey made anywhere but the hosted glass', async () => {
    // A ceremony on the local glass (origin localhost) or for another relying party can't pair.
    const code = issuePairing(GLASS, Date.now(), pairFile);
    expect((await pair(code, new SoftPasskey('glass.test'), `http://localhost:${port}`)).status).toBe(403);
    expect((await pair(code, new SoftPasskey('evil.test'))).status).toBe(403);
    expect(readRunPasskeys(hostedFile)).toEqual([]);
    // A failed attempt doesn't spend the code; a good one still pairs.
    expect((await pair(code)).status).toBe(201);
  });

  it('takes no challenge but the pairing’s own', async () => {
    const code = issuePairing(GLASS, Date.now(), pairFile);
    const passkey = new SoftPasskey('glass.test');
    // A Mac registration challenge, or another pairing's, can't stand in for this pairing's.
    for (const scope of [{ kind: 'register' as const }, { kind: 'pair' as const, code: 'y'.repeat(24) }]) {
      const res = await relayed('run-pair-register', { pair: code, registration: passkey.register(challenges.issue(scope), GLASS) });
      expect(res.status).toBe(403);
    }
    expect(readRunPasskeys(hostedFile)).toEqual([]);
  });
});

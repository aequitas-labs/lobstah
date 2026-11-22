import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { askDecision, ensureLayout, prepareRunCard } from '@lobstah/core';
import type { GlassRunCard, GlassSnapshot } from '@lobstah/core';
import { serveGlass } from '../src/glass.js';
import { RunChallenges, addRunPasskey } from '../src/run-passkey.js';
import { RunWindows } from '../src/run-window.js';
import { RunRegistry } from '../src/run-exec.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW } from './fixtures/glass-snapshots.js';
import { RUN_KEY, glassRun, runCardFleet } from './fixtures/run-card.js';
import { SoftPasskey } from './fixtures/soft-passkey.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * A line typed into an interactive run on the hosted glass, end to end: the
 * glass page's own code seals and signs it, a relay posts it to a real boat
 * glass as the boat's wharf mirror does (`X-Lobstah-Relay: wharf`), and the
 * boat writes it into the script's terminal. The phone's passkey is a
 * software authenticator for the hosted glass's origin.
 */

/** The hosted glass's origin, which the phone's passkey was paired for. */
const HOSTED_ORIGIN = 'https://glass.test';
/** The boat's id on the hosted glass: a card that names it is a hosted run. */
const BOAT = 'studio';
/** The script the dispatch names: it waits for one line and prints what it got. */
const READ_ONE_LINE = '#!/bin/bash\nread -r -p "Continue? " answer\necho "got:$answer"\n';

let home: string;
let boatGlass: Server;
let boatPort: number;
let runs: RunRegistry;
let phone: SoftPasskey;
let pages: GlassDom[] = [];
/** The cards each test made, stopped after it if still running. */
let cardKeys: string[] = [];

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-run-console-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  runs = new RunRegistry();
  phone = new SoftPasskey('glass.test');
  const hostedPasskeysFile = path.join(home, 'run', 'hosted-passkeys.json');
  addRunPasskey(
    { credentialId: phone.credentialId.toString('base64url'), publicKey: phone.spki.toString('base64url'), alg: -7, createdAt: new Date().toISOString(), signCount: 0, origin: HOSTED_ORIGIN, rpId: 'glass.test' },
    hostedPasskeysFile,
  );
  boatGlass = serveGlass(0, {
    runChallenges: new RunChallenges(),
    runWindows: new RunWindows(),
    confirmPasskeyRegistration: async () => undefined,
    passkeysFile: path.join(home, 'run', 'passkeys.json'),
    hostedPasskeysFile,
    runs,
  });
  await new Promise<void>((resolve) => boatGlass.once('listening', resolve));
  boatPort = (boatGlass.address() as AddressInfo).port;
});
afterEach(async () => {
  await Promise.all(pages.map((g) => g.close()));
  pages = [];
  for (const key of cardKeys) runs.stop(key);
  cardKeys = [];
  await runs.settled();
  await new Promise<void>((resolve) => boatGlass.close(() => resolve()));
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

/** One HTTP call to the boat's glass. */
function boatCall(url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const host = `127.0.0.1:${boatPort}`;
    const req = httpRequest(`http://${host}${url}`, { method: init.method ?? 'GET', headers: { Host: host, ...init.headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }));
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

/** The boat's own snapshot, as its mirror reads it. */
async function boatSnapshot(): Promise<GlassSnapshot> {
  return (await boatCall('/data')).body as GlassSnapshot;
}

/**
 * The wharf relay as the boat's mirror carries it out (wharf-mirror.ts): the
 * hosted page's request, posted to the boat's glass with the boat's own page
 * token and marked as relayed.
 */
async function relayToBoat(body: string): Promise<{ status: number; body: unknown }> {
  const token = (await boatSnapshot()).focusToken!;
  const host = `127.0.0.1:${boatPort}`;
  return boatCall('/requests', {
    method: 'POST',
    body,
    headers: { Origin: `http://${host}`, 'Content-Type': 'application/json', 'X-Lobstah-Token': token, 'X-Lobstah-Relay': 'wharf' },
  });
}

/** An interactive run card on the boat, for `script`. */
function interactiveCard(script: string): { key: string; run: GlassRunCard } {
  const file = path.join(home, 'card.sh');
  fs.writeFileSync(file, script);
  const prepared = prepareRunCard({ scriptFile: file, cwd: home, interactive: true });
  const { meta } = askDecision({ title: 'Answer one prompt', options: ['Decline'], askedBy: 'helm', run: prepared, maxBytes: 1024 });
  cardKeys.push(meta.key);
  return { key: meta.key, run: glassRun(script, { ...prepared.card, inputs: [], boat: BOAT }) };
}

/**
 * The hosted glass page showing the boat's card, with the seal key the boat
 * publishes unless `sealKey` names another. Its requests go through the
 * relay; the phone's passkey answers the boat's challenge for the hosted
 * origin. The returned `fleet` is the snapshot the page shows.
 */
async function hostedPage(card: { key: string; run: GlassRunCard }, options: { sealKey?: string } = {}) {
  const boatCard = (await boatSnapshot()).decisions.find((d) => d.key === card.key)!;
  const sealKey: string | undefined = options.sealKey ?? boatCard.run?.sealKey;
  const fleet = runCardFleet({ ...card.run, ...(sealKey ? { sealKey } : {}) });
  for (const row of [...fleet.attention, ...fleet.decisions]) if (row.key === RUN_KEY) row.key = card.key;
  fleet.runPasskeys = { count: 0, hosted: 1 };
  const g = await loadGlass(GLASS_PAGE, fleet, {
    now: NOW,
    hash: `#decision/${encodeURIComponent(card.key)}`,
    prepare: (window) => {
      Object.defineProperty(window, 'PublicKeyCredential', { value: class {}, configurable: true });
      Object.defineProperty(window.navigator, 'credentials', {
        configurable: true,
        value: {
          get: async (options: { publicKey: { challenge: ArrayBuffer } }) => {
            const assertion = phone.assert(Buffer.from(options.publicKey.challenge).toString('base64url'), HOSTED_ORIGIN);
            const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64url')).buffer;
            return {
              rawId: bytes(assertion.credentialId),
              response: { clientDataJSON: bytes(assertion.clientDataJSON), authenticatorData: bytes(assertion.authenticatorData), signature: bytes(assertion.signature) },
            };
          },
        },
      });
    },
    post: (_url, request) => relayToBoat(request.body),
  });
  pages.push(g);
  return { g, fleet };
}

/** Wait, without settling the page: the run's output poll keeps a timer pending while it runs. */
async function until<T>(what: string, get: () => T | null | undefined | false | Promise<T | null | undefined | false>): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const got = await get();
    if (got) return got;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The run's output as the boat holds it. */
async function boatOutput(key: string): Promise<string> {
  const relayed = await relayToBoat(JSON.stringify({ kind: 'run-output', payload: { key, after: 0 } }));
  return String((relayed.body as { text?: string }).text ?? '');
}

/** Type a line into the card's console and press Enter, as the phone's keyboard does. */
async function typeLine(g: GlassDom, text: string): Promise<void> {
  const field = await until('the console line', () => g.$('#doverlay .runlinein') as HTMLInputElement | null);
  field.value = text;
  field.dispatchEvent(new g.window.Event('input', { bubbles: true }) as unknown as Event);
  await new Promise((r) => setTimeout(r, 25));
  g.$('#doverlay .runlinein')!.dispatchEvent(new g.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as Event);
}

// An interactive card needs expect(1), which macOS ships and CI's Linux runners don't.
describe.skipIf(process.platform === 'win32' || !fs.existsSync('/usr/bin/expect'))('typing into an interactive run from the hosted glass', () => {
  it('delivers y and Enter from the page to the script, through the relay', async () => {
    const card = interactiveCard(READ_ONE_LINE);
    const { g } = await hostedPage(card);
    (g.$('#doverlay .runbtn') as HTMLButtonElement).click();
    await until('the prompt', async () => (await boatOutput(card.key)).includes('Continue?'));
    await typeLine(g, 'y');
    await until('the answer', async () => (await boatOutput(card.key)).includes('got:y'));
  }, 20_000);

  it('still delivers the line after the card leaves the snapshot the page shows', async () => {
    const card = interactiveCard(READ_ONE_LINE);
    const { g, fleet } = await hostedPage(card);
    (g.$('#doverlay .runbtn') as HTMLButtonElement).click();
    await until('the prompt', async () => (await boatOutput(card.key)).includes('Continue?'));
    // The boat's next snapshot no longer lists the card as standing, while its run still waits.
    g.serve({ ...fleet, attention: [], decisions: [] });
    await g.poll();
    await typeLine(g, 'y');
    await until('the answer', async () => (await boatOutput(card.key)).includes('got:y'));
    // The line crossed the relay sealed, never in the clear.
    const lines = g.posts().filter((p) => (JSON.parse(p.body) as { kind: string }).kind === 'run-line');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!.body).payload).toMatchObject({ seq: 0, secret: false, sealed: expect.any(Object) });
    expect(JSON.parse(lines[0]!.body).payload).not.toHaveProperty('line');
  }, 20_000);

  it("says why on the page, keeps the answer to send again, and logs the run id when the boat can't take the line", async () => {
    const logged = vi.spyOn(console, 'info');
    const card = interactiveCard(READ_ONE_LINE);
    // A seal key that isn't the boat's: the boat can't open the line.
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const { g } = await hostedPage(card, { sealKey: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url') });
    (g.$('#doverlay .runbtn') as HTMLButtonElement).click();
    await until('the prompt', async () => (await boatOutput(card.key)).includes('Continue?'));
    const attempt = runs.get(card.key)!.attempt.id;
    await typeLine(g, 'y');
    const shown = await until('the refusal', () => g.$('#doverlay .runconsole .bad')?.textContent);
    expect(shown).toBe("A sealed input couldn't be opened on this boat.");
    expect((g.$('#doverlay .runlinein') as HTMLInputElement).value).toBe('y');
    expect(logged.mock.calls.map((c) => String(c[0]))).toContain(
      `Run ${card.key} line from the hosted glass not delivered (${attempt}): A sealed input couldn't be opened on this boat.`,
    );
    expect(await boatOutput(card.key)).not.toContain('got:');
    logged.mockRestore();
  }, 20_000);
});

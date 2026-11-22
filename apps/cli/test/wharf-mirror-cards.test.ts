import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocketServer } from 'ws';
import type { WebSocket as ServerSocket } from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureLayout, listGrants, loadConfig, readDecisionAnswer } from '@lobstah/core';
import type { CardAnswerReceipt, DecisionMeta } from '@lobstah/core';
import { askPermission } from '../src/grants-cli.js';
import { ALLOW_HERE_ONLY } from '../src/wharf-answers.js';
import { CARDS_CHECK_MS } from '../src/wharf-cards.js';
import { closeChannels } from '../src/wharf-channel.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * A mirror boat's local grounds on its wharf: its standing cards go out on
 * the mirror's own socket, and answers people give them come back and apply
 * once through the boat's ledger. A machine with no mirror and no wharf
 * grounds sends nothing.
 */

type Wharf = { url: string; sockets: ServerSocket[]; commands: Array<{ path: string; body: Record<string, unknown> }>; http: string[]; push: (m: unknown) => void };
let home: string;
let stopWharf: () => Promise<void> = async () => {};
let stopMirror: (() => void) | undefined;
/** The answers the loopback wharf hands this boat. */
let receipts: CardAnswerReceipt[] = [];

/** A wharf on loopback: commands on the socket answer 200; `GET cards/answers` over HTTP answers `receipts`. */
async function wharf(): Promise<Wharf> {
  const http: string[] = [], commands: Wharf['commands'] = [], sockets: ServerSocket[] = [];
  const server = createServer((request, response) => {
    const route = `${request.method} ${new URL(request.url!, 'http://x').pathname.replace(/^\/v1\/accounts\/[^/]+\//, '')}`;
    http.push(route);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(route === 'GET cards/answers' ? receipts : {}));
  });
  const ws = new WebSocketServer({ server, handleProtocols: (offered) => (offered.has('lobstah.2') ? 'lobstah.2' : false) });
  ws.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', (data) => {
      const text = data.toString();
      if (text === 'ping') return void socket.send('pong');
      const m = JSON.parse(text) as Record<string, unknown>;
      if (m.t === 'resume') socket.send(JSON.stringify({ t: 'hello', protocol: 'lobstah.2', cursor: 'g.1' }));
      if (m.t === 'command') {
        commands.push({ path: m.path as string, body: m.body as Record<string, unknown> });
        socket.send(JSON.stringify({ t: 'result', id: m.id, status: 200, value: {} }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stopWharf = async () => {
    for (const client of ws.clients) client.terminate();
    ws.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const push = (m: unknown) => { for (const s of sockets) s.send(JSON.stringify(m)); };
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sockets, commands, http, push };
}
const until = async (check: () => boolean, ms = 3000) => {
  for (const deadline = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > deadline) throw new Error('timed out');
};
/** This machine: one implicit home grounds and, unless `mirror` is false, `[glass] mirror` on the wharf. */
function configure(url: string, opts: { mirror?: boolean; remoteAnswers?: boolean } = {}) {
  fs.writeFileSync(path.join(home, 'config.toml'), `
[repos.local]
path = '${home.replaceAll('\\', '/')}'
${opts.mirror === false ? '' : `[glass]\nmirror = 'cloud'\n`}
[wharves.cloud]
url = '${url}'
account = 'person'
tokenEnv = 'LOBSTAH_TEST_MIRROR_CARDS_TOKEN'
${opts.remoteAnswers === false ? 'remoteAnswers = false' : ''}
`);
}
async function startMirror() {
  const { startWharfMirror } = await import('../src/wharf-mirror.js');
  stopMirror = startWharfMirror(loadConfig(), () => {})?.stop;
}
const ask = (): DecisionMeta => askPermission({ dispatch: 'd-1', lane: 'work', repo: 'local', ask: { command: 'wrangler deploy', harness: 'codex' } });
let n = 0;
const receipt = (d: DecisionMeta, action: CardAnswerReceipt['action']): CardAnswerReceipt => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, family: 'permission', key: d.key, stateHash: d.stateHash, revision: 1,
  action, by: 'person-a', at: new Date().toISOString(), state: 'pending',
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-mirror-cards-')); process.env.LOBSTAH_HOME = home; ensureLayout();
  process.env.LOBSTAH_TEST_MIRROR_CARDS_TOKEN = 'b.person.boat-1.secretsecretsecret';
  receipts = [];
});
afterEach(async () => {
  stopMirror?.(); stopMirror = undefined;
  closeChannels(); vi.restoreAllMocks(); vi.resetModules(); await stopWharf();
  delete process.env.LOBSTAH_HOME; delete process.env.LOBSTAH_TEST_MIRROR_CARDS_TOKEN; removeTempDir(home);
});

it('a decision standing on a mirrored home goes to the mirror’s wharf on its own socket within one check', async () => {
  const w = await wharf(); configure(w.url); await startMirror();
  await until(() => w.sockets.length === 1);
  const { publishBoatCards } = await import('../src/wharf-cards.js');
  const t0 = Date.now();
  await publishBoatCards(t0);
  expect(w.commands.filter((c) => c.path === 'cards')).toEqual([{ path: 'cards', body: { cards: [] } }]);
  const d = ask();
  // The daemon checks every CARDS_CHECK_MS: a card that stands now is on the wharf by the next check.
  await publishBoatCards(t0 + CARDS_CHECK_MS);
  const sent = w.commands.filter((c) => c.path === 'cards').at(-1)!.body.cards as Array<Record<string, unknown>>;
  expect(sent).toEqual([expect.objectContaining({ family: 'permission', key: d.key, grounds: 'home', stateHash: d.stateHash })]);
  // One socket, the mirror's: the cards never went over HTTP.
  expect(w.sockets).toHaveLength(1);
  expect(w.http.filter((r) => r === 'POST cards')).toEqual([]);
});

it('applies an answer from the wharf to a mirrored card once, when the wharf says one came', async () => {
  const w = await wharf(); configure(w.url); await startMirror();
  await until(() => w.sockets.length === 1);
  const { applyWharfAnswers } = await import('../src/wharf-answers.js');
  const d = ask(); const r = receipt(d, { kind: 'allow-once' });
  // With the socket open, the boat reads its answers when the wharf nudges, not on a timer.
  expect(await applyWharfAnswers(Date.now())).toBe(0);
  const reads = () => w.http.filter((x) => x === 'GET cards/answers').length;
  const first = reads();
  expect(await applyWharfAnswers(Date.now() + 60_000)).toBe(0);
  expect(reads()).toBe(first);
  receipts = [r];
  w.push({ t: 'nudge', read: 'cards/answers' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await applyWharfAnswers(Date.now())).toBe(1);
  expect(reads()).toBe(first + 1);
  expect(readDecisionAnswer(d.key)).toMatchObject({ option: 'Allow once', by: 'wharf', receipt: r.id });
  expect(w.commands.find((c) => c.path === `cards/answers/${r.id}`)?.body).toEqual({ state: 'applied', outcome: expect.stringMatching(/^grant /) });
  // The same receipt again, as a retried read would hand it: the ledger answers, and nothing applies twice.
  w.push({ t: 'nudge', read: 'cards/answers' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await applyWharfAnswers(Date.now())).toBe(1);
  expect(listGrants().grants).toHaveLength(1);
  expect(w.commands.filter((c) => c.path === `cards/answers/${r.id}`).map((c) => c.body.state)).toEqual(['applied', 'applied']);
});

it('a mirror boat with remoteAnswers false refuses an Allow from the wharf', async () => {
  const w = await wharf(); configure(w.url, { remoteAnswers: false }); await startMirror();
  await until(() => w.sockets.length === 1);
  const { applyWharfAnswers } = await import('../src/wharf-answers.js');
  const d = ask(); const r = receipt(d, { kind: 'allow-always' });
  receipts = [r];
  w.push({ t: 'nudge', read: 'cards/answers' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await applyWharfAnswers(Date.now())).toBe(0);
  expect(w.commands.find((c) => c.path === `cards/answers/${r.id}`)?.body).toEqual({ state: 'refused', outcome: ALLOW_HERE_ONLY });
  expect(listGrants().grants).toEqual([]);
  expect(readDecisionAnswer(d.key)).toBeUndefined();
});

it('a machine with no mirror and no wharf grounds sends no card and asks for no answer', async () => {
  const w = await wharf(); configure(w.url, { mirror: false });
  const fetches = vi.spyOn(globalThis, 'fetch');
  ask();
  const { publishBoatCards } = await import('../src/wharf-cards.js');
  for (let i = 0; i < 4; i++) await publishBoatCards(Date.now() + i * 600_000);
  expect(fetches).not.toHaveBeenCalled();
  expect(w.http).toEqual([]);
  expect(w.sockets).toEqual([]);
});

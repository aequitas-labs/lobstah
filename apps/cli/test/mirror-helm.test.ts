import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { ensureLayout, helmOf, loadConfig, readHelm, relieveHelm, standDownHelm } from '@lobstah/core';
import type { ClientSocketMessage, CommandMessage, MirrorStatus } from '@lobstah/core';
import { MIRROR_HELM_RENEW_MS, MIRROR_IDLE_READ_MS, WharfMirror, localHelms, takeMirrorSeat } from '../src/wharf-mirror.js';
import type { LocalGlass, MirrorChannel, MirrorWharf } from '../src/wharf-mirror.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * A mirrored Mac's helm is the person's one helm. `man helm` takes the
 * wharf's seat for its session; the daemon's mirror keeps it on its socket
 * while that helm is live, and a seat another helm took stands the local
 * helm down. A Mac with no mirror signs on per grounds and never calls the
 * wharf.
 */

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const MAC = '3f2a1b9c-7d4e-4f10-9a2b-5c6d7e8f9a01', OTHER = '8b7c6d5e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const HELD = 'The helm is held by session 8b7c6d5e on studio-mac. Sign on with --take to take it over, or leave it.';
let home: string;
let server: http.Server;
let wharfUrl: string;
/** Every request the stub wharf got, and how it answers `helm/take`. */
let heard: Array<{ method: string; path: string; body: Record<string, unknown> }>;
let seatAnswer: () => { status: number; value: unknown };

const environment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CODEX|CLAUDE)/.test(k))), LOBSTAH_HOME: home, LOBSTAH_TEST_WHARF: `b.acct.mac.${'s'.repeat(32)}` });
/** The CLI, as a session runs it; async, so the stub wharf in this process can answer. */
function run(args: string[], input?: Record<string, unknown>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: home, env: environment() });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input ? JSON.stringify({ cwd: home, ...input }) : '');
  });
}
function configure(mirror: boolean) {
  for (const repo of ['web', 'api']) fs.mkdirSync(path.join(home, repo), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), [
    `[repos.web]\npath = ${JSON.stringify(path.join(home, 'web'))}\ntrunk = "main"`,
    `[repos.api]\npath = ${JSON.stringify(path.join(home, 'api'))}\ntrunk = "main"`,
    '[grounds.home]\nrepos = ["web"]', '[grounds.work]\nrepos = ["api"]',
    `[wharves.lobstah]\nurl = "${wharfUrl}"\naccount = "acct"\ntokenEnv = "LOBSTAH_TEST_WHARF"`,
    ...(mirror ? ['[glass]\nmirror = "lobstah"'] : []),
  ].join('\n\n'));
}

/** The daemon's socket to the wharf: what the mirror sends on it, and how the wharf answers its seat. */
class FakeSocket implements MirrorChannel, MirrorWharf {
  commands: Array<Omit<CommandMessage, 't'>> = [];
  answer: (body: Record<string, unknown>) => { status: number; value: unknown } = (body) => ({ status: 200, value: body });
  connected() { return true; }
  send(_message: ClientSocketMessage) { return true; }
  sendFrame(_frame: Uint8Array) { return true; }
  async command(command: Omit<CommandMessage, 't'>) { this.commands.push(command); return this.answer(command.body as Record<string, unknown>); }
  async takeMirrorCall() {}
  async answerMirrorCall() {}
  async mirrorFile(): Promise<{ name: string; bytes: Uint8Array }> { throw new Error('no files'); }
}
/** A local glass with nothing new to say. */
const quietGlass: LocalGlass = {
  get: async () => ({ status: 304, contentType: 'application/json', body: Buffer.alloc(0) }),
  request: async () => ({ status: 404, contentType: 'application/json', body: Buffer.alloc(0) }),
};
function daemonMirror(socket: FakeSocket, now: () => number): WharfMirror {
  return new WharfMirror({ wharf: 'lobstah', backend: socket, channel: socket, glass: quietGlass, now, writeStatus: (_s: MirrorStatus) => {},
    helm: { live: () => localHelms(loadConfig()), displaced: (session, by) => void standDownHelm(session, by) } });
}
const seatTakes = (socket: FakeSocket) => socket.commands.filter((c) => c.path === 'helm/take').map((c) => c.body);

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-mirror-helm-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  heard = [];
  seatAnswer = () => ({ status: 200, value: { session: MAC } });
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      heard.push({ method: req.method ?? '', path: req.url ?? '', body: raw ? JSON.parse(raw) : {} });
      const answer = req.url?.endsWith('/helm/take') ? seatAnswer() : { status: 404, value: { error: 'not found' } };
      res.writeHead(answer.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer.value));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  wharfUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

it('hr-unmirrored: with no mirror, man helm signs on per grounds and makes no wharf call', async () => {
  configure(false);
  const first = await run(['man', 'helm', '--session', MAC, '--grounds', 'home']);
  expect(first.status, first.stderr).toBe(0);
  const second = await run(['man', 'helm', '--session', OTHER, '--grounds', 'work']);
  expect(second.status, second.stderr).toBe(0);
  expect(readHelm('home')?.sessionId).toBe(MAC);
  expect(readHelm('work')?.sessionId).toBe(OTHER);
  expect(first.stdout).not.toContain('slack:');
  expect(await takeMirrorSeat(loadConfig(), MAC, 'home', false)).toBeUndefined();
  expect(heard).toEqual([]);
});

it('hr-mac-seat: on a mirrored Mac, man helm takes the wharf seat for its session at sign-on', async () => {
  configure(true);
  const signed = await run(['man', 'helm', '--session', MAC, '--grounds', 'home']);
  expect(signed.status, signed.stderr).toBe(0);
  expect(heard).toEqual([{ method: 'POST', path: '/v1/accounts/acct/helm/take', body: { session: MAC, grounds: 'home', mirror: true, take: false } }]);
  expect(signed.stdout).toContain('slack: Slack DMs come to this helm');
  expect(readHelm('home')?.sessionId).toBe(MAC);
  // Another session here on the same grounds is refused here, before the wharf hears of it.
  const again = await run(['man', 'helm', '--session', OTHER, '--grounds', 'home']);
  expect(again.status).toBe(1);
  expect(again.stdout).toContain('is held by');
  expect(heard).toHaveLength(1);
});

it('hr-mac-seat: the daemon’s mirror takes the seat on its socket at its next read, within 30 seconds, and renews it while the helm is live', async () => {
  configure(true);
  // The wharf was away when the helm signed on: the sign-on stands.
  seatAnswer = () => ({ status: 503, value: { error: 'wharf unavailable' } });
  const signed = await run(['man', 'helm', '--session', MAC, '--grounds', 'home']);
  expect(signed.status, signed.stderr).toBe(0);
  expect(signed.stdout).toContain('slack: Slack DMs come to this helm once the wharf answers');
  let now = Date.now();
  const socket = new FakeSocket(), mirror = daemonMirror(socket, () => now);
  expect(await mirror.read()).toBeLessThanOrEqual(MIRROR_IDLE_READ_MS);
  expect(MIRROR_IDLE_READ_MS).toBeLessThanOrEqual(30_000);
  expect(seatTakes(socket)).toEqual([{ session: MAC, grounds: 'home', mirror: true }]);
  // Each read between renewals sends nothing; the lease is two minutes, renewed each minute.
  now += MIRROR_IDLE_READ_MS; await mirror.read();
  expect(seatTakes(socket)).toHaveLength(1);
  now += MIRROR_HELM_RENEW_MS; await mirror.read();
  expect(seatTakes(socket)).toHaveLength(2);
  // A helm that stepped down here holds nothing there.
  relieveHelm(MAC);
  now += MIRROR_HELM_RENEW_MS; await mirror.read();
  expect(seatTakes(socket)).toHaveLength(2);
});

it('hr-second: on a mirrored Mac, man helm is refused while another helm holds the wharf seat, naming it', async () => {
  configure(true);
  seatAnswer = () => ({ status: 409, value: { error: HELD, holder: { session: OTHER, boat: 'studio-mac' } } });
  const refused = await run(['man', 'helm', '--session', MAC, '--grounds', 'work']);
  expect(refused.status).toBe(1);
  // Errors go on stdout, for the agent that reads them.
  expect(refused.stdout).toContain(HELD);
  // Nothing signed on here.
  expect(readHelm('work')).toBeUndefined();
  expect(heard.map((r) => r.body)).toEqual([{ session: MAC, grounds: 'work', mirror: true, take: false }]);
});

it('hr-take: man helm --take takes the seat; a seat another helm took stands the local helm down, and its next park says so', async () => {
  configure(true);
  const taken = await run(['man', 'helm', '--session', MAC, '--grounds', 'home', '--take']);
  expect(taken.status, taken.stderr).toBe(0);
  expect(heard.map((r) => r.body)).toEqual([{ session: MAC, grounds: 'home', mirror: true, take: true }]);
  // Then a cloud session takes it with --take: the daemon's next renewal hears who holds it.
  const socket = new FakeSocket();
  socket.answer = () => ({ status: 409, value: { error: HELD, holder: { session: OTHER, boat: 'studio-mac' } } });
  await daemonMirror(socket, () => Date.now()).read();
  expect(helmOf(MAC)).toBeUndefined();
  const park = await run(['man', 'haul'], { session_id: MAC });
  expect(park.status, park.stderr).toBe(0);
  expect(JSON.parse(park.stdout)).toMatchObject({ decision: 'block', reason: expect.stringContaining('You were relieved of the helm for grounds "home" by session 8b7c6d5e') });
});

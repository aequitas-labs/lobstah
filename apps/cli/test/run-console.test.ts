import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { askDecision, ensureLayout, prepareRunCard, readDecisionAnswer } from '@lobstah/core';
import { serveGlass } from '../src/glass.js';
import { RunChallenges } from '../src/run-passkey.js';
import { RunRegistry } from '../src/run-exec.js';
import { SoftPasskey } from './fixtures/soft-passkey.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * Run cards, PR 4 (ume 3ef69c1d-026, intent run-console; relay picked in ume
 * 7ccec454-d66): a card posted with --interactive runs its script under a
 * terminal that expect(1) relays, and Chris answers its prompts a line at a
 * time from the card. A secret line is scrubbed like a declared input. The
 * checks need /usr/bin/expect.
 */

const SECRET = 'S3cr3t-VALUE-9f8e7d6c5b';

let home: string;
let outside: string;
let server: Server | undefined;
let port: number;
let runs: RunRegistry;
let passkey: SoftPasskey;
let logged: string[];

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-run-execute-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-run-outside-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  logged = [];
  for (const level of ['log', 'error', 'warn', 'info'] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
  runs = new RunRegistry();
  server = serveGlass(0, { runChallenges: new RunChallenges(), confirmPasskeyRegistration: async () => undefined, passkeysFile: path.join(home, 'run', 'passkeys.json'), runs });
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
  passkey = new SoftPasskey();
  const challenge = (await post('run-passkey-challenge', {})).json.challenge as string;
  expect((await post('run-passkey-register', passkey.register(challenge, origin()))).status).toBe(201);
});
afterEach(async () => {
  await runs.settled();
  vi.restoreAllMocks();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  removeTempDir(home);
  removeTempDir(outside);
  delete process.env.LOBSTAH_HOME;
});

const origin = () => `http://localhost:${port}`;

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

async function post(kind: string, payload: unknown) {
  const host = `localhost:${port}`;
  const token = (await call(host, '/data')).json.focusToken as string;
  return call(host, '/requests', { method: 'POST', body: { kind, payload }, headers: { Origin: `http://${host}`, 'x-lobstah-token': token } });
}

/** Post a run card for `script`, as `man ask --run` does. */
function card(script: string, opts: { inputs?: string[]; output?: string; timeout?: string; interactive?: boolean } = {}): { key: string; sha256: string } {
  const file = path.join(home, `s-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(file, script);
  const run = prepareRunCard({ scriptFile: file, cwd: outside, inputs: opts.inputs ?? [], output: opts.output, timeout: opts.timeout, interactive: opts.interactive });
  const { meta } = askDecision({ title: 'Run it', options: ['Decline'], askedBy: 'helm', run, maxBytes: 1 << 20 });
  return { key: meta.key, sha256: run.card.scriptSha256 };
}

/** Confirm with the passkey and run, as the card's Run button does. */
async function run(c: { key: string; sha256: string }, inputs: Record<string, string> = {}) {
  const challenge = (await post('run-challenge', c)).json.challenge as string;
  return post('run', { key: c.key, ...passkey.assert(challenge, origin()), inputs });
}

const answer = async (key: string) => {
  await runs.settled();
  return readDecisionAnswer(key)?.text ?? '';
};

/** Wait until the card's live output holds `text`. */
async function waitFor(key: string, text: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const out = (await post('run-output', { key, after: 0 })).json.text as string | undefined;
    if (out?.includes(text)) return out;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no "${text}" in the run's output`);
}

const line = (key: string, text: string, secret = false) => post('run-line', { key, line: text, secret });

describe.skipIf(process.platform === 'win32' || !fs.existsSync('/usr/bin/expect'))('a line console for prompting scripts', () => {
  it('answers a prompt with a line sent from the card, and the run exits 0', async () => {
    const c = card('#!/bin/bash\n[ -t 0 ] && echo "on a terminal"\nread -r -p "Deploy to production? (y/N) " a\n[ "$a" = y ] && echo deployed\n', { interactive: true, output: 'scrubbed' });
    expect((await run(c)).status).toBe(202);
    await waitFor(c.key, 'Deploy to production?');
    expect((await line(c.key, 'y')).status).toBe(200);
    await runs.settled();
    expect(runs.get(c.key)?.result).toMatchObject({ exitCode: 0, timedOut: false });
    const text = await answer(c.key);
    expect(text).toContain('on a terminal');
    expect(text).toContain('deployed');
  }, 15_000);

  it('scrubs a secret line, its echo included, from the card output and the answer', async () => {
    const c = card('#!/bin/bash\nread -r -p "Code: " code\necho "using $code"\n', { interactive: true, output: 'scrubbed' });
    await run(c);
    await waitFor(c.key, 'Code:');
    expect((await line(c.key, SECRET, true)).status).toBe(200);
    await runs.settled();
    const live = (await post('run-output', { key: c.key, after: 0 })).json.text as string;
    const text = await answer(c.key);
    for (const shown of [live, text]) {
      expect(shown).not.toContain(SECRET);
      expect(shown).toContain('using ‹secret›');
    }
  }, 15_000);

  it('gives the agent only the exit code from an interactive card posted without --output', async () => {
    const c = card('#!/bin/bash\nread -r -p "Name? " n\necho "hello $n"\n', { interactive: true });
    await run(c);
    await waitFor(c.key, 'Name?');
    await line(c.key, 'chris');
    const text = await answer(c.key);
    expect(text).toContain('exit 0');
    expect(text).toContain('Output withheld');
    expect(text).not.toContain('hello');
  }, 15_000);

  it("refuses a line for a run that has ended, or for another card's run, and writes nothing", async () => {
    const marker = path.join(outside, 'line');
    const waiting = card(`#!/bin/bash\nread -r -p "Line? " l\necho "$l" > "${marker}"\n`, { interactive: true });
    const other = card('#!/bin/bash\necho done\n', { interactive: true });
    await run(waiting);
    await waitFor(waiting.key, 'Line?');
    expect((await line(other.key, 'stray')).status).toBe(409);
    await line(waiting.key, 'first');
    await runs.settled();
    const late = await line(waiting.key, 'late');
    expect(late.status).toBe(409);
    expect(late.json.reason).toBe('That card has no run waiting for a line.');
    expect(fs.readFileSync(marker, 'utf8')).toBe('first\n');
  }, 15_000);

  it('still gives a card without --interactive end-of-file after its declared inputs', async () => {
    const c = card('#!/bin/bash\nIFS= read -r A\nif IFS= read -r B; then echo "more: $B"; else echo eof; fi\n', { inputs: ['A'] });
    await run(c, { A: 'one' });
    expect(await answer(c.key)).toContain('eof');
    expect((await line(c.key, 'two')).status).toBe(409);
  });
});

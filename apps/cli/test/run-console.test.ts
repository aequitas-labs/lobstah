import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { askDecision, ensureLayout, listRequests, prepareRunCard, processStartedAt, readRunAttempt } from '@lobstah/core';
import { serveGlass } from '../src/glass.js';
import { RunChallenges } from '../src/run-passkey.js';
import { RunRegistry } from '../src/run-exec.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import { NOW } from './fixtures/glass-snapshots.js';
import { RUN_KEY, glassRun, runCardFleet } from './fixtures/run-card.js';
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
  return listRequests({ kind: 'decision-answer' }).filter((request) => request.payload.key === key).at(-1)?.payload.text as string ?? '';
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

  it('gives the agent what the terminal showed: no escape codes, the prompt answered, the spinner gone, emoji intact', async () => {
    // A prompt library's shape: a colored question, then cursor up and erase to redraw it answered; then a spinner.
    const script = [
      '#!/bin/bash',
      "printf '\\033[36m?\\033[39m \\033[1mApply 2 migrations?\\033[22m (Y/n) '",
      'read -r a',
      "printf '\\033[1A\\033[2K\\033[1G\\033[32m✔\\033[39m Apply 2 migrations? … %s\\n' \"$a\"",
      "for f in ⠋ ⠙ ⠹; do printf '\\033[1G\\033[0K%s' \"$f\"; done",
      "printf '\\033[1G\\033[0K🪵 Logs written\\n'",
      '',
    ].join('\n');
    const c = card(script, { interactive: true, output: 'scrubbed' });
    await run(c);
    await waitFor(c.key, 'Apply 2 migrations?');
    expect((await line(c.key, 'yes')).status).toBe(200);
    await runs.settled();
    const text = await answer(c.key);
    expect(text).not.toMatch(/[\x1b\r]/);
    expect(text).toContain('✔ Apply 2 migrations? … yes\n🪵 Logs written');
    expect(text).not.toContain('(Y/n)');
    expect(text).not.toContain('⠙');
    // The raw stream stays as it was, for the card's view and the output.log.
    const raw = (await post('run-output', { key: c.key, after: 0 })).json.text as string;
    expect(raw).toContain('\x1b[32m✔');
    expect(raw).toContain('🪵');
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

  it('keeps a secret line out of everything the server keeps: files, logs, the snapshot and the answer', async () => {
    const c = card('#!/bin/bash\nread -r -p "Token: " t\necho "got $t"\nprintf %s "$t" | base64\n', { interactive: true, output: 'scrubbed' });
    await run(c);
    await waitFor(c.key, 'Token:');
    expect((await line(c.key, SECRET, true)).status).toBe(200);
    await runs.settled();
    const forms = [SECRET, Buffer.from(SECRET).toString('base64')];
    // Every file under the lobstah home: the decision, its answer, the run audit, the logs.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(home);
    expect(files.some((f) => f.endsWith('audit.jsonl'))).toBe(true);
    for (const f of files) for (const form of forms) expect(fs.readFileSync(f, 'utf8').includes(form), `${form} in ${f}`).toBe(false);
    const kept = [await answer(c.key), JSON.stringify((await call(`localhost:${port}`, '/data')).json), (await post('run-output', { key: c.key, after: 0 })).json.text as string, logged.join('\n')];
    for (const text of kept) for (const form of forms) expect(text).not.toContain(form);
    expect(await answer(c.key)).toContain('got ‹secret›');
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

  it('stops the terminal script and its background child as one run', async () => {
    const childFile = path.join(outside, 'interactive-child.pid');
    const c = card(`#!/bin/bash\nsleep 30 &\necho "$!" > "${childFile}"\nread -r -p "Waiting: " value\nwait\n`, { interactive: true });
    await run(c);
    await waitFor(c.key, 'Waiting:');
    const childPid = Number(fs.readFileSync(childFile, 'utf8'));
    expect((await post('run-stop', { key: c.key })).status).toBe(202);
    await runs.settled();
    expect(readRunAttempt(c.key)).toMatchObject({ state: 'stopped', result: { exitCode: 130 } });
    expect(processStartedAt(childPid)).toBeUndefined();
  }, 15000);
});

/**
 * The eye on a secret line (dispatch c33b3ca5): the console field shows its
 * value before it is sent, and each secret line sent from this tab can be
 * shown again from the tab's memory. It is never stored, and a reload has
 * none. The page runs in happy-dom on localhost with a stand-in passkey; the
 * server's side is the stand-in below.
 */
describe('the eye on a secret line', () => {
  const TOKEN = 'pk_live_51HqLyjWDarjtT1zdp7dc';

  async function console_() {
    let sent = false;
    let stopped = false;
    const fleet = runCardFleet(glassRun('#!/bin/bash\nread -r -s -p "Token: " t\n', { inputs: [], interactive: true }));
    fleet.runPasskeys = { count: 1 };
    const g = await loadGlass(GLASS_PAGE, fleet, {
      now: NOW,
      host: 'localhost:7777',
      hash: `#decision/${encodeURIComponent(RUN_KEY)}`,
      prepare: (w) => {
        const buf = () => new Uint8Array([1, 2, 3]).buffer;
        Object.defineProperty(w, 'PublicKeyCredential', { value: class {}, configurable: true });
        Object.defineProperty(w.navigator, 'credentials', {
          value: { get: async () => ({ rawId: buf(), response: { clientDataJSON: buf(), authenticatorData: buf(), signature: buf() } }) },
          configurable: true,
        });
      },
      post: (_url, req) => {
        const { kind, payload } = JSON.parse(req.body) as { kind: string; payload: { line?: string } };
        if (kind === 'run-challenge') return { status: 200, body: { ok: true, challenge: 'AAAA', rpId: 'localhost', credentialIds: [] } };
        if (kind === 'run') return { status: 202, body: { ok: true } };
        if (kind === 'run-line') {
          sent = true;
          return { status: 200, body: { ok: true } };
        }
        if (kind === 'run-stop') {
          stopped = true;
          return { status: 202, body: { ok: true } };
        }
        if (kind === 'run-output')
          return { status: 200, body: { ok: true, text: '', next: 0, ...(sent || stopped ? { result: { exitCode: stopped ? 130 : 0, stopped, timedOut: false, durationMs: 900, scrubbed: 1 } } : {}) } };
        return { status: 404, body: { ok: false } };
      },
    });
    return g;
  }
  /** Wait for `sel` without settling: the run's output poll keeps a timer pending while it runs. */
  async function until<T>(get: () => T | null | undefined | false): Promise<T> {
    for (let i = 0; i < 100; i++) {
      const got = get();
      if (got) return got;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error('timed out');
  }

  it('shows Stop while running, then Run again and Dismiss after stopping', async () => {
    const glass = await console_();
    try {
      (glass.$('#doverlay .runbtn') as HTMLButtonElement).click();
      const stop = await until(() => glass.$$('#doverlay .runfoot button').find((button) => button.textContent === 'Stop') as HTMLButtonElement | undefined);
      stop.click();
      await until(() => glass.$('#doverlay .runstate .runicon')?.getAttribute('aria-label')?.startsWith('Stopped'));
      expect(glass.$('#doverlay .runbtn')?.textContent).toBe('Run again');
      expect(glass.$$('#doverlay .runfoot button').some((button) => button.textContent === 'Dismiss')).toBe(true);
    } finally {
      await glass.close();
    }
  });

  it('shows the typed secret and each sent one only on asking, and keeps it nowhere', async () => {
    const g = await console_();
    try {
      (g.$('#doverlay .runbtn') as HTMLButtonElement).click();
      const field = await until(() => g.$('#doverlay .runlinein') as HTMLInputElement | null);
      expect(g.$('#doverlay .runconsole .runeye')).toBeNull();
      (g.$('#doverlay .runsecret') as HTMLButtonElement).click();
      const eye = await until(() => g.$('#doverlay .runconsole .runeye') as HTMLButtonElement | null);
      field.value = TOKEN;
      field.dispatchEvent(new g.window.Event('input', { bubbles: true }) as unknown as Event);
      await until(() => (g.$('#doverlay .runlinein') as HTMLInputElement).getAttribute('type') === 'password');
      expect(eye.getAttribute('aria-label')).toBe('Show secret');
      eye.click();
      await until(() => (g.$('#doverlay .runlinein') as HTMLInputElement).getAttribute('type') === 'text');
      expect(g.$('#doverlay .runconsole .runeye')!.getAttribute('aria-label')).toBe('Hide secret');
      g.$('#doverlay .runlinein')!.dispatchEvent(new g.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as Event);
      const row = await until(() => g.$('#doverlay .runsent li'));
      await until(() => g.$('#doverlay .runstate .ok'));
      // Sent: masked by default, the same mask whatever its length, and its own eye shows it.
      expect(row.querySelector('.runsentval')!.textContent).toBe('••••••••');
      expect(g.$('#doverlay .runcard')!.textContent).not.toContain(TOKEN);
      const rowEye = row.querySelector('.runeye') as HTMLButtonElement;
      expect(rowEye.getAttribute('aria-label')).toBe('Show secret');
      rowEye.click();
      await until(() => g.$('#doverlay .runsent .runsentval')!.textContent === TOKEN);
      expect(g.$('#doverlay .runsent .runeye')!.getAttribute('aria-label')).toBe('Hide secret');
      (g.$('#doverlay .runsent .runeye') as HTMLButtonElement).click();
      await until(() => g.$('#doverlay .runsent .runsentval')!.textContent === '••••••••');
      // Only the request that sent the line carries it; no storage, URL or other request does.
      const carrying = g.posts().filter((p) => p.body.includes(TOKEN));
      expect(carrying.map((p) => (JSON.parse(p.body) as { kind: string }).kind)).toEqual(['run-line']);
      const stored = [g.window.localStorage, g.window.sessionStorage].flatMap((st) => Array.from({ length: st.length }, (_, i) => st.getItem(st.key(i)!) ?? ''));
      for (const v of [...stored, g.window.location.href, ...g.dataFetches()]) expect(v).not.toContain(TOKEN);
    } finally {
      await g.close();
    }
  });

  it('has no sent secret and no eye after a reload', async () => {
    const g = await console_();
    try {
      expect(g.$('#doverlay .runcard')).not.toBeNull();
      expect(g.$('#doverlay .runsent')).toBeNull();
      expect(g.$('#doverlay .runeye')).toBeNull();
    } finally {
      await g.close();
    }
  });
});

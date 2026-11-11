import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { askDecision, decisionDir, ensureLayout, listRequests, prepareRunCard, processStartedAt, readDecision, readDecisionAnswer, readRunAttempt, readRunAudit, readRunOutput, withdrawDecision, writeRunAttempt } from '@lobstah/core';
import { serveGlass } from '../src/glass.js';
import { RunChallenges } from '../src/run-passkey.js';
import { RunRegistry, runEnvironment } from '../src/run-exec.js';
import { SoftPasskey } from './fixtures/soft-passkey.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * Run cards, PR 3 (ume 3ef69c1d-026, intent run-execute): a Run confirmed
 * with the passkey runs the card's stored script under bash, with the typed
 * inputs on stdin only, and its scrubbed output answers the card. The checks
 * run real scripts, so they need /bin/bash (not on Windows).
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
function card(script: string, opts: { inputs?: string[]; output?: string; timeout?: string } = {}): { key: string; sha256: string } {
  const file = path.join(home, `s-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(file, script);
  const run = prepareRunCard({ scriptFile: file, cwd: outside, inputs: opts.inputs ?? [], output: opts.output, timeout: opts.timeout });
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

/** Every file under a directory, read as text. */
function everyFile(dir: string): Array<{ file: string; text: string }> {
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).map((e) => {
    const file = path.join(e.parentPath, e.name);
    return { file, text: fs.readFileSync(file, 'latin1') };
  });
}

describe.skipIf(process.platform === 'win32')('running a run card', () => {
  it('leaves no trace of a secret input: not in the lobstah home, the glass log, or the child process argv or environment', async () => {
    const c = card(
      `#!/bin/bash
env > "${outside}/env.txt"
ps -o args= -p $$ > "${outside}/args.txt"
IFS= read -r CRON_SECRET
echo "read \${#CRON_SECRET} characters"
`,
      { inputs: ['CRON_SECRET'] },
    );
    expect((await run(c, { CRON_SECRET: SECRET })).status).toBe(202);
    expect(await answer(c.key)).toContain(`read ${SECRET.length} characters`);
    expect(fs.readFileSync(path.join(outside, 'env.txt'), 'utf8')).not.toContain(SECRET);
    expect(fs.readFileSync(path.join(outside, 'args.txt'), 'utf8')).not.toContain(SECRET);
    for (const { file, text } of everyFile(home)) expect(text, file).not.toContain(SECRET);
    expect(logged.join('\n')).not.toContain(SECRET);
  });

  it('gives the run only PATH, HOME, USER, LANG and TMPDIR', async () => {
    const c = card(`#!/bin/bash\nenv | cut -d= -f1 | sort > "${outside}/names.txt"\n`);
    await run(c);
    await runs.settled();
    const names = fs.readFileSync(path.join(outside, 'names.txt'), 'utf8').trim().split('\n');
    expect(names.filter((n) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(n)).sort()).toEqual(Object.keys(runEnvironment()).sort());
  });

  it('scrubs a secret printed across two chunks, and its base64 form, from the answer', async () => {
    const c = card(
      `#!/bin/bash
IFS= read -r S
printf '%s' "\${S:0:6}"
sleep 0.3
printf '%s\\n' "\${S:6}"
printf '%s' "$S" | base64
`,
      { inputs: ['S'] },
    );
    await run(c, { S: SECRET });
    const text = await answer(c.key);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(Buffer.from(SECRET).toString('base64'));
    expect(text.match(/‹S›/g)).toHaveLength(2);
  });

  it('refuses to run a stored copy that no longer hashes to the card, and spawns nothing', async () => {
    const marker = path.join(outside, 'ran');
    const c = card(`#!/bin/bash\ntouch "${marker}"\n`);
    const challenge = (await post('run-challenge', c)).json.challenge as string;
    fs.writeFileSync(path.join(decisionDir(c.key)!, 'run', 'script'), `#!/bin/bash\ntouch "${marker}"\necho changed\n`);
    const res = await post('run', { key: c.key, ...passkey.assert(challenge, origin()), inputs: {} });
    expect(res.status).toBe(409);
    await runs.settled();
    expect(fs.existsSync(marker)).toBe(false);
    expect(readDecisionAnswer(c.key)).toBeUndefined();
  });

  it('answers a card posted with --output exit with the exit code and no output text', async () => {
    const c = card('#!/bin/bash\necho visible-line\nexit 3\n', { output: 'exit' });
    await run(c);
    const text = await answer(c.key);
    expect(text).toContain('exit 3');
    expect(text).toContain('Output withheld');
    expect(text).not.toContain('visible-line');
  });

  it('appends one audit line per run, chained to the one before, with no input or output in it', async () => {
    const first = card('#!/bin/bash\nIFS= read -r T\necho one\n', { inputs: ['T'] });
    await run(first, { T: SECRET });
    await runs.settled();
    const second = card('#!/bin/bash\nexit 2\n');
    await run(second);
    await runs.settled();
    const { entries, intact } = readRunAudit();
    expect(intact).toBe(true);
    expect(entries.map((e) => [e.key, e.scriptSha256, e.exitCode])).toEqual([
      [first.key, first.sha256, 0],
      [second.key, second.sha256, 2],
    ]);
    expect(entries[0]!.prev).toBe('genesis');
    expect(entries[1]!.prev).toBe(entries[0]!.hash);
    expect(fs.readFileSync(path.join(home, 'run', 'audit.jsonl'), 'utf8')).not.toMatch(new RegExp(`${SECRET}|one`));
  });

  it('refuses a Run with a valid page token and Origin but no passkey assertion, and spawns nothing', async () => {
    const marker = path.join(outside, 'ran');
    const c = card(`#!/bin/bash\ntouch "${marker}"\n`);
    const res = await post('run', { key: c.key, inputs: {} });
    expect(res.status).toBe(403);
    expect(res.json.reason).toBe('a passkey assertion is required');
    const forged = await post('run', { key: c.key, credentialId: 'AAAA', clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA', inputs: {} });
    expect(forged.status).toBe(403);
    await runs.settled();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('kills a run past its time limit, process group and all, within 5 seconds, and records exit 124', async () => {
    const c = card(`#!/bin/bash\ntrap '' TERM\nsleep 30 &\nwait\n`, { timeout: '1' });
    const start = Date.now();
    await run(c);
    await runs.settled();
    expect(Date.now() - start).toBeLessThan(1_000 + 5_000);
    expect(readRunAudit().entries.at(-1)).toMatchObject({ key: c.key, exitCode: 124, timedOut: true });
    expect(await answer(c.key)).toContain('timed out');
    expect(readRunAttempt(c.key)).toMatchObject({ state: 'failed', result: { exitCode: 124, timedOut: true } });
    expect(listRequests({ kind: 'decision-answer' }).at(-1)?.payload.run).toMatchObject({ state: 'failed', exitCode: 124 });
  }, 15_000);

  it('refuses inputs the card does not declare, a missing one, or one with a newline', async () => {
    const c = card('#!/bin/bash\nIFS= read -r A\n', { inputs: ['A'] });
    expect((await run(c, {})).json.reason).toBe('A is required.');
    expect((await run(c, { A: 'one\ntwo' })).json.reason).toBe('A must be one line.');
    expect((await run(c, { A: 'x', B: 'y' })).json.reason).toBe('An input the card does not declare was sent.');
    expect(readDecisionAnswer(c.key)).toBeUndefined();
  });

  it('streams the scrubbed output to the card while it runs, then its result', async () => {
    const c = card('#!/bin/bash\nIFS= read -r K\necho "key is $K"\n', { inputs: ['K'] });
    await run(c, { K: SECRET });
    await runs.settled();
    const res = await post('run-output', { key: c.key, after: 0 });
    expect(res.json.text).toBe('key is ‹K›\n');
    expect(res.json.result).toMatchObject({ exitCode: 0, timedOut: false, scrubbed: 1 });
    // A finished attempt stays available for another passkey-confirmed run.
    const again = await post('run-challenge', c);
    expect(again.status).toBe(200);
    expect(readDecision(c.key)).toBeDefined();
    expect(readDecisionAnswer(c.key)).toBeUndefined();
  });

  it('persists a failed attempt and its local output while withholding exit-mode output from the helm', async () => {
    const c = card('#!/bin/bash\nprintf "local-%s-detail\\n" failure\nexit 3\n', { output: 'exit' });
    await run(c);
    await runs.settled();
    const attempt = readRunAttempt(c.key)!;
    expect(attempt).toMatchObject({ key: c.key, scriptSha256: c.sha256, state: 'failed', result: { exitCode: 3 } });
    expect(Date.parse(attempt.finishedAt!)).toBeGreaterThanOrEqual(Date.parse(attempt.startedAt));
    expect(readRunOutput(attempt)).toContain('local-failure-detail');
    const reloaded = new RunRegistry().get(c.key)!;
    expect(reloaded.result?.exitCode).toBe(3);
    expect(reloaded.output).toContain('local-failure-detail');
    const event = listRequests({ kind: 'decision-answer' }).at(-1)!;
    expect(event.payload.run).toMatchObject({ id: attempt.id, state: 'failed', exitCode: 3, tail: '' });
    expect(JSON.stringify(event)).not.toContain('local-failure-detail');
    const snapshot = (await call(`localhost:${port}`, '/data')).json;
    expect(JSON.stringify(snapshot)).not.toContain('local-failure-detail');
  });

  it('retries the same script as a new attempt, keeps both histories, and dismisses only after it ends', async () => {
    const c = card('#!/bin/bash\necho hello\n');
    await run(c);
    await runs.settled();
    const first = readRunAttempt(c.key)!;
    expect(first.state).toBe('succeeded');
    expect((await run(c)).status).toBe(202);
    await runs.settled();
    const second = readRunAttempt(c.key)!;
    expect(second.id).not.toBe(first.id);
    expect(second.scriptSha256).toBe(first.scriptSha256);
    expect(fs.existsSync(path.join(decisionDir(c.key)!, 'run', first.id, 'state.json'))).toBe(true);
    expect(listRequests({ kind: 'decision-answer' }).filter((event) => event.payload.key === c.key)).toHaveLength(2);
    expect((await post('run-dismiss', { key: c.key })).status).toBe(200);
    expect(readDecision(c.key)).toBeUndefined();
    expect(readRunAttempt(c.key)?.id).toBe(second.id);
    expect((await post('run-challenge', c)).status).toBe(404);
  });

  it('stops a running process group, records stopped, and wakes the helm', async () => {
    const c = card(`#!/bin/bash\nsleep 30 &\necho "$!" > "${outside}/child.pid"\nwait\n`);
    await run(c);
    for (let index = 0; index < 100 && !fs.existsSync(path.join(outside, 'child.pid')); index++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readRunAttempt(c.key)?.state).toBe('running');
    expect((await run(c)).status).toBe(409);
    expect((await post('run-dismiss', { key: c.key })).status).toBe(409);
    expect((await post('run-stop', { key: c.key })).status).toBe(202);
    await runs.settled();
    expect(readRunAttempt(c.key)).toMatchObject({ state: 'stopped', result: { exitCode: 130, stopped: true } });
    const childPid = Number(fs.readFileSync(path.join(outside, 'child.pid'), 'utf8'));
    expect(processStartedAt(childPid)).toBeUndefined();
    expect(listRequests({ kind: 'decision-answer' }).at(-1)?.payload.run).toMatchObject({ state: 'stopped', exitCode: 130 });
  });

  it('records completion and delivers an event even if the helm withdraws the card during the run', async () => {
    const c = card('#!/bin/bash\nsleep 0.1\necho finished-after-withdrawal\nexit 2\n');
    await run(c);
    withdrawDecision(c.key);
    await runs.settled();
    expect(readRunAttempt(c.key)).toMatchObject({ state: 'failed', result: { exitCode: 2 } });
    expect(listRequests({ kind: 'decision-answer' }).at(-1)?.payload.run).toMatchObject({ state: 'failed', exitCode: 2, tail: expect.stringContaining('finished-after-withdrawal') });
  });

  it('delivers long output within the decision-answer size limit', async () => {
    const c = card('#!/bin/bash\nfor ((i=0;i<30000;i++)); do printf x; done\n');
    await run(c);
    await runs.settled();
    expect((await answer(c.key)).length).toBeLessThan(20000);
    expect(listRequests({ kind: 'decision-answer' }).at(-1)?.payload.run).toMatchObject({ state: 'succeeded', exitCode: 0 });
  });

  it('recovers a run whose glass owner is gone as a durable failure, once', async () => {
    const c = card('#!/bin/bash\necho unused\n');
    writeRunAttempt({ id: '11111111-1111-4111-8111-111111111111', key: c.key, scriptSha256: c.sha256,
      state: 'running', startedAt: new Date().toISOString(), owner: { pid: process.pid, startedAt: 'previous process at this pid' },
      processes: [{ pid: process.pid, startedAt: 'previous process at this pid' }] }, 'previous output\n');
    const registry = new RunRegistry();
    registry.get(c.key);
    await registry.settled();
    expect(readRunAttempt(c.key)).toMatchObject({ state: 'failed', result: { exitCode: 1, interrupted: true } });
    expect(listRequests({ kind: 'decision-answer' }).filter((event) => event.payload.key === c.key)).toHaveLength(1);
    expect(new RunRegistry().get(c.key)?.result?.interrupted).toBe(true);
    expect(listRequests({ kind: 'decision-answer' }).filter((event) => event.payload.key === c.key)).toHaveLength(1);
  });

  it('records a spawn failure and wakes the helm with the failure state', async () => {
    const c = card('#!/bin/bash\necho unused\n');
    fs.rmdirSync(outside);
    expect((await run(c)).status).toBe(202);
    await runs.settled();
    expect(readRunAttempt(c.key)).toMatchObject({ state: 'failed', result: { exitCode: 127 } });
    expect(await answer(c.key)).toContain('could not start');
  });

  it('keeps a bounded local tail and restores its stream offset after a reload', async () => {
    const c = card('#!/bin/bash\nfor ((i=0;i<220;i++)); do printf "line-%s\\n" "$i"; done\n');
    await run(c);
    await runs.settled();
    const attempt = readRunAttempt(c.key)!;
    const output = readRunOutput(attempt);
    expect(output).not.toContain('line-0\n');
    expect(output).toContain('line-219\n');
    expect(output.trim().split('\n')).toHaveLength(200);
    const restored = new RunRegistry().get(c.key)!;
    expect(restored.dropped + restored.output.length).toBe(attempt.outputChars);
  });
});

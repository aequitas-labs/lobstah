import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  appendStatus,
  decisionDir,
  decisionsRoot,
  enqueue,
  ensureLayout,
  executorPath,
  listDecisions,
  readDecision,
  readDecisionAnswer,
  readDecisionDetail,
  takeDecisionAnswers,
} from '@lobstah/core';
import { buildTendReport } from '../src/tend.js';
import { planCull } from '../src/cull.js';
import { buildGlassSnapshot, serveGlass } from '../src/glass.js';

/**
 * Decisions end to end: `man ask` stores one, a newer ask replaces it,
 * `--withdraw` removes it, and a framed decision hides the raw question on
 * its dispatch. The glass's POST answers one (and refuses what it must),
 * and `man wait` delivers exactly one decision-answered event.
 */

// Against the built CLI (`pnpm build` runs before `pnpm test`).
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));

const A = 'aaaaaaaa-1111-4000-8000-000000000001';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let home: string;
let src: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-decisions-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(executorPath(), JSON.stringify({ heartbeat: new Date().toISOString() }));
  src = path.join(home, 'src');
  fs.mkdirSync(src);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

function lobstah(...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 15_000 });
}
const write = (name: string, body: string | Buffer) => {
  const file = path.join(src, name);
  fs.writeFileSync(file, body);
  return file;
};
const keyOf = (stdout: string) => /^key: (decision:[a-f0-9]{8})$/m.exec(stdout)?.[1];
/** A dispatch whose worker asked a question. */
function question(note = 'which schema?') {
  enqueue({ id: A, repo: 'web', brief: 'b' });
  appendStatus(A, 'work', 'needs-decision', note, new Date(Date.now() - 60_000).toISOString());
}

describe('man ask', () => {
  it('stores the record: title, detail, options, attachments, the dispatch, who asked, and when', () => {
    question();
    const res = lobstah(
      'man', 'ask', A,
      '--title', 'Which schema should the tray use?',
      '--detail', write('d.md', '# Context\n\n![tray](tray.png)\n'),
      '--option', 'v1', '--option', 'v2',
      '--attach', write('tray.png', PNG),
    );
    expect(res.status, res.stderr).toBe(0);
    const key = keyOf(res.stdout)!;
    expect(key).toBeDefined();
    expect(readDecision(key)).toMatchObject({
      key,
      title: 'Which schema should the tray use?',
      options: ['v1', 'v2'],
      dispatch: A,
      lane: 'work',
      repo: 'web',
      askedBy: 'helm',
    });
    expect(readDecision(key)!.attachments.map((a) => a.name)).toEqual(['tray.png']);
    expect(Date.parse(readDecision(key)!.askedAt)).toBeGreaterThan(0);
    expect(readDecisionDetail(key)).toContain('# Context');
    expect(fs.existsSync(path.join(decisionDir(key)!, 'attachments', 'tray.png'))).toBe(true);
    expect(decisionDir(key)!.startsWith(decisionsRoot())).toBe(true);
    const item = buildTendReport().attention.find((a) => a.key === key);
    expect(item).toMatchObject({ kind: 'decision', id: A, note: 'Which schema should the tray use?', repo: 'web' });
  });

  it('asks about no dispatch too, and takes no more than six options', () => {
    const ok = lobstah('man', 'ask', '--title', 'Cut 0.6.0?');
    expect(ok.status, ok.stderr).toBe(0);
    const key = keyOf(ok.stdout)!;
    expect(readDecision(key)).toMatchObject({ title: 'Cut 0.6.0?', options: [] });
    expect(readDecision(key)!.dispatch).toBeUndefined();
    const seven = lobstah('man', 'ask', '--title', 'too many', ...['1', '2', '3', '4', '5', '6', '7'].flatMap((o) => ['--option', o]));
    expect(seven.status).toBe(2);
    expect(seven.stdout + seven.stderr).toContain('at most 6 options');
    expect(lobstah('man', 'ask').status).toBe(2);
  });

  it('a newer ask on the same dispatch replaces the older one', () => {
    question();
    const first = keyOf(lobstah('man', 'ask', A, '--title', 'first framing').stdout)!;
    const second = lobstah('man', 'ask', A, '--title', 'second framing');
    expect(second.stdout).toContain(`replaced: ${first}`);
    expect(readDecision(first)).toBeUndefined();
    expect(listDecisions().map((d) => d.title)).toEqual(['second framing']);
    // A decision about no dispatch is never replaced.
    lobstah('man', 'ask', '--title', 'Cut 0.6.0?');
    lobstah('man', 'ask', '--title', 'Rename the pet?');
    expect(listDecisions().map((d) => d.title).sort()).toEqual(['Cut 0.6.0?', 'Rename the pet?', 'second framing']);
  });

  it('--withdraw removes it', () => {
    const key = keyOf(lobstah('man', 'ask', '--title', 'Cut 0.6.0?').stdout)!;
    const res = lobstah('man', 'ask', '--withdraw', key);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('withdrawn: true');
    expect(fs.existsSync(decisionDir(key)!)).toBe(false);
    expect(buildTendReport().attention.some((a) => a.key === key)).toBe(false);
    expect(lobstah('man', 'ask', '--withdraw', key).status).toBe(2);
  });

  it("a framed decision hides the raw question on the same dispatch; withdrawing it shows the question again", () => {
    question();
    const kinds = () => buildTendReport().attention.filter((a) => a.id === A || a.kind === 'decision').map((a) => a.kind);
    expect(kinds()).toEqual(['question']);
    const key = keyOf(lobstah('man', 'ask', A, '--title', 'Which schema?').stdout)!;
    expect(kinds()).toEqual(['decision']);
    expect(buildTendReport().verdict).toBe('needs-attention');
    lobstah('man', 'ask', '--withdraw', key);
    expect(kinds()).toEqual(['question']);
  });

  it('the decision kind is in the default attention kinds; removing it walks the raw question', () => {
    question();
    lobstah('man', 'ask', A, '--title', 'Which schema?');
    fs.writeFileSync(path.join(home, 'config.toml'), 'attentionKinds = ["question"]\n');
    expect(buildTendReport().attention.map((a) => a.kind)).toEqual(['question']);
  });
});

describe('man answer and the decision-answered event', () => {
  it('writes the answer; man wait delivers one decision-answered event with the key, dispatch, option, text, and files', () => {
    question();
    const key = keyOf(lobstah('man', 'ask', A, '--title', 'Which schema?', '--option', 'v1', '--option', 'v2').stdout)!;
    const res = lobstah('man', 'answer', key, '--option', 'v2', '--text', 'and keep v1 readable', '--attach', write('shot.png', PNG));
    expect(res.status, res.stderr).toBe(0);
    const answer = readDecisionAnswer(key)!;
    expect(answer).toMatchObject({ option: 'v2', text: 'and keep v1 readable', by: 'terminal' });
    const stored = path.join(decisionDir(key)!, 'answer', 'shot.png');
    expect(answer.attachments.map((a) => a.path)).toEqual([stored]);
    // Answered: no longer attention, and the question stays hidden until the helm sends it on.
    expect(buildTendReport().attention.filter((a) => a.id === A || a.key === key)).toEqual([]);

    const wait = lobstah('man', 'wait', '--timeout', '1');
    expect(wait.status, wait.stderr).toBe(0);
    expect(wait.stdout).toContain('event: decision-answered');
    expect(wait.stdout).toContain(key);
    expect(wait.stdout).toContain(`dispatch: ${A}`);
    expect(wait.stdout).toContain('option: v2');
    expect(wait.stdout).toContain('text: and keep v1 readable');
    expect(wait.stdout).toContain(stored);
    // Delivered once.
    const again = lobstah('man', 'wait', '--timeout', '1');
    expect(again.stdout).not.toContain('decision-answered');
  });

  it('refuses a second answer, an option not in the record, and an empty answer', () => {
    const key = keyOf(lobstah('man', 'ask', '--title', 'Cut 0.6.0?', '--option', 'yes', '--option', 'no').stdout)!;
    expect(lobstah('man', 'answer', key, '--option', 'maybe').status).toBe(2);
    expect(lobstah('man', 'answer', key).status).toBe(2);
    expect(lobstah('man', 'answer', 'decision:00000000', '--text', 'hi').status).toBe(2);
    expect(lobstah('man', 'answer', key, '--option', 'yes').status).toBe(0);
    expect(lobstah('man', 'answer', key, '--option', 'no').status).toBe(2);
    expect(readDecisionAnswer(key)!.option).toBe('yes');
  });

  it("answers a raw question by its key: framed as the worker's decision, then answered", () => {
    question('which schema, v1 or v2?');
    const res = lobstah('man', 'answer', `work:${A}`, '--text', 'v2');
    expect(res.status, res.stderr).toBe(0);
    const [d] = listDecisions();
    expect(d).toMatchObject({ title: 'which schema, v1 or v2?', askedBy: 'worker', dispatch: A });
    expect(readDecisionAnswer(d!.key)).toMatchObject({ text: 'v2' });
    expect(buildTendReport().attention.some((a) => a.id === A)).toBe(false);
    const [event] = takeDecisionAnswers(true);
    expect(event).toMatchObject({ decision: { dispatch: A }, answer: { text: 'v2' } });
  });
});

describe('the Stop hook and cull', () => {
  it('man haul wakes an idle helm with the answered decision, once', () => {
    const key = keyOf(lobstah('man', 'ask', '--title', 'Cut 0.6.0?', '--option', 'yes', '--option', 'no').stdout)!;
    expect(lobstah('man', 'answer', key, '--option', 'yes').status).toBe(0);
    const haul = () =>
      spawnSync(process.execPath, [cli, 'man', 'haul', '--park', '--timeout', '1'], {
        encoding: 'utf8',
        env: { ...process.env, LOBSTAH_HOME: home, LOBSTAH_MAN: '1' },
        input: JSON.stringify({ session_id: 'helm-session' }),
        timeout: 15_000,
      });
    const first = haul();
    expect(first.status, first.stderr).toBe(0);
    const block = JSON.parse(first.stdout) as { decision: string; reason: string };
    expect(block.decision).toBe('block');
    expect(block.reason).toContain(`decision-answered ${key}`);
    expect(block.reason).toContain('option "yes"');
    expect(haul().stdout.trim()).toBe('');
  });

  it('cull removes a decision once it is answered, delivered, and older than the window; never a standing one', () => {
    const standing = keyOf(lobstah('man', 'ask', '--title', 'still open').stdout)!;
    const answered = keyOf(lobstah('man', 'ask', '--title', 'answered').stdout)!;
    lobstah('man', 'answer', answered, '--text', 'done');
    const later = Date.now() + 30 * 86_400_000;
    expect(planCull(14, later).filter((i) => i.kind === 'decision')).toEqual([]);
    takeDecisionAnswers(true);
    expect(planCull(14, later).filter((i) => i.kind === 'decision').map((i) => i.id)).toEqual([answered]);
    expect(planCull(14, Date.now()).filter((i) => i.kind === 'decision')).toEqual([]);
    expect(readDecision(standing)).toBeDefined();
  });
});

describe('the glass answer POST', () => {
  let server: Server | undefined;
  let base: string;
  let token: string;
  beforeEach(async () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[limits]\nattachmentMaxBytes = 64\n');
    server = serveGlass(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    token = ((await (await fetch(`${base}/data`)).json()) as { focusToken: string }).focusToken;
  });
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });
  const post = (key: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/decision/${encodeURIComponent(key)}/answer`, {
      method: 'POST',
      headers: { Origin: base, 'content-type': 'application/json', 'x-lobstah-focus-token': token, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const ask = () => keyOf(lobstah('man', 'ask', '--title', 'Cut 0.6.0?', '--option', 'yes', '--option', 'no').stdout)!;

  it('rejects a missing or wrong token and a foreign origin', async () => {
    const key = ask();
    const missing = await fetch(`${base}/api/decision/${encodeURIComponent(key)}/answer`, {
      method: 'POST',
      headers: { Origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ option: 'yes' }),
    });
    expect(missing.status).toBe(403);
    expect((await post(key, { option: 'yes' }, { 'x-lobstah-focus-token': 'wrong' })).status).toBe(403);
    expect((await post(key, { option: 'yes' }, { Origin: 'http://evil.example' })).status).toBe(403);
    expect(readDecisionAnswer(key)).toBeUndefined();
  });

  it('rejects an unknown key, an option not in the record, oversized text, and oversized or refused files', async () => {
    const key = ask();
    expect((await post('decision:00000000', { option: 'yes' })).status).toBe(404);
    expect((await post('../../etc', { option: 'yes' })).status).toBe(404);
    const option = await post(key, { option: 'maybe' });
    expect(option.status).toBe(400);
    expect(((await option.json()) as { reason: string }).reason).toContain('not an option');
    expect((await post(key, { text: 'x'.repeat(20_001) })).status).toBe(413);
    const big = Buffer.concat([PNG, Buffer.alloc(100)]).toString('base64');
    expect((await post(key, { files: [{ name: 'big.png', data: big }] })).status).toBe(413);
    expect((await post(key, { files: [{ name: 'run.sh', data: Buffer.from('echo').toString('base64') }] })).status).toBe(415);
    expect((await post(key, { files: [{ name: 'fake.png', data: Buffer.from('not a png').toString('base64') }] })).status).toBe(415);
    expect((await post(key, {})).status).toBe(400);
    expect((await post(key, 'not json')).status).toBe(400);
    expect(readDecisionAnswer(key)).toBeUndefined();
    expect(fs.existsSync(path.join(decisionDir(key)!, 'answer'))).toBe(false);
  });

  it('a valid answer writes the record, stores its files in the decision directory, and produces one decision-answered event', async () => {
    const key = ask();
    const res = await post(key, { option: 'yes', text: 'ship it', files: [{ name: 'shot.png', data: PNG.toString('base64') }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ answered: true, key, option: 'yes', text: 'ship it', files: 1 });
    const answer = readDecisionAnswer(key)!;
    expect(answer).toMatchObject({ option: 'yes', text: 'ship it', by: 'glass' });
    expect(answer.attachments[0]!.path).toBe(path.join(decisionDir(key)!, 'answer', 'shot.png'));
    expect(fs.readFileSync(answer.attachments[0]!.path)).toEqual(PNG);
    // Answered once; the snapshot no longer carries it.
    expect((await post(key, { option: 'no' })).status).toBe(409);
    expect(buildGlassSnapshot().decisions!.some((d) => d.key === key)).toBe(false);
    const events = takeDecisionAnswers(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: { key }, answer: { option: 'yes', text: 'ship it' } });
    expect(takeDecisionAnswers(true)).toHaveLength(0);
  });

  it('serves a decision image by bare name and nothing else', async () => {
    const key = keyOf(lobstah('man', 'ask', '--title', 'Which tray?', '--attach', write('tray.png', PNG), '--attach', write('notes.txt', 'n')).stdout)!;
    const img = await fetch(`${base}/decision/${encodeURIComponent(key)}/files/tray.png`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect((await fetch(`${base}/decision/${encodeURIComponent(key)}/files/notes.txt`)).status).toBe(404);
    expect((await fetch(`${base}/decision/${encodeURIComponent(key)}/files/..%2Fdecision.json`)).status).toBe(404);
    expect((await fetch(`${base}/decision/${encodeURIComponent(key)}/md`)).status).toBe(404);
  });
});

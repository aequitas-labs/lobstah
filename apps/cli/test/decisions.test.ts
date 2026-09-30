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
  listRequests,
  requestsDir,
  unseenNotices,
} from '@lobstah/core';
import { buildTendReport } from '../src/tend.js';
import { applyCull, planCull } from '../src/cull.js';
import { buildGlassSnapshot, serveGlass } from '../src/glass.js';

/**
 * Decisions end to end: `man ask` stores one, a newer ask replaces it,
 * `--withdraw` removes it, and a framed decision hides the raw question on
 * its dispatch. An answer is a `decision-answer` request: the glass's
 * /requests POST files one (and refuses what it must), and `man wait`
 * delivers exactly one decision-answer event.
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

/** decision-answer requests on disk, and the unconsumed decision-answer notices that wake the helm. */
const answerRequests = () => listRequests({ kind: 'decision-answer' });
const answerWakes = () => unseenNotices(false).filter((n) => n.kind === 'decision-answer');

describe('man answer and the decision-answer event', () => {
  it('writes the request; man wait delivers one decision-answer event with the id, key, dispatch, option, text, and files', () => {
    question();
    const key = keyOf(lobstah('man', 'ask', A, '--title', 'Which schema?', '--option', 'v1', '--option', 'v2').stdout)!;
    const res = lobstah('man', 'answer', key, '--option', 'v2', '--text', 'and keep v1 readable', '--attach', write('shot.png', PNG));
    expect(res.status, res.stderr).toBe(0);
    const answer = readDecisionAnswer(key)!;
    expect(answer).toMatchObject({ option: 'v2', text: 'and keep v1 readable', by: 'cli' });
    const [request] = answerRequests();
    expect(request).toMatchObject({ id: answer.request, kind: 'decision-answer', from: 'cli', payload: { key, dispatch: A, option: 'v2' } });
    const stored = path.join(requestsDir(), answer.request, 'shot.png');
    expect(answer.attachments.map((a) => a.path)).toEqual([stored]);
    expect(fs.readFileSync(stored)).toEqual(PNG);
    expect(answerWakes().map((n) => n.refId)).toEqual([answer.request]);
    // Answered: no longer attention, and the question stays hidden until the helm sends it on.
    expect(buildTendReport().attention.filter((a) => a.id === A || a.key === key)).toEqual([]);

    const wait = lobstah('man', 'wait', '--timeout', '1');
    expect(wait.status, wait.stderr).toBe(0);
    expect(wait.stdout).toContain('event: decision-answer');
    expect(wait.stdout).toContain(`id: ${answer.request}`);
    expect(wait.stdout).toContain(key);
    expect(wait.stdout).toContain(`dispatch: ${A}`);
    expect(wait.stdout).toContain('option: v2');
    expect(wait.stdout).toContain('text: and keep v1 readable');
    expect(wait.stdout).toContain(stored);
    // Delivered once.
    const again = lobstah('man', 'wait', '--timeout', '1');
    expect(again.stdout).not.toContain('decision-answer');
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
    expect(answerRequests().map((r) => r.payload)).toMatchObject([{ key: d!.key, dispatch: A, text: 'v2' }]);
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
    expect(block.reason).toContain(`decision-answer ${key}`);
    expect(block.reason).toContain('option "yes"');
    expect(haul().stdout.trim()).toBe('');
  });

  it('cull removes a decision and its answer request once the answer is older than the window; never a standing one', () => {
    const standing = keyOf(lobstah('man', 'ask', '--title', 'still open').stdout)!;
    const answered = keyOf(lobstah('man', 'ask', '--title', 'answered').stdout)!;
    lobstah('man', 'answer', answered, '--text', 'done');
    const request = readDecisionAnswer(answered)!.request;
    expect(planCull(14, Date.now()).filter((i) => i.kind === 'decision')).toEqual([]);
    const plan = planCull(14, Date.now() + 30 * 86_400_000).filter((i) => i.kind === 'decision');
    expect(plan.map((i) => i.id)).toEqual([answered]);
    applyCull(plan);
    expect(readDecision(answered)).toBeUndefined();
    expect(fs.existsSync(path.join(requestsDir(), `${request}.json`))).toBe(false);
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
  const send = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/requests`, {
      method: 'POST',
      headers: { Origin: base, 'content-type': 'application/json', 'x-lobstah-token': token, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  /** A decision-answer request for `key`. */
  const post = (key: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    send({ kind: 'decision-answer', payload: { key, ...payload } }, headers);
  const ask = () => keyOf(lobstah('man', 'ask', '--title', 'Cut 0.6.0?', '--option', 'yes', '--option', 'no').stdout)!;

  it('rejects a missing or wrong token and a foreign origin', async () => {
    const key = ask();
    const missing = await fetch(`${base}/requests`, {
      method: 'POST',
      headers: { Origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'decision-answer', payload: { key, option: 'yes' } }),
    });
    expect(missing.status).toBe(403);
    expect((await post(key, { option: 'yes' }, { 'x-lobstah-token': 'wrong' })).status).toBe(403);
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
    expect((await send('not json')).status).toBe(400);
    expect((await send({ kind: 'mystery', payload: { key, option: 'yes' } })).status).toBe(400);
    expect(readDecisionAnswer(key)).toBeUndefined();
    expect(answerRequests()).toEqual([]);
    expect(answerWakes()).toEqual([]);
  });

  it('a valid answer writes a decision-answer request with its files in the request directory, and one wake', async () => {
    const key = ask();
    const res = await post(key, { option: 'yes', text: 'ship it', files: [{ name: 'shot.png', data: PNG.toString('base64') }] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; id: string; key: string };
    expect(body).toMatchObject({ ok: true, key });
    const answer = readDecisionAnswer(key)!;
    expect(answer).toMatchObject({ request: body.id, option: 'yes', text: 'ship it', by: 'glass' });
    expect(answer.attachments[0]!.path).toBe(path.join(requestsDir(), body.id, 'shot.png'));
    expect(fs.readFileSync(answer.attachments[0]!.path)).toEqual(PNG);
    expect(answerRequests()).toMatchObject([{ id: body.id, kind: 'decision-answer', from: 'glass', payload: { key, option: 'yes', text: 'ship it' } }]);
    // Answered once; the snapshot no longer carries it.
    expect((await post(key, { option: 'no' })).status).toBe(409);
    expect(buildGlassSnapshot().decisions!.some((d) => d.key === key)).toBe(false);
    expect(answerWakes().map((n) => n.refId)).toEqual([body.id]);
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

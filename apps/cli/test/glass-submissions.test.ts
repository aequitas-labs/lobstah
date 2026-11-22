import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendStatus, askDecision, claimNext, enqueue, ensureLayout, laneDirs, listRequests, readDecisionAnswer, readThread, startThread, unhandled } from '@lobstah/core';
import { serveGlass } from '../src/glass.js';
import { deliverPending, deliverSubmission, pendingSubmissions, readSubmissionStatus, DELIVERY_PATIENCE_MS } from '../src/glass-submissions.js';
import { fileURLToPath } from 'node:url';
import { deliveryProcess } from '../src/glass-delivery.js';
import type { DeliveryRunner } from '../src/glass-delivery.js';
import type { SubmissionStatus } from '../src/glass-submissions.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * The glass's outbox (glass-submissions.ts): an answer or a message is
 * recorded and acknowledged before anything else runs, delivered once
 * afterwards, and never waits on a lock another process holds.
 */

const DISPATCH = '11111111-1111-4111-8111-111111111111';
let home: string;
let server: Server | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-submissions-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = '${home.replaceAll('\\', '/')}'\n`);
  enqueue({ id: DISPATCH, repo: 'r', brief: 'Choose a version' });
  claimNext('work');
  fs.writeFileSync(path.join(home, 'active', DISPATCH, 'runner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

/** A card on the dispatch's standing question, as the helm frames one. */
function questionCard() {
  appendStatus(DISPATCH, 'work', 'needs-decision', 'Which version?');
  return askDecision({ title: 'Which version?', options: ['A', 'B'], dispatch: DISPATCH, grounds: 'home', repo: 'r', askedBy: 'helm', maxBytes: 1000 }).meta;
}

/** Hold a lock as another live process would: its directory with this process as the owner. */
function holdLock(dir: string): () => void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'owner'), JSON.stringify({ pid: process.pid, token: 'test-holder', at: new Date().toISOString() }));
  return () => fs.rmSync(dir, { recursive: true, force: true });
}
const inboxLock = () => path.join(laneDirs('work').inbox, DISPATCH, '.write-lock');
const noticeLock = () => path.join(home, 'notices', '.cursor.lock');

/** A runner the test releases by hand: delivery runs only when `release()` is called. */
function heldRunner() {
  let runs = 0;
  let release: () => void = () => undefined;
  const settled: SubmissionStatus[] = [];
  const run: DeliveryRunner = (onSettled) => {
    runs++;
    return new Promise((resolve) => {
      release = () => void deliverPending((status) => (settled.push(status), onSettled(status)), { pauseMs: () => 5 }).then(resolve);
    });
  };
  return { run, runs: () => runs, release: () => release(), settled };
}

async function glass(run: DeliveryRunner) {
  server = serveGlass(0, { deliver: run });
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = (await (await fetch(`${base}/data`)).json()).focusToken as string;
  const post = async (kind: string, payload: Record<string, unknown>) => {
    const r = await fetch(`${base}/requests`, { method: 'POST', headers: { Origin: base, 'content-type': 'application/json', 'x-lobstah-token': token }, body: JSON.stringify({ kind, payload }) });
    return { status: r.status, body: (await r.json()) as { ok: boolean; state?: string; submission?: string; reason?: string } };
  };
  const status = async (id: string, wait = 0) => {
    const r = await fetch(`${base}/api/submissions/${id}?wait=${wait}`, { headers: { 'x-lobstah-token': token } });
    return { status: r.status, body: (await r.json()) as { state?: string; reason?: string } };
  };
  return { base, post, status };
}

it('acknowledges an answer once it is recorded, before delivery runs; delivery then stores it and wakes the helm once', async () => {
  const card = questionCard();
  const runner = heldRunner();
  const { post, status } = await glass(runner.run);
  const id = randomUUID();
  const reply = await post('decision-answer', { key: card.key, option: 'A', submission: id });
  expect(reply).toMatchObject({ status: 202, body: { ok: true, state: 'pending', submission: id } });
  // Recorded, and nothing else yet: no answer, no request for the helm, nothing in the trap's inbox.
  expect(pendingSubmissions().map((s) => s.id)).toEqual([id]);
  expect(readDecisionAnswer(card.key)).toBeUndefined();
  expect(listRequests({ kind: 'decision-answer' })).toEqual([]);
  expect(runner.runs()).toBe(1);

  const settled = status(id, 5000);
  runner.release();
  expect(await settled).toMatchObject({ status: 200, body: { state: 'applied' } });
  expect(readDecisionAnswer(card.key)).toMatchObject({ option: 'A', request: id });
  expect(listRequests({ kind: 'decision-answer' }).map((r) => r.id)).toEqual([id]);
  expect(unhandled(DISPATCH, 'work')).toHaveLength(1);
});

it('records a double submit once and delivers it once', async () => {
  const card = questionCard();
  const runner = heldRunner();
  const { post, status } = await glass(runner.run);
  const id = randomUUID();
  const [first, second] = await Promise.all([post('decision-answer', { key: card.key, option: 'B', submission: id }), post('decision-answer', { key: card.key, option: 'B', submission: id })]);
  expect([first.status, second.status]).toEqual([202, 202]);
  expect(pendingSubmissions()).toHaveLength(1);
  runner.release();
  expect((await status(id, 5000)).body.state).toBe('applied');
  // Sent again after delivery: the same answer, not a second one.
  expect(await post('decision-answer', { key: card.key, option: 'B', submission: id })).toMatchObject({ status: 200, body: { state: 'applied' } });
  expect(listRequests({ kind: 'decision-answer' })).toHaveLength(1);
  expect(unhandled(DISPATCH, 'work')).toHaveLength(1);
  expect(runner.settled.map((s) => s.id)).toEqual([id]);
});

it('starts a conversation under the page’s id and adds a resent message once', async () => {
  const runner = heldRunner();
  const { post, status } = await glass(runner.run);
  const start = randomUUID();
  expect((await post('thread-start', { text: 'Can the deploy wait?', files: [], submission: start })).status).toBe(202);
  expect(readThread(start)).toBeUndefined();
  runner.release();
  expect((await status(start, 5000)).body.state).toBe('applied');
  expect(readThread(start)).toMatchObject({ id: start, title: 'Can the deploy wait?' });

  const reply = randomUUID();
  await post('thread-post', { id: start, text: 'Until Monday', files: [], submission: reply });
  await post('thread-post', { id: start, text: 'Until Monday', files: [], submission: reply });
  runner.release();
  expect((await status(reply, 5000)).body.state).toBe('applied');
  const words = readThread(start)!.rounds.flatMap((round) => round.entries.flatMap((entry) => ('text' in entry ? [entry.text] : [])));
  expect(words).toEqual(['Can the deploy wait?', 'Until Monday']);
});

it('answers at once while another process holds the notice-delivery and inbox locks, and delivers once they are free', async () => {
  const card = questionCard();
  const releaseNotices = holdLock(noticeLock());
  const releaseInbox = holdLock(inboxLock());
  const settled: SubmissionStatus[] = [];
  // The built CLI's own `glass deliver`, in its own process, as the glass runs it.
  const deliver = deliveryProcess([fileURLToPath(new URL('../dist/main.js', import.meta.url))]);
  const run: DeliveryRunner = (onSettled) => deliver((status) => (settled.push(status), onSettled(status)));
  const { post, status } = await glass(run);
  const id = randomUUID();
  const started = Date.now();
  const reply = await post('decision-answer', { key: card.key, option: 'A', submission: id });
  // The inbox lock waits up to a second when the write runs in the request; recorded, it does not wait at all.
  expect(Date.now() - started).toBeLessThan(900);
  // And the glass keeps answering while delivery waits on the lock.
  const ping = Date.now();
  await status(id);
  expect(Date.now() - ping).toBeLessThan(500);
  expect(reply).toMatchObject({ status: 202, body: { state: 'pending' } });
  expect((await status(id, 300)).body.state).toBe('pending');
  releaseInbox();
  releaseNotices();
  expect((await status(id, 8000)).body.state).toBe('applied');
  expect(readDecisionAnswer(card.key)?.request).toBe(id);
  expect(settled.map((s) => s.state)).toEqual(['applied']);
});

it('tries a busy submission again, and refuses it with a reason once it has waited too long', () => {
  const card = questionCard();
  const releaseInbox = holdLock(inboxLock());
  const id = randomUUID();
  const at = new Date();
  const submission = { id, kind: 'decision-answer' as const, payload: { key: card.key, option: 'A' }, source: 'glass' as const, at: at.toISOString() };
  fs.mkdirSync(path.join(home, 'glass-submissions'), { recursive: true });
  fs.writeFileSync(path.join(home, 'glass-submissions', `${id}.json`), JSON.stringify(submission));
  expect(deliverSubmission(submission, at)).toMatchObject({ busy: expect.stringContaining('busy') });
  expect(readSubmissionStatus(id)?.state).toBe('pending');
  const late = deliverSubmission(submission, new Date(at.getTime() + DELIVERY_PATIENCE_MS + 1));
  expect(late).toMatchObject({ settled: { state: 'failed', reason: 'The helm’s files stayed busy. Try again.' } });
  expect(readDecisionAnswer(card.key)).toBeUndefined();
  releaseInbox();
});

it('settles a delivery that stopped after writing, without writing it twice', () => {
  const card = questionCard();
  const id = randomUUID();
  const submission = { id, kind: 'decision-answer' as const, payload: { key: card.key, option: 'A' }, source: 'glass' as const, at: new Date().toISOString() };
  const dir = path.join(home, 'glass-submissions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(submission));
  expect(deliverSubmission(submission)).toMatchObject({ settled: { state: 'applied' } });
  // As if the process stopped after the answer was stored and before it settled: the record is back, the status gone.
  fs.rmSync(path.join(dir, `${id}.status.json`));
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(submission));
  expect(deliverSubmission(submission)).toMatchObject({ settled: { state: 'applied', result: { key: card.key, request: id } } });
  expect(listRequests({ kind: 'decision-answer' })).toHaveLength(1);
  expect(unhandled(DISPATCH, 'work')).toHaveLength(1);
});

it('refuses at record time what a few reads can tell, and records nothing', async () => {
  const card = questionCard();
  const { post } = await glass(heldRunner().run);
  const thread = startThread({ grounds: 'home', text: 'Hello' });
  expect(await post('decision-answer', { key: 'decision:0000ffff', option: 'A', submission: randomUUID() })).toMatchObject({ status: 404, body: { ok: false, state: 'failed' } });
  expect(await post('thread-post', { id: randomUUID(), text: 'Hi', files: [], submission: randomUUID() })).toMatchObject({ status: 404 });
  expect(await post('thread-post', { id: thread.id, text: '', files: [], submission: randomUUID() })).toMatchObject({ status: 400 });
  expect(await post('decision-answer', { key: card.key, option: 'A', submission: 'not-a-uuid' })).toMatchObject({ status: 400 });
  expect(pendingSubmissions()).toEqual([]);
});

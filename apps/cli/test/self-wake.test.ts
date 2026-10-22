import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  acknowledge, answeredAt, appendStatus, claimBait, enqueue, ensureLayout,
  readEvents, readMessageMeta, readSessionWatcher, readStatusLog, readTrap, heartbeatTrap,
  requestCancel, sendMessage, sendSelfWake, signOnTrap, takeHelm, unhandled,
  SELF_WAKE_INTERVAL_MS, SELF_WAKE_MAX_BYTES,
} from '@lobstah/core';
import { removeTempDir } from '../../../test/temp-dir.js';
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string, wt: string, otherWt: string, trap: string;
const session = 'self-wake-worker', other = 'other-worker', id = 'own-catch', otherId = 'other-catch';
const env = (patch: Record<string, string> = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CODEX|CLAUDE)/.test(k))), LOBSTAH_HOME: home, ...patch });
const run = (args: string[], cwd = wt, patch?: Record<string, string>) => spawnSync(process.execPath, [cli, ...args], { cwd, env: env(patch), encoding: 'utf8', timeout: 10_000 });
const wake = (extra: Partial<Parameters<typeof sendSelfWake>[0]> = {}) => sendSelfWake({ cwd: wt, text: 'await done', maxAttachmentBytes: 1024, ...extra });
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-self-wake-')); process.env.LOBSTAH_HOME = home; ensureLayout();
  wt = path.join(home, 'own-wt'); otherWt = path.join(home, 'other-wt'); fs.mkdirSync(wt); fs.mkdirSync(otherWt);
  for (const [cwd, sid, job] of [[wt, session, id], [otherWt, other, otherId]]) {
    const signed = signOnTrap({ worktree: cwd!, cwd: cwd!, sessionId: sid!, repo: 'web', harness: 'codex', ttlMs: 60_000 });
    if (!('ok' in signed)) throw new Error('unexpected hold');
    if (sid === session) trap = signed.ok.trapId;
    enqueue({ id: job!, repo: 'web', brief: 'fixture', for: `wt:${signed.ok.trapId}` });
    claimBait(readTrap(signed.ok.trapId)!);
    appendStatus(job!, 'work', 'working', 'accepted', undefined, undefined, true);
  }
  takeHelm({ sessionId: 'helm', grounds: { name: 'fleet', repos: ['web'] }, ttlMs: 60_000 });
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

it('queues a retained attachment to its own catch, records self in logs, and leaves status alone', () => {
  const payload = path.join(home, 'payload.json'); fs.writeFileSync(payload, '{"round":1}');
  const status = readStatusLog(id, 'work');
  const r = run(['inbox', 'self', 'await done', '--attach', payload, '--dispatch', id]);
  expect(r.status, r.stderr).toBe(0); expect(r.stdout).toContain('from: self');
  const [message] = unhandled(id, 'work'); expect(message?.text).toContain('[from self]\nawait done');
  const meta = readMessageMeta(id, 'work', message!.file)!; expect(meta.from).toBe('self');
  fs.unlinkSync(payload); expect(fs.readFileSync(meta.attachments![0]!.path, 'utf8')).toBe('{"round":1}');
  expect(unhandled(otherId, 'work')).toEqual([]);
  expect(readEvents(id, 'work')).toMatchObject([{ type: 'self', data: { trap: `wt:${trap}`, text: 'await done' } }]);
  expect(readStatusLog(id, 'work')).toEqual(status);
  expect(run(['logs', id]).stdout).toContain('"type":"self"');
});

it('can resolve its session outside the worktree or its worktree without a session', () => {
  const r = run(['inbox', 'self', 'outside completion', '--session', session], home);
  expect(r.status, r.stderr).toBe(0); expect(unhandled(id, 'work')[0]?.text).toContain('outside completion');
});

it('cannot target another dispatch, trap or helm, or override a conflicting caller identity', () => {
  for (const args of [
    ['inbox', 'self', 'done', '--dispatch', otherId],
    ['inbox', 'self', 'done', `wt:${trap}`],
    ['inbox', 'self', 'done', 'helm'],
    ['inbox', 'self', 'done', '--to', other],
    ['inbox', 'self', 'done', '--session', other],
    ['inbox', 'self', 'done', '--session', 'helm'],
  ]) expect(run(args).status, args.join(' ')).not.toBe(0);
  expect(run(['inbox', 'self', 'done', '--session', other], home, { CLAUDE_CODE_SESSION_ID: session }).status).not.toBe(0);
  expect(run(['inbox', 'self', 'done', '--session', 'helm'], home).status).not.toBe(0);
  expect(run(['inbox', 'self', 'done'], home).status).not.toBe(0);
  expect(unhandled(id, 'work')).toEqual([]); expect(unhandled(otherId, 'work')).toEqual([]);
  const guarded = run(['send', `wt:${trap}`, 'still guarded', '--session', session]);
  expect(guarded.stdout + guarded.stderr).toContain('reserved for the helm');
});

it('uses a durable per-trap rate limit across processes and permits the next delivery at 30s', () => {
  const first = run(['inbox', 'self', 'first']); expect(first.status, first.stderr).toBe(0);
  const denied = run(['inbox', 'self', 'second']);
  expect(denied.stdout + denied.stderr).toContain('rate limit');
  const now = JSON.parse(fs.readFileSync(path.join(home, 'self-wake', `${trap}.json`), 'utf8')).at as number;
  expect(() => wake({ now: now + SELF_WAKE_INTERVAL_MS - 1 })).toThrow('rate limit');
  const next = wake({ now: now + SELF_WAKE_INTERVAL_MS, text: 'next completion' });
  expect(unhandled(id, 'work')).toHaveLength(2);
  for (const m of unhandled(id, 'work')) acknowledge(id, 'work', m.file);
  expect(unhandled(id, 'work')).toEqual([]); expect(next.queued).not.toBe('001.msg');
});

it('validates nonempty text, UTF-8 size and attachments before consuming the rate slot', () => {
  expect(() => wake({ text: ' ' })).toThrow('non-empty');
  expect(() => wake({ text: '🦞'.repeat(SELF_WAKE_MAX_BYTES / 4 + 1) })).toThrow('8 KiB');
  expect(() => wake({ files: [path.join(home, 'missing')] })).toThrow();
  const big = path.join(home, 'large'); fs.writeFileSync(big, 'x'.repeat(1025));
  expect(() => wake({ files: [big] })).toThrow('attachment limit');
  expect(() => wake({ files: Array(5).fill(big) })).toThrow('four attachments');
  expect(() => wake()).not.toThrow(); expect(unhandled(id, 'work')).toHaveLength(1);
});

it('refuses inactive/cancelled catches and a callback bound to an earlier catch', () => {
  expect(() => wake({ dispatch: 'earlier-catch' })).toThrow('different dispatch');
  requestCancel(id, 'work'); expect(() => wake()).toThrow('cancelled');
  appendStatus(id, 'work', 'done'); expect(() => wake()).toThrow('active dispatch');
});

it("refuses a registration pointing at a different trap's claim", () => {
  heartbeatTrap(trap, { claimed: otherId });
  expect(() => wake()).toThrow('claim does not belong');
  expect(unhandled(otherId, 'work')).toEqual([]);
});

it('serializes competing self-wakes and concurrent helm mail without losing messages', async () => {
  const core = new URL('../../../packages/core/dist/index.js', import.meta.url).href;
  const helmScript = `import { sendMessage } from ${JSON.stringify(core)}; for (let i=0;i<40;i++) sendMessage('own-catch','work','helm note '+i,'helm');`;
  const children = [
    spawn(process.execPath, [cli, 'inbox', 'self', 'callback one'], { cwd: wt, env: env() }),
    spawn(process.execPath, [cli, 'inbox', 'self', 'callback two'], { cwd: wt, env: env() }),
    spawn(process.execPath, ['--input-type=module', '-e', helmScript], { cwd: wt, env: env() }),
  ];
  try {
    const outcomes = await Promise.all(children.map((child) => new Promise<{ code: number | null; error: string }>((resolve) => {
      let error = ''; child.stderr.on('data', (b) => error += b); child.stdout.on('data', (b) => error += b);
      child.once('close', (code) => resolve({ code, error }));
    })));
    expect(outcomes[2]?.code, outcomes[2]?.error).toBe(0);
    expect(outcomes.slice(0,2).map((r) => r.code).sort()).toEqual([0,1]);
    expect(outcomes.slice(0,2).find((r) => r.code !== 0)?.error).toContain('rate limit');
    const messages = unhandled(id, 'work'); expect(messages).toHaveLength(41);
    expect(new Set(messages.map((m) => m.file)).size).toBe(41);
    expect(messages.filter((m) => readMessageMeta(id, 'work', m.file)?.from === 'self')).toHaveLength(1);
  } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
}, 20_000);

it('a resumed owner may wake the same trap catch, while its former session cannot', () => {
  const reg = readTrap(trap)!;
  signOnTrap({ ...reg, sessionId: 'resumed', ttlMs: 60_000, now: Date.now() + 60_001 });
  expect(run(['inbox', 'self', 'old completion', '--session', session]).status).not.toBe(0);
  const result = run(['inbox', 'self', 'resumed completion', '--session', 'resumed']);
  expect(result.status, result.stderr).toBe(0);
});

it('self mail never clears a needs-decision, even once read', () => {
  const since = new Date(Date.now() - 1000).toISOString();
  appendStatus(id, 'work', 'needs-decision', 'human choice', since);
  wake(); expect(answeredAt(id, 'work', since)).toBeUndefined();
  const mail = unhandled(id, 'work')[0]!; acknowledge(id, 'work', mail.file);
  expect(answeredAt(id, 'work', since)).toBeUndefined();
  sendMessage(id, 'work', 'human answer', 'helm'); expect(answeredAt(id, 'work', since)).toBeDefined();
});

it('binds old callbacks to their catch and keeps the rate limit after reassignment', () => {
  const now = Date.now(); wake({ now });
  appendStatus(id, 'work', 'done');
  const next = 'next-catch'; enqueue({ id: next, repo: 'web', brief: 'next', for: `wt:${trap}` });
  claimBait(readTrap(trap)!); appendStatus(next, 'work', 'working', 'accepted', undefined, undefined, true);
  expect(() => wake({ dispatch: id, now: now + SELF_WAKE_INTERVAL_MS })).toThrow('different dispatch');
  expect(() => wake({ dispatch: next, now: now + 1 })).toThrow('rate limit');
  wake({ dispatch: next, now: now + SELF_WAKE_INTERVAL_MS });
  expect(unhandled(next, 'work')).toHaveLength(1);
  expect(unhandled(id, 'work')).toHaveLength(1);
});

it('the between-turns Codex Stop hook delivers a self-wake without consuming its payload', () => {
  wake();
  const r = spawnSync(process.execPath, [cli, 'hook', 'stop', '--timeout', '0'], { cwd: wt, env: env(), encoding: 'utf8', timeout: 10_000, input: JSON.stringify({ session_id: session, cwd: wt }) });
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'block' });
  expect(r.stdout).toContain(`New instruction for your dispatch ${id}`);
  expect(unhandled(id, 'work')).toHaveLength(1);
});

it('a supervised background completion wakes the existing park and retains its payload for inbox', async () => {
  const payload = path.join(home, 'payload.json');
  const child = spawn(process.execPath, [cli, 'soak', '--session', session, '--wait', '--timeout', '5'], { cwd: wt, env: env() });
  let out = ''; let err = ''; child.stdout.on('data', (b) => out += b); child.stderr.on('data', (b) => err += b);
  const exit = new Promise<number | null>((resolve) => child.once('close', resolve));
  try {
    for (let i = 0; i < 100 && !readSessionWatcher(session); i++) await new Promise((r) => setTimeout(r, 30));
    expect(readSessionWatcher(session)).toBeDefined();
    // The producer stands in for a wait, then invokes the real CLI as its completion callback.
    const producer = spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(payload)}, '{"verdict":"ready"}'); require('child_process').execFileSync(process.execPath, ${JSON.stringify([cli, 'inbox', 'self', 'await done', '--attach', payload, '--dispatch', id])}, {stdio:'inherit'});`], { cwd: wt, env: env() });
    const produced = await new Promise<number | null>((resolve) => producer.once('close', resolve)); expect(produced).toBe(0);
    expect(await exit, err).toBe(0); expect(out).toContain(`New instruction for your dispatch ${id}`);
    const inbox = run(['inbox', id]); expect(inbox.stdout).toContain('await done'); expect(inbox.stdout).toContain('payload.json');
    expect(unhandled(id, 'work')).toEqual([]);
  } finally { if (child.exitCode === null) child.kill(); }
}, 15_000);

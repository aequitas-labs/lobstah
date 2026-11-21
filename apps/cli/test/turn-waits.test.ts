import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  appendStatus,
  claimBait,
  daemonSkip,
  heartbeatTrap,
  pendingIds,
  queuedDescriptor,
  readTrap,
  releaseCatch,
  reserveTrap,
  sweepGhostTraps,
  turnWaitProblem,
  enqueue,
  ensureLayout,
  listNotices,
  readTurnOwner,
  readTurnWaits,
  signOnTrap,
  stowTrap,
  turnHome,
  turnWaitCommand,
  unhandled,
} from '@lobstah/core';
import type { TrapRegistration } from '@lobstah/core';
import { createTurnWaits, deliverTurnWaitLine, noticeUnreadPointers, readTurnWaitRecords, STALE_MS, syncTurnWaitRecords } from '../src/turn-waits.js';
import { soakPark } from '../src/trap-park.js';
import { runBeat } from '../src/beat.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * The turn-end contract, lobstah's side: a trap's sign-on takes its session's
 * turn end, another tool registers a wait instead of waiting, and the daemon
 * runs it and wakes the trap with a pointer, or resumes a trap that's gone.
 */

const SESSION = '7b1d4c52-0d1e-4f3a-9a77-3c2f1e0b9d10';
let dir: string;
let exitListeners: Set<(...args: unknown[]) => void>;

beforeEach(() => {
  exitListeners = new Set(process.listeners('exit'));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-turn-waits-'));
  process.env.LOBSTAH_HOME = path.join(dir, 'lobstah');
  process.env.AGENT_TURN_HOME = path.join(dir, 'agent-turn');
  ensureLayout();
  fs.mkdirSync(path.join(dir, 'repo'));
  fs.writeFileSync(path.join(process.env.LOBSTAH_HOME, 'config.toml'), `[repos.web]\npath = '${path.join(dir, 'repo')}'\n`);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const listener of process.listeners('exit')) if (!exitListeners.has(listener)) process.removeListener('exit', listener);
  delete process.env.LOBSTAH_HOME;
  delete process.env.AGENT_TURN_HOME;
  removeTempDir(dir);
});

function trap(session = SESSION): TrapRegistration {
  const worktree = path.join(dir, 'wt');
  fs.mkdirSync(worktree, { recursive: true });
  const r = signOnTrap({ name: 'amber-gull', harness: 'codex', repo: 'web', worktree, cwd: worktree, sessionId: session, ttlMs: 60_000 });
  if (!('ok' in r)) throw new Error('held');
  return r.ok;
}

/** A trap working dispatch `id`, as a plan's author would be. */
function working(id = 'plan'): TrapRegistration {
  const t = trap();
  enqueue({ id, repo: 'web', brief: 'write the plan', for: `wt:${t.trapId}` });
  expect(claimBait(t)?.id).toBe(id);
  appendStatus(id, 'work', 'paused', 'plan is up', undefined, { waitingOn: 'external', link: 'https://ume.example.com/a/1' });
  return t;
}

/** What another tool's Stop hook writes when it finds an owner. */
function register(name: string, reg: object, session = SESSION): void {
  const owner = readTurnOwner(session)!;
  fs.writeFileSync(path.join(owner.waits, name), JSON.stringify(reg));
}

/** A wait that remains registered without launching an external program. */
function idleWait(): ChildProcess {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() }) as unknown as ChildProcess;
}

const UME = { from: 'ume', wait: 'ume await a1 --since {cursor} --turn-line', read: 'ume feedback a1', cursor: '30' };

describe('the owner file', () => {
  it('a sign-on takes the session’s turn end, and a stow gives it back', () => {
    const t = trap();
    expect(readTurnOwner(SESSION)).toMatchObject({ owner: 'lobstah', cwd: t.cwd, waits: path.join(turnHome(), SESSION, 'waits') });
    expect(fs.existsSync(readTurnOwner(SESSION)!.waits)).toBe(true);
    stowTrap(t.trapId);
    expect(readTurnOwner(SESSION)).toBeUndefined();
  });

  it('a session another tool owns stays theirs', () => {
    fs.mkdirSync(path.join(turnHome(), SESSION), { recursive: true });
    fs.writeFileSync(path.join(turnHome(), SESSION, 'owner.json'), JSON.stringify({ owner: 'other', since: 'x', cwd: '/', waits: '/w' }));
    trap();
    expect(readTurnOwner(SESSION)?.owner).toBe('other');
  });

  it('only valid registrations are read', () => {
    trap();
    register('ume.json', UME);
    register('bad-name.json', { ...UME, from: 'Not A Name' });
    register('no-read.json', { from: 'ci', wait: 'x' });
    expect(readTurnWaits(SESSION).map((w) => w.from)).toEqual(['ume']);
    register('context.json', { ...UME, context: 'set-1 / artifact a1' });
    expect(readTurnWaits(SESSION).find(w => w.file.endsWith('context.json'))?.context).toBe('set-1 / artifact a1');
    expect(turnWaitProblem({ ...UME, context: 42 })).toContain('context');
    expect(turnWaitProblem({ ...UME, context: 'x'.repeat(20_001) })).toContain('context');
  });

  it('the cursor is quoted for the shell the wait runs in', () => {
    expect(turnWaitCommand('ume await a1 --since {cursor}', "4'2", 'darwin')).toBe(`ume await a1 --since '4'\\''2'`);
    expect(turnWaitCommand('ume await a1 --since {cursor}', '4"2', 'win32')).toBe('ume await a1 --since "4""2"');
  });
});

describe('waking the session', () => {
  it.each(['ume', 'ci-events'])('%s wakes a live trap through its dispatch inbox and advances the cursor', (source) => {
    working();
    register('tool.json', { ...UME, from: source });
    syncTurnWaitRecords();
    const [record] = readTurnWaitRecords();
    expect(record).toMatchObject({ from: source, dispatch: 'plan', cursor: '30' });
    expect(deliverTurnWaitLine(record!.key, JSON.stringify({ cursor: '31', summary: 'Chris picked an option' }))).toBe('inbox');
    expect(unhandled('plan', 'work').map((m) => m.text)).toEqual([`${source} has something new: Chris picked an option. Run \`ume feedback a1\` to see it.`]);
    expect(readTurnWaitRecords()[0]?.cursor).toBe('31');
  });

  it('a re-thrown trap receives feedback registered by its previous session without a headless fork', () => {
    const t = working();
    register('ume.json', UME);
    syncTurnWaitRecords();
    const key = readTurnWaitRecords()[0]!.key;
    const signed = signOnTrap({ repo: 'web', harness: 'codex', worktree: t.worktree, cwd: t.cwd, sessionId: 'replacement', ttlMs: 60_000, now: Date.now() + 61_000 });
    if (!('ok' in signed)) throw new Error('held');
    expect(signed.ok.claimed).toBe('plan');
    expect(syncTurnWaitRecords()).toEqual([]);
    expect(deliverTurnWaitLine(key, '{"cursor":"31"}')).toBe('inbox');
    expect(unhandled('plan', 'work')[0]?.text).toContain('ume feedback a1');
    expect(fs.readdirSync(path.join(process.env.LOBSTAH_HOME!, 'queue'))).toEqual([]);
    register('ume.json', UME, 'replacement');
    expect(syncTurnWaitRecords()).toEqual([key]);
    expect(readTurnWaitRecords()).toHaveLength(1);
    expect(readTurnWaitRecords()[0]?.session).toBe('replacement');
    expect(readTurnWaitRecords()[0]?.pointer?.inbox).toBe('plan');
    expect(readTurnWaitRecords()[0]?.cursor).toBe('31');
  });

  it.each(['stowed', 'ghosted'] as const)('a %s owner is re-thrown with its original dispatch and saved context, never a headless follow-up', async (departure) => {
    const t = working();
    const context = 'Set set-1, artifact a1. Run `ume attach set-1` in this session before reading feedback.';
    register('ume.json', { ...UME, context });
    syncTurnWaitRecords();
    const key = readTurnWaitRecords()[0]!.key;
    if (departure === 'stowed') stowTrap(t.trapId);
    else {
      heartbeatTrap(t.trapId, { parked: true });
      expect(sweepGhostTraps(60_000, Date.now() + 120_000, 1)).toHaveLength(1);
    }
    expect(deliverTurnWaitLine(key, '{"cursor":"31"}')).toBe('inbox');
    expect(unhandled('plan', 'work')[0]?.text).toContain('ume feedback a1');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rethrow = vi.fn(async (trapId: string) => {
      expect(trapId).toBe(t.trapId);
      expect(pendingIds('work')).toEqual(['plan']);
      const descriptor = queuedDescriptor('plan', 'work')!;
      expect(descriptor).toMatchObject({ for: `wt:${t.trapId}`, sessionMode: 'continue', brief: 'write the plan' });
      expect(descriptor.parkContext).toContain(context);
      expect(descriptor.parkContext).toContain('https://ume.example.com/a/1');
      expect(descriptor.followUp).toBeUndefined();
      expect(daemonSkip([], 0)(descriptor)).toBe(true);
      trap('replacement');
      await soakPark(t.trapId, '0');
    });
    const { pass } = createTurnWaits(idleWait, { rethrow });
    pass(Date.now(), () => {});
    await vi.waitFor(() => expect(rethrow).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(output).toHaveBeenCalled());
    const wake = JSON.parse(output.mock.calls.at(-1)![0]);
    expect(wake.reason).toContain('write the plan');
    expect(wake.reason).toContain(context);
    expect(wake.reason).toContain('lobstah inbox plan');
    expect(readTrap(t.trapId)?.claimed).toBe('plan');
    expect(unhandled('plan', 'work')).toHaveLength(1);
    expect(pendingIds('work')).toEqual([]);
  });

  it('replays the dispatch context if a live trap vanishes before reading its wake', async () => {
    const t = working();
    register('ume.json', { ...UME, context: 'Attach set-42 / artifact a1 in the owning session.' });
    syncTurnWaitRecords();
    deliverTurnWaitLine(readTurnWaitRecords()[0]!.key, '{"cursor":"31"}');
    stowTrap(t.trapId);
    const rethrow = vi.fn(async () => {});
    createTurnWaits(idleWait, { rethrow }).pass(Date.now(), () => {});
    await vi.waitFor(() => expect(rethrow).toHaveBeenCalledOnce());
    expect(queuedDescriptor('plan', 'work')?.parkContext).toContain('Attach set-42 / artifact a1');
    expect(unhandled('plan', 'work')).toHaveLength(1);
    expect(pendingIds('work')).toEqual(['plan']);
  });

  it('holds a working trap wake for its own park instead of injecting or re-throwing', async () => {
    const t = working();
    appendStatus('plan', 'work', 'working', 'Still executing', undefined, undefined, true);
    register('ume.json', UME);
    syncTurnWaitRecords();
    const before = readTrap(t.trapId);
    deliverTurnWaitLine(readTurnWaitRecords()[0]!.key, '{"cursor":"31"}');
    const rethrow = vi.fn(async () => {});
    createTurnWaits(idleWait, { rethrow }).pass(Date.now(), () => {});
    expect(rethrow).not.toHaveBeenCalled();
    expect(readTrap(t.trapId)).toEqual(before);
    expect(unhandled('plan', 'work')).toHaveLength(1);
    appendStatus('plan', 'work', 'paused', 'Awaiting feedback', undefined, undefined, true);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await soakPark(t.trapId, '0')).toBe('woke');
    expect(JSON.parse(output.mock.calls.at(-1)![0]).reason).toContain('ume feedback a1');
    expect(unhandled('plan', 'work')).toHaveLength(1);
  });

  it('pins otherwise unaddressed waiting work to its owner before sign-off', () => {
    const t = trap();
    enqueue({ id: 'plan', repo: 'web', brief: 'write the plan' });
    claimBait(t);
    register('review.json', { from: 'review-tool', wait: 'review-tool await', read: 'review-tool feedback' });
    syncTurnWaitRecords();
    releaseCatch({ claimed: 'plan' });
    stowTrap(t.trapId);
    const descriptor = queuedDescriptor('plan', 'work')!;
    expect(descriptor.for).toBe(`wt:${t.trapId}`);
    expect(daemonSkip([], 0)(descriptor)).toBe(true);
  });

  it('keeps wakes keyed to the original dispatch when its owner moves on to another catch', () => {
    const t = working();
    register('ume.json', UME);
    syncTurnWaitRecords();
    const key = readTurnWaitRecords()[0]!.key;
    releaseCatch({ claimed: 'plan' });
    enqueue({ id: 'other', repo: 'web', brief: 'another task', for: `wt:${t.trapId}` }, 'chore');
    expect(claimBait(readTrap(t.trapId)!)?.id).toBe('other');
    syncTurnWaitRecords();
    expect(readTurnWaitRecords()[0]?.dispatch).toBe('plan');
    expect(deliverTurnWaitLine(key, '{"cursor":"31"}')).toBe('inbox');
    expect(unhandled('plan', 'work')).toHaveLength(1);
    expect(unhandled('other', 'chore')).toEqual([]);
  });

  it('coalesces starts while retaining every wake in the dispatch inbox', async () => {
    const t = working();
    register('ume.json', UME);
    syncTurnWaitRecords();
    const key = readTurnWaitRecords()[0]!.key;
    stowTrap(t.trapId);
    let finish!: () => void;
    const rethrow = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const { pass } = createTurnWaits(idleWait, { rethrow });
    expect(deliverTurnWaitLine(key, '{"cursor":"31"}')).toBe('inbox');
    pass(Date.now(), () => {});
    expect(deliverTurnWaitLine(key, '{"cursor":"32"}')).toBe('inbox');
    pass(Date.now(), () => {});
    expect(rethrow).toHaveBeenCalledOnce();
    expect(unhandled('plan', 'work')).toHaveLength(2);
    expect(pendingIds('work')).toEqual(['plan']);
    finish();
    await Promise.resolve();
  });

  it('replays every tool context when several waits share the dispatch', async () => {
    const t = working();
    register('ume.json', { ...UME, context: 'Attach set-42 / artifact a1.' });
    register('ci.json', { from: 'ci', wait: 'ci await build-2', read: 'ci read build-2', context: 'Inspect build-2 in the trap session.' });
    syncTurnWaitRecords();
    const key = readTurnWaitRecords().find(record => record.from === 'ume')!.key;
    stowTrap(t.trapId);
    deliverTurnWaitLine(key, '{"cursor":"31"}');
    const rethrow = vi.fn(async () => {});
    createTurnWaits(idleWait, { rethrow }).pass(Date.now(), () => {});
    await vi.waitFor(() => expect(rethrow).toHaveBeenCalledOnce());
    const context = queuedDescriptor('plan', 'work')?.parkContext;
    expect(context).toContain('Attach set-42 / artifact a1.');
    expect(context).toContain('Inspect build-2 in the trap session.');
  });

  it('backs off a failed re-throw without falling back to a headless dispatch', async () => {
    const t = working();
    register('ume.json', UME);
    syncTurnWaitRecords();
    stowTrap(t.trapId);
    deliverTurnWaitLine(readTurnWaitRecords()[0]!.key, '{"cursor":"31"}');
    const rethrow = vi.fn(async () => { throw new Error('terminal unavailable'); });
    const { pass } = createTurnWaits(idleWait, { rethrow });
    pass(Date.now(), () => {});
    await vi.waitFor(() => expect(readTurnWaitRecords()[0]?.ownerRestart?.lastError).toBe('terminal unavailable'));
    pass(Date.now(), () => {});
    expect(rethrow).toHaveBeenCalledOnce();
    expect(pendingIds('work')).toEqual(['plan']);
    expect(unhandled('plan', 'work')).toHaveLength(1);
  });

  it('does not duplicate a re-throw already fenced by a reservation', () => {
    const t = working();
    register('ume.json', UME);
    syncTurnWaitRecords();
    releaseCatch({ claimed: 'plan' });
    stowTrap(t.trapId);
    deliverTurnWaitLine(readTurnWaitRecords()[0]!.key, '{"cursor":"31"}');
    reserveTrap({ repo: 'web', returning: { trapId: t.trapId, worktree: t.worktree } });
    const rethrow = vi.fn(async () => {});
    createTurnWaits(idleWait, { rethrow }).pass(Date.now(), () => {});
    expect(rethrow).not.toHaveBeenCalled();
  });

  it('a registration withdrawn while the trap is live ends; so does one whose dispatch finished', () => {
    working();
    register('ume.json', UME);
    syncTurnWaitRecords();
    fs.rmSync(path.join(readTurnOwner(SESSION)!.waits, 'ume.json'));
    expect(syncTurnWaitRecords()).toHaveLength(1);
    register('ume.json', UME);
    syncTurnWaitRecords();
    appendStatus('plan', 'work', 'done', 'built');
    expect(syncTurnWaitRecords()).toHaveLength(1);
    expect(readTurnWaitRecords()).toEqual([]);
  });

  it('a pointer left unread for 15 minutes tells the helm once', () => {
    working();
    register('ume.json', UME);
    syncTurnWaitRecords();
    const now = Date.now();
    deliverTurnWaitLine(readTurnWaitRecords()[0]!.key, '{"cursor":"31"}', now);
    expect(noticeUnreadPointers(now + STALE_MS - 1000)).toEqual([]);
    expect(noticeUnreadPointers(now + STALE_MS + 1000)).toHaveLength(1);
    expect(noticeUnreadPointers(now + STALE_MS + 2000)).toEqual([]);
    expect(listNotices().filter((n) => n.kind === 'trap-not-receiving').map((n) => n.refId)).toEqual(['plan']);
  });
});

describe('the daemon pass', () => {
  it('retries a persisted no_such_artifact failure with the project recorded by the trap hook', async () => {
    const t = working();
    vi.stubEnv('UME_PROJECT', 'default');
    const script = path.join(dir, 'project.cjs');
    fs.writeFileSync(script, `
      if (process.env.UME_PROJECT !== 'vr95mce908') {
        console.error('ume: no_such_artifact');
        process.exit(1);
      }
      console.log(JSON.stringify({ cursor: '31', summary: 'approved in ' + process.env.UME_PROJECT }));
    `);
    register('ume.json', { ...UME, wait: `"${process.execPath}" "${script}"` });
    const firstDaemon = createTurnWaits();
    firstDaemon.pass(Date.now(), () => {});
    await new Promise<void>(resolve => firstDaemon.children.values().next().value!.once('close', () => resolve()));
    const failed = readTurnWaitRecords()[0]!;
    expect(failed).toMatchObject({ failures: 1, lastError: 'ume: no_such_artifact', cursor: '30' });
    expect(Date.parse(failed.nextRunAt!)).toBeGreaterThan(Date.now());

    runBeat({ session_id: SESSION, cwd: t.cwd, tool_name: 'functions.exec_command',
      tool_input: { cmd: 'UME_PROJECT=vr95mce908 ume await --watch a1' } }, { run: () => ({ status: 1, stdout: '' }) });
    const restartedDaemon = createTurnWaits();
    const retryAt = Date.parse(failed.nextRunAt!);
    restartedDaemon.pass(retryAt - 1, () => {});
    expect(restartedDaemon.children.size).toBe(0);
    restartedDaemon.pass(retryAt, () => {});
    await new Promise<void>(resolve => restartedDaemon.children.values().next().value!.once('close', () => resolve()));

    expect(unhandled('plan', 'work')[0]?.text).toContain('approved in vr95mce908');
    expect(readTurnWaitRecords()[0]).toMatchObject({ key: failed.key, cursor: '31' });
    expect(readTurnWaitRecords()[0]).not.toHaveProperty('failures');
    expect(readTurnWaitRecords()[0]).not.toHaveProperty('nextRunAt');
    expect(readTurnWaitRecords()[0]).not.toHaveProperty('lastError');
  });

  it('runs the wait with its cursor and delivers what it prints', async () => {
    working();
    const script = path.join(dir, 'wait.js');
    fs.writeFileSync(script, "console.log(JSON.stringify({ cursor: String(Number(process.argv[2]) + 1), summary: 'cursor was ' + process.argv[2] }));");
    register('ume.json', { ...UME, wait: `"${process.execPath}" "${script}" {cursor}` });
    const { pass, children } = createTurnWaits();
    const log: string[] = [];
    pass(Date.now(), (m) => log.push(m));
    await new Promise<void>((resolve) => children.values().next().value!.on('close', () => resolve()));
    expect(unhandled('plan', 'work').map((m) => m.text)).toEqual(['ume has something new: cursor was 30. Run `ume feedback a1` to see it.']);
    expect(readTurnWaitRecords()[0]?.cursor).toBe('31');
    expect(log.some((l) => l.endsWith(': inbox'))).toBe(true);
  });

  it('runs any registered wait in its recorded directory without interpreting its context', async () => {
    const t = working();
    const script = path.join(dir, 'context.js');
    fs.writeFileSync(script, "console.log(JSON.stringify({ cursor: '31', summary: process.cwd() }));");
    register('review.json', { from: 'review-tool', cwd: t.cwd, wait: `"${process.execPath}" "${script}"`, read: 'review-tool feedback', context: 'set-1; restore using the tool in the trap session' });
    const { pass, children } = createTurnWaits();
    pass(Date.now(), () => {});
    await new Promise<void>(resolve => children.values().next().value!.once('close', () => resolve()));
    expect(unhandled('plan', 'work')[0]?.text).toContain(t.cwd);
    expect(readTurnWaitRecords()[0]?.parkContext?.instructions).toBe('set-1; restore using the tool in the trap session');
  });

  it('a wait that exits with an error code backs off and records why, however long it ran', async () => {
    working();
    register('ume.json', { ...UME, wait: `"${process.execPath}" -e "console.error('engine down'); process.exit(1)"` });
    const { pass, children } = createTurnWaits();
    pass(Date.now(), () => {});
    await new Promise<void>((resolve) => children.values().next().value!.on('close', () => resolve()));
    await new Promise((r) => setTimeout(r, 50));
    expect(readTurnWaitRecords()[0]).toMatchObject({ failures: 1, lastError: 'engine down' });
    pass(Date.now(), () => {});
    expect(children.size).toBe(0);
  });

  it('exit 2 with nothing printed is a quiet timeout: no failure, and it runs again at once', async () => {
    working();
    register('ume.json', { ...UME, wait: `"${process.execPath}" -e "process.exit(2)"` });
    const { pass, children } = createTurnWaits();
    pass(Date.now(), () => {});
    await new Promise<void>((resolve) => children.values().next().value!.on('close', () => resolve()));
    await new Promise((r) => setTimeout(r, 50));
    expect(readTurnWaitRecords()[0]).not.toHaveProperty('failures');
    pass(Date.now(), () => {});
    expect(children.size).toBe(1);
    await new Promise<void>((resolve) => children.values().next().value!.on('close', () => resolve()));
  });
});

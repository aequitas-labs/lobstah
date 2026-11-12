import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendStatus,
  claimBait,
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
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * The turn-end contract, lobstah's side: a trap's sign-on takes its session's
 * turn end, another tool registers a wait instead of waiting, and the daemon
 * runs it and wakes the trap with a pointer, or resumes a trap that's gone.
 */

const SESSION = '7b1d4c52-0d1e-4f3a-9a77-3c2f1e0b9d10';
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-turn-waits-'));
  process.env.LOBSTAH_HOME = path.join(dir, 'lobstah');
  process.env.AGENT_TURN_HOME = path.join(dir, 'agent-turn');
  ensureLayout();
  fs.mkdirSync(path.join(dir, 'repo'));
  fs.writeFileSync(path.join(process.env.LOBSTAH_HOME, 'config.toml'), `[repos.web]\npath = '${path.join(dir, 'repo')}'\n`);
});
afterEach(() => {
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
  });

  it('the cursor is quoted for the shell the wait runs in', () => {
    expect(turnWaitCommand('ume await a1 --since {cursor}', "4'2", 'darwin')).toBe(`ume await a1 --since '4'\\''2'`);
    expect(turnWaitCommand('ume await a1 --since {cursor}', '4"2', 'win32')).toBe('ume await a1 --since "4""2"');
  });
});

describe('waking the session', () => {
  it('a live trap gets a pointer in its dispatch’s inbox, and the cursor moves on', () => {
    working();
    register('ume.json', UME);
    syncTurnWaitRecords();
    const [record] = readTurnWaitRecords();
    expect(record).toMatchObject({ from: 'ume', dispatch: 'plan', cursor: '30' });
    expect(deliverTurnWaitLine(record!.key, JSON.stringify({ cursor: '31', summary: 'Chris picked an option' }))).toBe('inbox');
    expect(unhandled('plan', 'work').map((m) => m.text)).toEqual(['ume has something new: Chris picked an option. Run `ume feedback a1` to see it.']);
    expect(readTurnWaitRecords()[0]?.cursor).toBe('31');
  });

  it('a trap that has gone gets one continuation of its dispatch at a time', () => {
    const t = working();
    register('ume.json', UME);
    syncTurnWaitRecords();
    const key = readTurnWaitRecords()[0]!.key;
    stowTrap(t.trapId);
    expect(deliverTurnWaitLine(key, JSON.stringify({ cursor: '31' }))).toBe('continuation');
    const queued = fs.readdirSync(path.join(process.env.LOBSTAH_HOME!, 'queue')).filter((f) => f.endsWith('.json'));
    expect(queued).toHaveLength(1);
    const brief = JSON.parse(fs.readFileSync(path.join(process.env.LOBSTAH_HOME!, 'queue', queued[0]!), 'utf8')) as { followUp: string; brief: string };
    expect(brief).toMatchObject({ followUp: 'plan', brief: 'ume has something new. Run `ume feedback a1` to see it.' });
    expect(deliverTurnWaitLine(key, JSON.stringify({ cursor: '32' }))).toBe('held');
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

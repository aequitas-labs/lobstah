import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { claudeSessionProcesses, endingProcessOwnsTrap, processRemoteLink, readClaudeProcesses, ensureLayout, processStartedAt, rosterTrapForSession, sessionHolders, sessionHolderText, signOnTrap, stowTrap, writeTrapAnchor } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const SESSION = '07201f97-1111-4222-8333-444444444444';
let home: string;
let claudeHome: string;
let children: ChildProcess[];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-holder-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  claudeHome = path.join(home, 'claude');
  fs.mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true });
  children = [];
});
afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  await Promise.all(children.map((c) => (c.exitCode !== null || c.signalCode !== null ? undefined : new Promise((resolve) => c.once('exit', resolve)))));
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

async function aProcess(): Promise<number> {
  const child = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000); console.log('up');"], { stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(child);
  await new Promise((resolve) => child.stdout!.once('data', resolve));
  return child.pid!;
}
/** What Claude Code 2.1.317 records as procStart: `ps lstart`, in UTC, not local time. */
const claudeProcStart = (pid: number): string | undefined =>
  process.platform === 'win32' ? undefined : execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }).trim();
/** The file Claude Code 2.1.317 keeps per process, with the fields this reads. */
function sessionFile(pid: number, over: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(claudeHome, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: SESSION, procStart: claudeProcStart(pid), kind: 'interactive', tmux: 'lobstah:@3.%14', ...over }));
}
function signOn(name: string, extra: Partial<Parameters<typeof signOnTrap>[0]> = {}) {
  const worktree = path.join(home, 'wt', name);
  fs.mkdirSync(worktree, { recursive: true });
  writeTrapAnchor(worktree, { trapId: name === 'smooth-gull' ? '93a6a892' : 'bcf9227d', name });
  const res = signOnTrap({ worktree, cwd: worktree, repo: 'r', harness: 'claude', sessionId: SESSION, name, ttlMs: 60_000, ...extra });
  if (!('ok' in res)) throw new Error('held');
  return res.ok;
}

it('finds a live Claude process with the session open, from any pane, with its pane', async () => {
  const pid = await aProcess();
  sessionFile(pid);
  expect(claudeSessionProcesses(SESSION, claudeHome)).toEqual([{ pid, sessionId: SESSION, pane: '%14' }]);
  expect(claudeSessionProcesses('another-session', claudeHome)).toEqual([]);
  expect(sessionHolders(SESSION, { claudeHome })).toEqual([{ pid, pane: '%14' }]);
});

it('matches Claude’s UTC start time on a machine in any zone', async () => {
  // CI runs in UTC, where local and UTC agree and this mistake can't show.
  vi.stubEnv('TZ', 'Asia/Tokyo');
  try {
    const pid = await aProcess();
    sessionFile(pid);
    expect(claudeSessionProcesses(SESSION, claudeHome).map((p) => p.pid)).toEqual([pid]);
  } finally {
    vi.unstubAllEnvs();
  }
});

it('reads a connected process’s Remote Control session, and only a usable one makes a link', async () => {
  const pid = await aProcess();
  sessionFile(pid, { bridgeSessionId: 'session_01AbC' });
  expect(readClaudeProcesses(claudeHome)).toEqual([{ pid, sessionId: SESSION, pane: '%14', bridgeSessionId: 'session_01AbC' }]);
  expect(processRemoteLink({ bridgeSessionId: 'session_01AbC' })).toBe('https://claude.ai/code/session_01AbC');
  expect(processRemoteLink({})).toBeUndefined();
  expect(processRemoteLink({ bridgeSessionId: '../evil' })).toBeUndefined();
  sessionFile(pid, { bridgeSessionId: null });
  expect(readClaudeProcesses(claudeHome)![0]!.bridgeSessionId).toBeUndefined();
  expect(readClaudeProcesses(path.join(home, 'no-claude-home'))).toBeUndefined();
});

it('ignores a stale file: an exited process, a reused pid, or junk', async () => {
  const pid = await aProcess();
  sessionFile(pid);
  children[0]!.kill('SIGKILL');
  await new Promise((resolve) => children[0]!.once('exit', resolve));
  expect(claudeSessionProcesses(SESSION, claudeHome)).toEqual([]);
  const reused = await aProcess();
  if (process.platform !== 'win32') {
    sessionFile(reused, { procStart: 'Sun Oct 11 04:48:12 2020' });
    expect(claudeSessionProcesses(SESSION, claudeHome)).toEqual([]);
  }
  fs.writeFileSync(path.join(claudeHome, 'sessions', '12345.json'), '{broken');
  fs.writeFileSync(path.join(claudeHome, 'sessions', 'peer.json'), JSON.stringify({ sessionId: SESSION, pid: reused }));
  fs.rmSync(path.join(claudeHome, 'sessions', `${reused}.json`), { force: true });
  expect(claudeSessionProcesses(SESSION, claudeHome)).toEqual([]);
  expect(claudeSessionProcesses(SESSION, path.join(home, 'no-claude-home'))).toEqual([]);
});

it('finds a process recorded at sign-on after its trap was stowed, and names the trap', async () => {
  const pid = await aProcess();
  const reg = signOn('early-pebble', { harnessProcess: { pid, startedAt: processStartedAt(pid)! } });
  stowTrap(reg.trapId);
  expect(sessionHolders(SESSION, { claudeHome })).toEqual([{ pid, trap: 'early-pebble' }]);
});

it('counts a trap registered on the session, even with no process known', () => {
  signOn('smooth-gull');
  expect(sessionHolders(SESSION, { claudeHome })).toEqual([{ trap: 'smooth-gull' }]);
});

it('does not list one process twice, whichever record found it', async () => {
  const pid = await aProcess();
  sessionFile(pid);
  signOn('smooth-gull', { harnessProcess: { pid, startedAt: processStartedAt(pid)! } });
  expect(sessionHolders(SESSION, { claudeHome })).toEqual([{ pid, pane: '%14', trap: 'smooth-gull' }]);
});

it('names the trap on the one process it finds, when sign-on recorded none', async () => {
  const pid = await aProcess();
  sessionFile(pid);
  signOn('smooth-gull');
  expect(sessionHolders(SESSION, { claudeHome })).toEqual([{ pid, pane: '%14', trap: 'smooth-gull' }]);
});

it('counts a live listener when nothing else shows a process', async () => {
  const pid = await aProcess();
  fs.mkdirSync(path.join(home, 'watchers'), { recursive: true });
  fs.writeFileSync(path.join(home, 'watchers', `${encodeURIComponent(SESSION)}.json`), JSON.stringify({ sessionId: SESSION, kind: 'trap', pid, heartbeatAt: new Date().toISOString(), trapId: 'bcf9227d' }));
  expect(sessionHolders(SESSION, { claudeHome })).toEqual([{ pid, listener: true, trap: 'wt:bcf9227d' }]);
});

it('says which process holds a session and how to stop it', () => {
  const text = sessionHolderText(SESSION, [{ pid: 6882, pane: '%14', trap: 'smooth-gull' }]);
  expect(text).toContain('session 07201f97 is still open');
  expect(text).toContain('process 6882 (tmux pane %14, trap smooth-gull)');
  expect(text).toContain('`kill 6882`');
  expect(sessionHolderText(SESSION, [{ pid: 9, listener: true }])).toContain(`lobstah soak stop-listener --session ${SESSION}`);
  expect(sessionHolderText(SESSION, [{ trap: 'smooth-gull' }])).toContain('lobstah stow --wt smooth-gull');
});

it('a session can man one trap: a second sign-on refuses and names the first', () => {
  signOn('early-pebble');
  expect(() => signOn('smooth-gull')).toThrow(/already mans trap .*early-pebble/);
});

it('finds the trap a session last signed on as, within a repo', () => {
  const reg = signOn('early-pebble');
  stowTrap(reg.trapId);
  expect(rosterTrapForSession(SESSION, 'r')?.name).toBe('early-pebble');
  expect(rosterTrapForSession(SESSION, 'other')).toBeUndefined();
  expect(rosterTrapForSession('another-session')).toBeUndefined();
});

it('only the trap’s own process ending signs it off', () => {
  const recorded = { pid: 2669, startedAt: 'x' };
  expect(endingProcessOwnsTrap(recorded, 2669)).toBe(true);
  expect(endingProcessOwnsTrap(recorded, 6882)).toBe(false);
  expect(endingProcessOwnsTrap(recorded, undefined)).toBe(true);
  expect(endingProcessOwnsTrap(undefined, 6882)).toBe(true);
});

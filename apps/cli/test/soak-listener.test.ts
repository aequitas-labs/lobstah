import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureLayout, trapBySession } from '@lobstah/core';
import { liveWatcher } from '../src/watchers.js';

// End to end: two traps on one machine, each with a `soak --wait` listener.
// Both run the same command line, so a pattern match cannot tell them apart;
// `soak stop-listener` ends only the caller's, by the pid it recorded.
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const processTest = (name: string, run: () => Promise<void>) => it(name, run, 120_000);

let tmp: string;
let home: string;
let primary: string;
const children: ChildProcess[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function env(): NodeJS.ProcessEnv {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX')));
  return { ...base, LOBSTAH_HOME: home };
}

function run(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: env(), input: '', timeout: 60_000 });
}

/** Sign a session on as a trap from the primary checkout; returns its worktree. */
function signOn(session: string): string {
  const res = run(primary, 'soak', '--session', session, '--harness', 'claude');
  expect(res.status, res.stdout + res.stderr).toBe(0);
  return trapBySession(session)!.worktree;
}

/** Start a session's listener the way a trap should: a tracked child process. */
async function listen(session: string, cwd: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [cli, 'soak', '--wait', '--timeout', '60', '--session', session], {
    cwd, env: env(), stdio: 'ignore',
  });
  children.push(child);
  const deadline = Date.now() + 20_000;
  while (!liveWatcher(session, 'trap')) {
    if (Date.now() > deadline) throw new Error(`listener for ${session} never registered`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return child;
}

const exited = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.once('exit', (code) => resolve(code));
  });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-listener-')));
  home = path.join(tmp, 'home');
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  const origin = path.join(tmp, 'origin.git');
  primary = path.join(tmp, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, primary], { stdio: 'ignore' });
  fs.writeFileSync(path.join(primary, 'f.txt'), 'one\n');
  git(primary, 'add', '.');
  git(primary, 'commit', '-q', '-m', 'init');
  git(primary, 'push', '-q', 'origin', 'HEAD:main');
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = '${primary}'\ntrunk = 'main'\n`);
});
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

describe('soak stop-listener', () => {
  processTest("stops only the calling session's listener", async () => {
    const wtA = signOn(A);
    const wtB = signOn(B);
    const a = await listen(A, wtA);
    const b = await listen(B, wtB);

    const res = run(wtA, 'soak', 'stop-listener', '--session', A);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toContain(`stopped (pid ${a.pid})`);
    await exited(a);
    expect(liveWatcher(A, 'trap')).toBeUndefined();

    // The other trap's listener runs the same command line and keeps listening.
    expect(b.exitCode).toBeNull();
    expect(b.signalCode).toBeNull();
    expect(liveWatcher(B, 'trap')?.pid).toBe(b.pid);
  });

  processTest("resolves the session from the trap's worktree", async () => {
    const wtA = signOn(A);
    const a = await listen(A, wtA);
    const res = run(wtA, 'soak', 'stop-listener');
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toContain(`stopped (pid ${a.pid})`);
    await exited(a);
  });

  processTest('says so when no listener runs', async () => {
    const wtA = signOn(A);
    const res = run(wtA, 'soak', 'stop-listener', '--session', A);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toContain('listener: none');
  });
});

describe('a second soak --wait', () => {
  processTest('refuses while the first listens, naming its pid and the stop command', async () => {
    const wtA = signOn(A);
    const a = await listen(A, wtA);
    const res = run(wtA, 'soak', '--wait', '--timeout', '5', '--session', A);
    const out = res.stdout + res.stderr;
    expect(res.status).not.toBe(0);
    expect(out).toContain(`watcher already armed for session ${A} (pid ${a.pid})`);
    expect(out).toContain(`lobstah soak stop-listener --session ${A}`);
    expect(out).toContain('never pkill');
    // Refused before sign-on: no sign-on block printed.
    expect(out).not.toContain('this session now takes assigned work');
    // The first listener is untouched.
    expect(a.exitCode).toBeNull();
    expect(liveWatcher(A, 'trap')?.pid).toBe(a.pid);
  });

  processTest('starts once the first is stopped', async () => {
    const wtA = signOn(A);
    const a = await listen(A, wtA);
    expect(run(wtA, 'soak', 'stop-listener', '--session', A).status).toBe(0);
    await exited(a);
    const again = await listen(A, wtA);
    expect(liveWatcher(A, 'trap')?.pid).toBe(again.pid);
  });
});

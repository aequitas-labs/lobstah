import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureLayout, listTraps, processStartedAt, type HarnessProcess, type TrapRegistration } from '@lobstah/core';
import { removeTempDir } from '../../../test/temp-dir.js';

// Stow ends a Codex trap's process: Codex lets one process write a thread,
// so a process left running blocks the resume of the next throw.
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const SESSION = '11111111-2222-4333-8444-000000000077';

let tmp: string;
let home: string;
let primary: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-stow-codex-')));
  home = path.join(tmp, 'home');
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  const origin = path.join(tmp, 'origin.git');
  primary = path.join(tmp, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, primary], { stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: primary });
  execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: primary, stdio: 'ignore' });
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = '${primary}'\ntrunk = 'main'\n`);
});
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  removeTempDir(tmp);
  delete process.env.LOBSTAH_HOME;
});

function lobstah(cwd: string, ...args: string[]) {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX') && k !== 'TERM_PROGRAM' && k !== '__CFBundleIdentifier' && k !== 'LOBSTAH_TRAP_TICKET'),
  );
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...base, LOBSTAH_HOME: home }, input: '', timeout: 60_000 });
}

/** A stand-in for the Codex process: node, optionally ignoring SIGINT. */
async function codexProcess(ignoreInterrupt = false): Promise<HarnessProcess> {
  const body = `${ignoreInterrupt ? "process.on('SIGINT', () => {});" : ''} setInterval(() => {}, 1000); console.log('up');`;
  const child = spawn(process.execPath, ['-e', body], { stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(child);
  await new Promise((resolve) => child.stdout!.once('data', resolve));
  return { pid: child.pid!, startedAt: processStartedAt(child.pid!)! };
}

/** A Codex trap signed on in its own worktree, its registration naming `proc`. */
function codexTrap(proc: HarnessProcess): TrapRegistration {
  const res = lobstah(primary, 'soak', '--session', SESSION, '--harness', 'codex', '--name', 'grey-tern');
  expect(res.status, res.stderr).toBe(0);
  const reg = listTraps().find((t) => t.name === 'grey-tern')!;
  const file = path.join(home, 'soaking', `${reg.trapId}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...reg, harnessProcess: proc }, null, 2));
  return reg;
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
const waitExit = (child: ChildProcess) => (exited(child) ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve)));

describe('stow ends a Codex trap’s process', () => {
  it('a stow from outside the trap interrupts its Codex process', async () => {
    const proc = await codexProcess();
    codexTrap(proc);
    const res = lobstah(tmp, 'stow', '--wt', 'grey-tern');
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain(`process: ended (codex pid ${proc.pid})`);
    await waitExit(children[0]!);
  }, 60_000);

  it('a process that ignores the interrupt is killed after the grace', async () => {
    const proc = await codexProcess(true);
    codexTrap(proc);
    const res = lobstah(tmp, 'stow', '--wt', 'grey-tern');
    expect(res.status, res.stderr).toBe(0);
    // Windows has no catchable SIGINT: the interrupt already ends it.
    expect(res.stdout).toContain(`process: ${process.platform === 'win32' ? 'ended' : 'killed'} (codex pid ${proc.pid})`);
    await waitExit(children[0]!);
  }, 60_000);

  it('a trap that stows itself keeps its session running', async () => {
    const proc = await codexProcess();
    const reg = codexTrap(proc);
    const res = lobstah(reg.worktree, 'stow', '--session', SESSION);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).not.toContain('process:');
    expect(exited(children[0]!)).toBe(false);
  }, 60_000);
});

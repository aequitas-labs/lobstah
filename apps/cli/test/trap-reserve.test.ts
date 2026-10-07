import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { closeRequest, ensureLayout, listReservations, listTraps, queuedDescriptor, readTrapAnchor, reserveTrap, writeRequest, type TrapRegistration } from '@lobstah/core';

// End to end: reservations (what `man throw` makes) and soak --ticket through the built CLI, against
// a throwaway repo with a bare origin. Every test has its own LOBSTAH_HOME.
// Kept apart from soak-worktree.test.ts: each file's synchronous CLI runs
// block its vitest worker, and one file must stay well under the worker's
// 60-second RPC timeout on Windows.
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const SESSION = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';

/** Each test spawns git and the CLI several times. */
const processTest = (name: string, run: () => void) => it(name, run, 90_000);

let tmp: string;
let home: string;
let origin: string;
let primary: string;
let outside: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** config.toml with repo `r`; single-quoted TOML strings keep Windows paths literal. */
function config(extra = '', limits = ''): void {
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    `${limits}[repos.r]\npath = '${primary}'\ntrunk = 'main'\n${extra}`,
  );
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-trapres-')));
  home = path.join(tmp, 'home');
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  origin = path.join(tmp, 'origin.git');
  primary = path.join(tmp, 'repo');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, primary], { stdio: 'ignore' });
  fs.writeFileSync(path.join(primary, 'f.txt'), 'one\n');
  fs.writeFileSync(path.join(primary, '.gitignore'), 'build/\n');
  git(primary, 'add', '.');
  git(primary, 'commit', '-q', '-m', 'init');
  git(primary, 'push', '-q', 'origin', 'HEAD:main');
  config();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

/** Run the CLI in `cwd` with no harness environment of its own. */
function lobstah(cwd: string, ...args: string[]) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX')));
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...base, LOBSTAH_HOME: home },
    input: '',
    timeout: 60_000,
  });
}

const soak = (cwd: string, ...args: string[]) => lobstah(cwd, 'soak', '--session', SESSION, '--harness', 'claude', ...args);
const kv = (out: string, key: string) => new RegExp(`^${key}: (.*)$`, 'm').exec(out)?.[1]?.replace(/^"(.*)"$/, '$1');
const soakDirs = () => fs.readdirSync(path.join(home, 'worktrees')).filter((n) => n.startsWith('soak-'));
const only = (): TrapRegistration => {
  const traps = listTraps();
  expect(traps).toHaveLength(1);
  return traps[0]!;
};

describe('reservations and soak --ticket', () => {
  /** The CLI with extra environment (a ticket in LOBSTAH_TRAP_TICKET). */
  const withEnv = (cwd: string, env: Record<string, string>, ...args: string[]) => {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX')));
    return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...base, LOBSTAH_HOME: home, ...env }, input: '', timeout: 60_000 });
  };
  const reserve = (opts: { name?: string; harness?: string } = {}) => {
    const { reservation, ticket } = reserveTrap({ repo: 'r', ...opts });
    return { name: reservation.name, trap: `wt:${reservation.trapId}`, ticket };
  };

  processTest('a starting trap is seen by dispatch --for and man tend before any session; trap reserve is gone', () => {
    const r = reserve({ name: 'amber-gull', harness: 'claude' });
    expect(r.name).toBe('amber-gull');
    expect(listTraps()).toEqual([]);
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
    const sent = lobstah(primary, 'dispatch', '--repo', 'r', '--id', id, '--brief-text', 'do it', '--for', 'amber-gull');
    expect(sent.status, sent.stderr).toBe(0);
    expect(`${sent.stdout}${sent.stderr}`).toContain('is starting (reserved, not signed on)');
    expect(queuedDescriptor(id, 'work')?.for).toBe(r.trap);
    const tend = JSON.parse(lobstah(primary, 'man', 'tend', '--json').stdout) as { traps: Array<{ name?: string; state?: string }> };
    expect(tend.traps.find((t) => t.name === 'amber-gull')?.state).toBe('starting');
    expect(lobstah(outside, 'trap', 'reserve', '--repo', 'r').status).toBe(2);
    expect(lobstah(outside, 'trap', 'requests').status).toBe(2);
  });

  processTest('soak --ticket signs on as the reserved name and id; the ticket redeems once', () => {
    const r = reserve({ name: 'amber-gull' });
    const res = soak(primary, '--ticket', r.ticket);
    expect(res.status, res.stderr).toBe(0);
    expect(kv(res.stdout, 'name')).toBe('amber-gull');
    expect(kv(res.stdout, 'trap')).toBe(r.trap);
    expect(res.stdout).toMatch(/^ticket: /m);
    const reg = only();
    expect(`wt:${reg.trapId}`).toBe(r.trap);
    expect(soakDirs()).toEqual([`soak-${reg.trapId}`]);
    expect(readTrapAnchor(reg.worktree)).toMatchObject({ trapId: reg.trapId, name: 'amber-gull', createdBy: 'soak', sessionId: SESSION });
    expect(fs.existsSync(path.join(home, 'soaking', `${reg.trapId}.starting`))).toBe(false);
    // The same session re-running with the spent ticket is a no-op re-sign.
    expect(soak(primary, '--ticket', r.ticket).status).toBe(0);
    // Another session cannot use it.
    const other = lobstah(primary, 'soak', '--session', OTHER, '--harness', 'claude', '--ticket', r.ticket);
    expect(other.status).not.toBe(0);
    expect(other.stdout + other.stderr).toContain('redeems no reserved trap');
    expect(only().sessionId).toBe(SESSION);
  });

  processTest('redeems a ticket from LOBSTAH_TRAP_TICKET, and ignores a spent one there', () => {
    const r = reserve();
    const res = withEnv(primary, { LOBSTAH_TRAP_TICKET: r.ticket }, 'soak', '--session', SESSION, '--harness', 'claude');
    expect(res.status, res.stderr).toBe(0);
    expect(kv(res.stdout, 'trap')).toBe(r.trap);
    // A clean, pushed checkout can be removed; a no-upstream checkout is kept.
    git(only().worktree, 'branch', '--set-upstream-to=origin/main');
    const stowed = lobstah(primary, 'stow', '--session', SESSION, '--remove');
    expect(stowed.status, stowed.stderr).toBe(0);
    expect(stowed.stdout).toMatch(/^worktree: removed$/m);
    // The session stays alive with the spent ticket in its environment: soak works as usual.
    const again = withEnv(primary, { LOBSTAH_TRAP_TICKET: r.ticket }, 'soak', '--session', SESSION, '--harness', 'claude');
    expect(again.status, again.stderr).toBe(0);
    expect(kv(again.stdout, 'trap')).not.toBe(r.trap);
  });

  processTest('a session that already mans a trap cannot redeem another; stow --wt withdraws a reservation', () => {
    expect(soak(primary).status).toBe(0);
    const r = reserve({ name: 'amber-gull' });
    const res = soak(primary, '--ticket', r.ticket);
    expect(res.status).not.toBe(0);
    expect(res.stdout + res.stderr).toContain('already mans trap');
    const stow = lobstah(outside, 'stow', '--wt', 'amber-gull');
    expect(stow.status, stow.stderr).toBe(0);
    expect(stow.stdout).toContain(`withdrawn: ${r.trap}`);
    expect(lobstah(primary, 'soak', '--session', OTHER, '--harness', 'claude', '--ticket', r.ticket).status).not.toBe(0);
  });
});

describe('trap requests from the glass', () => {
  processTest('man throw --new --request takes the request\'s repo and harness; flags may repeat it, never contradict it', () => {
    const req = writeRequest('trap-request', { repo: 'r', harness: 'codex' });
    const dry = lobstah(outside, 'man', 'throw', '--new', '--request', req.id, '--dry-run');
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('new: 1 fresh r trap(s)');
    expect(dry.stdout).toContain(',r,new,codex,');
    expect(dry.stdout).toContain("$lobstah:trap soak --ticket <ticket>");
    expect(lobstah(outside, 'man', 'throw', '--new', '--request', req.id, '--harness', 'claude', '--dry-run').status).toBe(2);
    expect(lobstah(outside, 'man', 'throw', '--new', '--request', req.id, '--harness', 'codex', '--dry-run').status).toBe(0);
    closeRequest(req.id, 'thrown');
    const again = lobstah(outside, 'man', 'throw', '--new', '--request', req.id, '--dry-run');
    expect(again.status).not.toBe(0);
    expect(again.stdout + again.stderr).toContain('already closed');
    expect(lobstah(outside, 'man', 'throw', '--new', '--request', '00000000-0000-4000-8000-000000000000', '--dry-run').status).not.toBe(0);
    expect(listReservations()).toHaveLength(0);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setImmediate as yieldToWorker } from 'node:timers/promises';
import {
  ensureLayout,
  listNotices,
  listTraps,
  loadConfig,
  planThrow,
  readReservation,
  readRoster,
  readSessionClaim,
  readTrap,
  readTrapAnchor,
  setRosterProfile,
  TrapStartingError,
  type RosterEntry,
  type ThrowPlanRow,
  type TrapRegistration,
} from '@lobstah/core';
import { launchShellText, startCommand, throwTrap, ThrowTimeoutError, type TerminalAdapter, type TerminalLaunch } from '../src/throw.js';
import { removeTempDir } from '../../../test/temp-dir.js';

// A throw through the real reservation, checkout, and sign-on paths. Only
// the terminal is fake: its adapter runs what a launched session would,
// `soak --ticket` and `soak --wait`, through the built CLI.
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const SESSION = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';
const processTest = (name: string, run: () => Promise<void> | void) => it(name, run, 120_000);

let tmp: string;
let home: string;
let claudeHome: string;
let primary: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-throw-')));
  home = path.join(tmp, 'home');
  claudeHome = path.join(tmp, 'claude');
  process.env.LOBSTAH_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
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
afterEach(async () => {
  await yieldToWorker();
  removeTempDir(tmp);
  delete process.env.LOBSTAH_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
});

function lobstah(cwd: string, ...args: string[]) {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX') && k !== 'TERM_PROGRAM' && k !== '__CFBundleIdentifier' && k !== 'LOBSTAH_TRAP_TICKET'),
  );
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...base, LOBSTAH_HOME: home, CLAUDE_CONFIG_DIR: claudeHome }, input: '', timeout: 60_000 });
}

const only = (): TrapRegistration => {
  const traps = listTraps();
  expect(traps).toHaveLength(1);
  return traps[0]!;
};

/** A trap that signed on, listened once, and stowed. */
function stowedTrap(): TrapRegistration {
  expect(lobstah(primary, 'soak', '--session', SESSION, '--harness', 'claude', '--name', 'amber-gull').status).toBe(0);
  const reg = only();
  lobstah(reg.worktree, 'soak', '--session', SESSION, '--wait', '--timeout', '1');
  return reg;
}
function stow(reg: TrapRegistration, keep: boolean): void {
  const res = lobstah(reg.worktree, 'stow', '--session', reg.sessionId, ...(keep ? [] : ['--remove']));
  expect(res.status, res.stderr).toBe(0);
}

function claudeTranscript(cwd: string, session: string): void {
  const dir = path.join(claudeHome, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session}.jsonl`), '{}\n');
}

/** A terminal that runs what the launched session would: redeem the ticket, then park once. */
function fakeTerminal(session: string, seen: TerminalLaunch[], waitOut: string[] = [], meanwhile?: () => void): (app: 'terminal' | 'iterm') => TerminalAdapter {
  return (app) => ({
    app,
    async launch(launch) {
      seen.push(launch);
      meanwhile?.();
      const ticket = /--ticket (\S+)/.exec(launch.argv.at(-1)!)![1]!;
      const on = lobstah(launch.cwd, 'soak', '--ticket', ticket, '--session', session, '--harness', 'claude');
      expect(on.status, on.stderr || on.stdout).toBe(0);
      const park = lobstah(launch.cwd, 'soak', '--session', session, '--wait', '--timeout', '2');
      waitOut.push(park.stdout);
    },
  });
}
const idle = (seen: TerminalLaunch[]) => (app: 'terminal' | 'iterm'): TerminalAdapter => ({ app, launch: async (l) => void seen.push(l) });

describe('man throw <name>', () => {
  processTest('resumes from the transcript directory, returns under the same id and name, and takes --for work', async () => {
    const reg = stowedTrap();
    stow(reg, true);
    claudeTranscript(reg.worktree, SESSION);
    // While the throw starts, the reserved name takes addressed work.
    const address = () => {
      const sent = lobstah(primary, 'dispatch', '--repo', 'r', '--id', 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001', '--brief-text', 'do it', '--for', 'amber-gull');
      expect(sent.status, sent.stderr).toBe(0);
      expect(sent.stdout + sent.stderr).toContain('is starting');
    };
    const [planned] = planThrow(loadConfig(), { names: ['amber-gull'] });
    expect(planned).toMatchObject({ action: 'resume', checkout: 'kept', resumeFrom: reg.worktree });

    const seen: TerminalLaunch[] = [];
    const out: string[] = [];
    const result = await throwTrap({ address: 'amber-gull', cfg: loadConfig(), adapter: fakeTerminal(SESSION, seen, out, address), pollMs: 50, timeoutSecs: 30 });
    expect(result).toMatchObject({ action: 'resume', checkout: 'kept', terminal: 'terminal', harness: 'claude' });
    expect(seen[0]!.cwd).toBe(reg.worktree);
    expect(seen[0]!.argv.slice(0, 3)).toEqual(['claude', '--resume', SESSION]);
    expect(result.command).toContain('<ticket>');
    expect(only()).toMatchObject({ trapId: reg.trapId, name: 'amber-gull', sessionId: SESSION, worktree: reg.worktree });
    expect(readReservation(reg.trapId)).toBeUndefined();
    expect(readRoster(reg.trapId)).toMatchObject({ state: 'live', name: 'amber-gull' });
    // The addressed work reached the thrown trap at its first park.
    expect(out.join('')).toContain('aaaaaaaa-bbbb-4ccc-8ddd-000000000001');
    expect(readSessionClaim('aaaaaaaa-bbbb-4ccc-8ddd-000000000001', 'work')?.by).toBe(`wt:${reg.trapId}`);
  });

  processTest('recreates a removed checkout from the protected ref and starts cold without saved history', async () => {
    const reg = stowedTrap();
    fs.writeFileSync(path.join(reg.worktree, 'work.txt'), 'done\n');
    git(reg.worktree, 'add', 'work.txt');
    git(reg.worktree, 'commit', '-q', '-m', 'work');
    git(reg.worktree, 'push', '-q', '-u', 'origin', 'HEAD');
    const head = git(reg.worktree, 'rev-parse', 'HEAD');
    stow(reg, false);
    expect(fs.existsSync(reg.worktree)).toBe(false);

    const seen: TerminalLaunch[] = [];
    const result = await throwTrap({ address: 'amber-gull', cfg: loadConfig(), adapter: fakeTerminal(OTHER, seen), pollMs: 50, timeoutSecs: 30 });
    expect(result).toMatchObject({ action: 'cold', checkout: 'recreated' });
    expect(result.why).toContain('no saved Claude history');
    expect(seen[0]!.cwd).toBe(reg.worktree);
    expect(seen[0]!.argv).not.toContain('--resume');
    expect(git(reg.worktree, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(reg.worktree, 'branch', '--show-current')).toBe(`lobstah/soak-${reg.trapId}`);
    expect(readTrapAnchor(reg.worktree)).toMatchObject({ trapId: reg.trapId, name: 'amber-gull', createdBy: 'soak' });
    expect(only()).toMatchObject({ trapId: reg.trapId, name: 'amber-gull', sessionId: OTHER, createdWorktree: true });
    expect(readRoster(reg.trapId)).toMatchObject({ state: 'live', sessionId: OTHER, head });
  });

  processTest('refuses a second launch: while one is starting, and while the trap is live', async () => {
    const reg = stowedTrap();
    stow(reg, true);
    const seen: TerminalLaunch[] = [];
    const first = throwTrap({ address: 'amber-gull', cfg: loadConfig(), adapter: idle(seen), pollMs: 50, timeoutSecs: 2 });
    await expect(throwTrap({ address: 'amber-gull', cfg: loadConfig(), adapter: idle(seen), pollMs: 50, timeoutSecs: 2 })).rejects.toThrow(TrapStartingError);
    await expect(first).rejects.toThrow(ThrowTimeoutError);
    expect(seen).toHaveLength(1);

    expect(lobstah(reg.worktree, 'soak', '--session', SESSION).status).toBe(0);
    const live = throwTrap({ address: 'amber-gull', cfg: loadConfig(), adapter: idle(seen), pollMs: 50, timeoutSecs: 2 });
    await expect(live).rejects.toThrow(/not throwing amber-gull .*live: session/);
    expect(seen).toHaveLength(1);
    const cli = lobstah(primary, 'man', 'throw', 'amber-gull');
    expect(cli.status).not.toBe(0);
    expect(cli.stdout + cli.stderr).toContain('refused: not throwing amber-gull');
  });

  processTest('a timeout withdraws the reservation and leaves the roster as it was', async () => {
    const reg = stowedTrap();
    stow(reg, true);
    const before = readRoster(reg.trapId)!;
    const seen: TerminalLaunch[] = [];
    await expect(throwTrap({ address: 'amber-gull', cfg: loadConfig(), adapter: idle(seen), pollMs: 50, timeoutSecs: 1 })).rejects.toThrow(/did not sign on within 1s/);
    expect(readReservation(reg.trapId)).toBeUndefined();
    expect(readTrap(reg.trapId)).toBeUndefined();
    expect(readRoster(reg.trapId)).toEqual(before);
    expect(planThrow(loadConfig(), { names: ['amber-gull'] })[0]!.action).toBe('cold');
    expect(listNotices().some((n) => n.kind === 'trap-start-failed' && n.refId === reg.trapId)).toBe(true);
    // The ticket the session was given no longer redeems.
    const ticket = /--ticket (\S+)/.exec(seen[0]!.argv.at(-1)!)![1]!;
    expect(lobstah(reg.worktree, 'soak', '--ticket', ticket, '--session', OTHER, '--harness', 'claude').status).not.toBe(0);
  });

  processTest('a profile naming an unsupported terminal fails before anything is reserved', async () => {
    const reg = stowedTrap();
    stow(reg, true);
    const file = path.join(home, 'roster', `${reg.trapId}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...readRoster(reg.trapId), profile: { terminal: 'kitty' } }));
    await expect(throwTrap({ address: 'amber-gull', cfg: loadConfig(), adapter: idle([]), pollMs: 50, timeoutSecs: 1 })).rejects.toThrow(/terminal "kitty" \(profile\) is not supported/);
    expect(readReservation(reg.trapId)).toBeUndefined();
    setRosterProfile(reg.trapId, { terminal: 'iterm' });
    expect(planThrow(loadConfig(), { names: ['amber-gull'] })[0]).toMatchObject({ terminal: 'iterm', terminalFrom: 'profile' });
  });
});

describe('the start command', () => {
  const entry = { trapId: 'abcd1234', name: 'amber-gull', worktree: '/w/soak-abcd1234', harness: 'claude', sessionId: 'sess-1' } as RosterEntry;
  const row = (r: Partial<ThrowPlanRow>): ThrowPlanRow => ({ trapId: 'abcd1234', name: 'amber-gull', action: 'cold', why: '', ...r });

  it('builds claude and codex argv from the profile', () => {
    const claude = startCommand(row({ action: 'resume', resumeFrom: '/repo', harness: 'claude', model: 'opus', config: { effort: 'high', permissionMode: 'acceptEdits', fast: 'on' } }), entry, 'T');
    expect(claude).toEqual({
      cwd: '/repo',
      env: { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' },
      argv: ['claude', '--resume', 'sess-1', '--model', 'opus', '--effort', 'high', '--permission-mode', 'acceptEdits', '/lobstah:trap soak --ticket T'],
      unapplied: ['fast'],
    });
    const codex = startCommand(row({ action: 'resume', resumeFrom: '/w/soak-abcd1234', harness: 'codex', model: 'gpt-5.5', config: { effort: 'high', permissionMode: 'default' } }), entry, 'T');
    expect(codex.argv).toEqual(['codex', '-m', 'gpt-5.5', '-c', 'model_reasoning_effort="high"', 'resume', 'sess-1', '$lobstah:trap soak --ticket T']);
    expect(codex.unapplied).toEqual(['permissionMode']);
    expect(startCommand(row({ harness: 'claude' }), entry, 'T')).toMatchObject({ cwd: '/w/soak-abcd1234', argv: ['claude', '/lobstah:trap soak --ticket T'] });
  });

  it('quotes every word of the shell text a terminal runs', () => {
    expect(launchShellText({ cwd: "/tmp/it's here", env: { A: 'x y' }, argv: ['claude', '$lobstah:trap soak --ticket T'] })).toBe(
      `cd '/tmp/it'\\''s here' && A='x y' claude '$lobstah:trap soak --ticket T'`,
    );
  });
});

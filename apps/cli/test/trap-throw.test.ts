import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setImmediate as yieldToWorker } from 'node:timers/promises';
import {
  ensureLayout,
  expireReservations,
  listNotices,
  listTraps,
  loadConfig,
  lobstahHome,
  planThrow,
  readReservation,
  readRoster,
  readSessionClaim,
  readTrap,
  readTrapAnchor,
  setRosterProfile,
  TrapStartingError,
  type Config,
  type RosterEntry,
  type ThrowPlanRow,
  type TrapRegistration,
} from '@lobstah/core';
import { freshProfile, harnessCommand, launchShellText, nextStartMode, startCommand, startMode, startTimeoutSecs, launchedText, throwTrap, trapForRepo, throwNew, trapWritableDirs, ThrowTimeoutError, type TerminalAdapter, type TerminalLaunch } from '../src/throw.js';
import { trapRows } from '../src/trap-list.js';
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
  processTest('trap-any brings back the same stowed trap instead of creating another checkout', async () => {
    const reg = stowedTrap();
    stow(reg);
    claudeTranscript(reg.worktree, SESSION);
    const seen: TerminalLaunch[] = [];
    const choice = await trapForRepo({ cfg: loadConfig(), repo: 'r', adapter: fakeTerminal(SESSION, seen), timeoutSecs: 30 });
    expect(choice).toMatchObject({ action: 'resumed', registration: { trapId: reg.trapId, worktree: reg.worktree } });
    expect(seen).toHaveLength(1);
    expect(listTraps()).toHaveLength(1);
  });

  processTest('a justified fresh throw records its reason through ticket sign-on into the roster', async () => {
    stowedTrap();
    const seen: TerminalLaunch[] = [];
    await expect(throwNew({ cfg: loadConfig(), repo: 'r', adapter: fakeTerminal(OTHER, seen) })).rejects.toThrow('--reason');
    expect(seen).toHaveLength(0);
    const result = await throwNew({ cfg: loadConfig(), repo: 'r', reason: 'isolated second workload', adapter: fakeTerminal(OTHER, seen), timeoutSecs: 30 });
    expect(readRoster(result.registration.trapId)?.creationReason).toBe('isolated second workload');
    stow(result.registration);
    expect(readRoster(result.registration.trapId)?.creationReason).toBe('isolated second workload');
  });
  processTest('a configured bypass starts the throw with no permission checks, and the roster and trap list say so', async () => {
    fs.appendFileSync(path.join(home, 'config.toml'), `\n[harness]\npermissionMode = "bypass"\n`);
    const seen: TerminalLaunch[] = [];
    const result = await throwNew({ cfg: loadConfig(), repo: 'r', adapter: fakeTerminal(OTHER, seen), timeoutSecs: 30 });
    expect(result.mode).toBe('bypassPermissions');
    expect(seen[0]!.argv).toContain('--dangerously-skip-permissions');
    expect(seen[0]!.argv).not.toContain('--permission-mode');
    expect(readRoster(result.registration.trapId)?.startMode).toBe('bypassPermissions');
    expect(trapRows().find((r) => r.trap === `wt:${result.registration.trapId}`)?.worker).toMatch(/ · bypassPermissions$/);
    expect(lobstah(primary, 'man', 'roster').stdout).toMatch(/,claude,,bypassPermissions,/);
    fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = '${primary}'\ntrunk = 'main'\n[repos.r.harness]\npermissionMode = "sometimes"\n`);
    expect(() => loadConfig()).toThrow(/\[repos\.r\.harness\]\.permissionMode must be one of auto, bypass/);
  });

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
    expect(readRoster(reg.trapId)).toMatchObject({ state: 'live', name: 'amber-gull', startMode: 'auto' });
    // It started in auto mode, and says so: the throw, the roster, and the trap's worker label.
    expect(result.mode).toBe('auto');
    expect(seen[0]!.argv).toContain('auto');
    expect(trapRows().find((r) => r.name === 'amber-gull')?.worker).toMatch(/ · auto$/);
    expect(lobstah(primary, 'man', 'roster').stdout).toMatch(/amber-gull \(wt:[0-9a-f]+\),r,[^\n]*,claude,,auto,/);
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

  processTest('a timed-out Codex launch keeps its ticket, fences retries, and accepts late first park', async () => {
    const reg = stowedTrap();
    stow(reg, true);
    setRosterProfile(reg.trapId, { harness: 'codex' });
    const cfg = loadConfig();
    cfg.soak.codexStartSecs = 1;
    const seen: TerminalLaunch[] = [];
    let launchText = '';
    await expect(throwTrap({ address: 'amber-gull', cfg, batch: 'late-codex', adapter: idle(seen), pollMs: 50, onLaunch: (l) => { launchText = launchedText(l); } })).rejects.toThrow(/ticket remains valid for late sign-on/);
    expect(launchText).toContain('up to 1s');
    const held = readReservation(reg.trapId)!;
    expect(Date.parse(held.deadline) - Date.parse(held.reservedAt)).toBe(1000);
    await expect(throwTrap({ address: 'amber-gull', cfg, adapter: idle(seen) })).rejects.toThrow(TrapStartingError);
    expect(seen).toHaveLength(1);
    expireReservations(Date.parse(held.deadline) + 1);
    const ticket = /--ticket (\S+)/.exec(seen[0]!.argv.at(-1)!)![1]!;
    const on = lobstah(reg.worktree, 'soak', '--ticket', ticket, '--session', OTHER, '--harness', 'codex');
    expect(on.status, on.stderr || on.stdout).toBe(0);
    lobstah(reg.worktree, 'soak', '--session', OTHER, '--wait', '--timeout', '1');
    expect(readTrap(reg.trapId)).toMatchObject({ sessionId: OTHER, harness: 'codex', firstParkedAt: expect.any(String) });
    expect(readReservation(reg.trapId)).toBeUndefined();
    expect(listNotices().some((n) => n.kind === 'trap-available' && n.refId === reg.trapId && !n.quiet)).toBe(true);
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

  it('uses the configured Codex startup window unless --timeout overrides it', () => {
    const cfg = loadConfig();
    expect(startTimeoutSecs({ cfg }, 'codex')).toBe(600);
    expect(startTimeoutSecs({ cfg }, 'claude')).toBe(180);
    cfg.soak.codexStartSecs = 900;
    expect(startTimeoutSecs({ cfg }, 'codex')).toBe(900);
    expect(startTimeoutSecs({ cfg, timeoutSecs: 15 }, 'codex')).toBe(15);
  });

  it('builds claude and codex argv from the profile', () => {
    const claude = startCommand(row({ action: 'resume', resumeFrom: '/repo', harness: 'claude', model: 'opus', config: { effort: 'high', permissionMode: 'acceptEdits', fast: 'on' } }), entry, 'T');
    expect(claude).toEqual({
      cwd: '/repo',
      env: { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' },
      argv: ['claude', '--resume', 'sess-1', '--model', 'opus', '--permission-mode', 'acceptEdits', '--effort', 'high', '/lobstah:trap soak --ticket T'],
      unapplied: ['fast'],
      mode: 'acceptEdits',
    });
    const codex = startCommand(row({ action: 'resume', resumeFrom: '/w/soak-abcd1234', harness: 'codex', model: 'gpt-5.5', config: { effort: 'high', permissionMode: 'default' } }), entry, 'T');
    expect(codex.argv).toEqual(['codex', '-c', 'tui.terminal_title=[]', '-m', 'gpt-5.5', '-c', 'model_reasoning_effort="high"', 'resume', 'sess-1', '$lobstah:trap soak --ticket T']);
    expect(codex).toMatchObject({ unapplied: [], mode: 'default' });
    expect(startCommand(row({ harness: 'claude' }), entry, 'T')).toMatchObject({ cwd: '/w/soak-abcd1234', argv: ['claude', '--permission-mode', 'auto', '/lobstah:trap soak --ticket T'] });
  });

  it('starts every trap in auto mode by default; a roster permissionMode overrides; bypass wins', () => {
    const base = { cwd: '/w', ticket: 'T' };
    expect(harnessCommand({ ...base, harness: 'claude' })).toMatchObject({ argv: ['claude', '--permission-mode', 'auto', '/lobstah:trap soak --ticket T'], mode: 'auto' });
    expect(harnessCommand({ ...base, harness: 'codex', writableDirs: ['/home/.lobstah', '/repo/.git'] })).toMatchObject({
      argv: ['codex', '-c', 'tui.terminal_title=[]', '--approve-for-me', '-c', 'sandbox_workspace_write.network_access=true', '--add-dir', '/home/.lobstah', '--add-dir', '/repo/.git', '$lobstah:trap soak --ticket T'],
      mode: 'auto',
      unapplied: [],
    });
    // The roster profile's mode, as today.
    expect(harnessCommand({ ...base, harness: 'claude', config: { permissionMode: 'plan' } }).argv).toEqual(['claude', '--permission-mode', 'plan', '/lobstah:trap soak --ticket T']);
    expect(harnessCommand({ ...base, harness: 'codex', config: { permissionMode: 'acceptEdits' } })).toMatchObject({
      argv: ['codex', '-c', 'tui.terminal_title=[]', '$lobstah:trap soak --ticket T'],
      unapplied: ['permissionMode=acceptEdits'],
    });
    // `man throw --bypass`, over any profile.
    expect(harnessCommand({ ...base, harness: 'claude', config: { permissionMode: 'plan' }, bypass: true })).toMatchObject({
      argv: ['claude', '--dangerously-skip-permissions', '/lobstah:trap soak --ticket T'],
      mode: 'bypassPermissions',
    });
    // `bypass` is a mode a profile or the config can name.
    expect(harnessCommand({ ...base, harness: 'claude', config: { permissionMode: 'bypass' } }).argv).toEqual(['claude', '--dangerously-skip-permissions', '/lobstah:trap soak --ticket T']);
    expect(harnessCommand({ ...base, harness: 'codex', config: { permissionMode: 'bypassPermissions' } }).argv).toEqual(['codex', '-c', 'tui.terminal_title=[]', '--dangerously-bypass-approvals-and-sandbox', '$lobstah:trap soak --ticket T']);
    expect(harnessCommand({ ...base, harness: 'codex', bypass: true, writableDirs: ['/x'] }).argv).toEqual(['codex', '-c', 'tui.terminal_title=[]', '--dangerously-bypass-approvals-and-sandbox', '$lobstah:trap soak --ticket T']);
    expect([startMode(), startMode({ permissionMode: 'plan' }), startMode({ permissionMode: 'plan', bypass: 'true' }), startMode({}, true)]).toEqual([
      'auto',
      'plan',
      'bypassPermissions',
      'bypassPermissions',
    ]);
  });

  it('takes the configured mode: the roster profile, then the repo, then [harness], then auto', () => {
    const cfg = (global?: string, repo?: string) =>
      ({ harness: global ? { permissionMode: global } : {}, repos: { r: { path: '/r', trunk: 'main', ...(repo ? { harness: { permissionMode: repo } } : {}) } } }) as unknown as Config;
    expect(nextStartMode(cfg(), { repo: 'r' })).toBe('auto');
    expect(nextStartMode(cfg('bypass'), { repo: 'r' })).toBe('bypassPermissions');
    expect(nextStartMode(cfg('bypass', 'auto'), { repo: 'r' })).toBe('auto');
    expect(nextStartMode(cfg('bypass', 'auto'), { repo: 'other' })).toBe('bypassPermissions');
    expect(nextStartMode(cfg('bypass'), { repo: 'r', profile: { config: { permissionMode: 'plan' } } })).toBe('plan');
    expect(freshProfile(cfg('bypass'), 'r')).toMatchObject({ config: { permissionMode: 'bypassPermissions' } });
    expect(freshProfile(cfg(), 'r').config).toBeUndefined();
  });

  it('gives a Codex trap lobstah home and the repo git directory to write', () => {
    const dirs = trapWritableDirs(process.cwd());
    expect(dirs[0]).toBe(lobstahHome());
    expect(dirs).toHaveLength(2);
    expect(path.isAbsolute(dirs[1]!)).toBe(true);
    expect(trapWritableDirs(os.tmpdir())).toEqual([lobstahHome()]);
  });

  it('quotes every word of the shell text a terminal runs', () => {
    expect(launchShellText({ cwd: "/tmp/it's here", env: { A: 'x y' }, argv: ['claude', '$lobstah:trap soak --ticket T'] })).toBe(
      `cd '/tmp/it'\\''s here' && A='x y' claude '$lobstah:trap soak --ticket T'`,
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
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
  recordRosterDeparture,
  readRoster,
  readSessionClaim,
  readTrap,
  readTrapAnchor,
  setRosterProfile,
  trapLabel,
  TrapStartingError,
  type Config,
  type RosterEntry,
  type ThrowPlanRow,
  type TrapRegistration,
} from '@lobstah/core';
import { freshProfile, harnessCommand, launchShellText, nextStartMode, onCodexServer, startCommand, startMode, startTimeoutSecs, launchedText, throwTrap, trapForRepo, throwNew, ThrowTimeoutError, type StartCommand, type TerminalAdapter, type TerminalLaunch } from '../src/throw.js';
import { trapRows } from '../src/trap-list.js';
import { buildGlassSnapshot } from '../src/glass.js';
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
  lobstah(reg.worktree, 'soak', '--session', SESSION, '--wait', '--timeout', '0');
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
      const on = lobstah(launch.cwd, 'soak', '--ticket', ticket, '--session', session, '--harness', launch.argv[0]!);
      expect(on.status, on.stderr || on.stdout).toBe(0);
      const park = lobstah(launch.cwd, 'soak', '--session', session, '--wait', '--timeout', '0');
      waitOut.push(park.stdout);
    },
  });
}
const idle = (seen: TerminalLaunch[]) => (app: 'terminal' | 'iterm'): TerminalAdapter => ({ app, launch: async (l) => void seen.push(l) });

describe('man throw <name>', () => {
  processTest('a fresh throw skips saved history even on the same harness', async () => {
    const reg = stowedTrap(); stow(reg, true);
    claudeTranscript(reg.worktree, SESSION);
    expect(planThrow(loadConfig(), { names: ['amber-gull'] })[0]?.action).toBe('resume');
    const seen: TerminalLaunch[] = [];
    const result = await throwTrap({ address: 'amber-gull', cfg: loadConfig(), fresh: true,
      adapter: fakeTerminal(OTHER, seen), timeoutSecs: 30 });
    expect(result.action).toBe('cold');
    expect(seen[0]!.argv).not.toContain('--resume');
    expect(result.registration.sessionId).toBe(OTHER);
  });

  processTest('a Codex return supplies session folder trust for its soak-created checkout and reports it at launch', async () => {
    const reg = stowedTrap(); stow(reg, true);
    setRosterProfile(reg.trapId, { harness: 'codex' });
    const seen: TerminalLaunch[] = [];
    let launchNotice = '';
    await throwTrap({ address: 'amber-gull', cfg: loadConfig(), adapter: fakeTerminal(OTHER, seen), timeoutSecs: 30,
      onLaunch: (launch) => { launchNotice = launchedText(launch); } });
    const folderOverride = seen[0]!.argv.find((arg) => arg.startsWith('projects='));
    expect(folderOverride).toBeDefined();
    expect(parse(folderOverride!)).toEqual({ projects: { [fs.realpathSync.native(reg.worktree)]: { trust_level: 'trusted' } } });
    expect(launchNotice).toContain('launch-only trust');
  });

  processTest('a named harness override starts cold on Codex and persists for later throws', async () => {
    const reg = stowedTrap(); stow(reg, true);
    claudeTranscript(reg.worktree, SESSION);
    const seen: TerminalLaunch[] = [];
    const result = await throwTrap({ address: 'amber-gull', harness: 'codex', cfg: loadConfig(), adapter: fakeTerminal(OTHER, seen), pollMs: 50, timeoutSecs: 30 });
    expect(result.harness).toBe('codex');
    expect(seen[0]!.argv[0]).toBe('codex');
    expect(seen[0]!.argv).not.toContain('--resume');
    expect(readRoster(reg.trapId)?.profile?.harness).toBe('codex');
  });

  for (const action of ['cold', 'resume'] as const) {
    processTest(`uses repo+harness permission defaults for a ${action} throw and its displayed mode`, async () => {
      const reg = stowedTrap(); stow(reg, true);
      fs.appendFileSync(path.join(home, 'config.toml'), '\n[harness]\npermissionMode = "default"\n[harness.claude]\npermissionMode = "plan"\n[harness.codex]\npermissionMode = "bypass"\n[repos.r.harness]\npermissionMode = "auto"\n[repos.r.harness.claude]\npermissionMode = "acceptEdits"\n');
      if (action === 'resume') claudeTranscript(reg.worktree, SESSION);
      const [plan] = planThrow(loadConfig(), { names: ['amber-gull'] });
      expect(plan).toMatchObject({ action, harness: 'claude', config: { permissionMode: 'acceptEdits' } });
      const seen: TerminalLaunch[] = [];
      const result = await throwTrap({ address: 'amber-gull', cfg: loadConfig(), adapter: fakeTerminal(action === 'resume' ? SESSION : OTHER, seen), pollMs: 50, timeoutSecs: 30 });
      expect(result.mode).toBe('acceptEdits');
      expect(seen[0]!.argv).toContain('acceptEdits');
      expect(readRoster(reg.trapId)?.startMode).toBe('acceptEdits');
      expect(lobstah(primary, 'man', 'roster').stdout).toContain(',acceptEdits,');
      expect(lobstah(primary, 'man', 'tend').stdout).toContain('acceptEdits');
      stow(result.registration, true);
      setRosterProfile(reg.trapId, { config: { permissionMode: 'plan' } });
      const entry = readRoster(reg.trapId)!;
      const [profiled] = planThrow(loadConfig(), { names: [entry.name] });
      expect(profiled!.config?.permissionMode).toBe('plan');
      expect(nextStartMode(loadConfig(), entry)).toBe('plan');
      expect(startCommand(profiled!, entry, 'T', true).mode).toBe('bypassPermissions');
    });
  }

  processTest('uses the new trap harness and roster harness override before resolving mode; profile and bypass win', async () => {
    fs.appendFileSync(path.join(home, 'config.toml'), '\n[harness]\npermissionMode = "plan"\n[harness.codex]\npermissionMode = "bypass"\n[harness.claude]\npermissionMode = "auto"\n');
    const seen: TerminalLaunch[] = [];
    const result = await throwNew({ cfg: loadConfig(), repo: 'r', harness: 'codex', adapter: fakeTerminal(OTHER, seen), timeoutSecs: 30 });
    expect(result.mode).toBe('bypassPermissions');
    expect(seen[0]!.argv).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(result.registration.harness).toBe('codex');
    expect(lobstah(primary, 'man', 'tend').stdout).toContain('bypassPermissions');
    stow(result.registration, true);
    setRosterProfile(result.registration.trapId, { harness: 'claude' });
    let entry = readRoster(result.registration.trapId)!;
    expect(nextStartMode(loadConfig(), entry)).toBe('auto');
    expect(planThrow(loadConfig(), { names: [entry.name] })[0]).toMatchObject({ harness: 'claude', config: { permissionMode: 'auto' } });
    expect(trapRows().find((row) => row.trap === `wt:${entry.trapId}`)?.worker).toMatch(/ · auto$/);
    expect(lobstah(primary, 'man', 'roster').stdout).toContain(',auto,');
    setRosterProfile(entry.trapId, { config: { permissionMode: 'default' } });
    entry = readRoster(entry.trapId)!;
    const [plan] = planThrow(loadConfig(), { names: [entry.name] });
    expect(nextStartMode(loadConfig(), entry)).toBe('default');
    expect(plan!.config?.permissionMode).toBe('default');
    expect(startCommand(plan!, entry, 'T', true)).toMatchObject({ mode: 'bypassPermissions' });
  });

  processTest('trap-any brings back the same stowed trap instead of creating another checkout', async () => {
    const reg = stowedTrap();
    stow(reg);
    claudeTranscript(reg.worktree, SESSION);
    fs.appendFileSync(path.join(home, 'config.toml'), '\n[harness.claude]\npermissionMode = "default"\n[harness.codex]\npermissionMode = "bypass"\n');
    const seen: TerminalLaunch[] = [];
    const choice = await trapForRepo({ cfg: loadConfig(), repo: 'r', adapter: fakeTerminal(SESSION, seen), timeoutSecs: 30 });
    expect(choice).toMatchObject({ action: 'resumed', registration: { trapId: reg.trapId, worktree: reg.worktree } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.argv).toContain('default');
    expect(seen[0]!.argv).not.toContain('--dangerously-skip-permissions');
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

  processTest('a failed setup names the command and what it printed in the start-failed notice', async () => {
    const reg = stowedTrap();
    stow(reg, true);
    // The setup changed since the checkout last ran it, so the throw runs it again.
    const script = path.join(tmp, 'setup-fails.cjs');
    fs.writeFileSync(script, "console.log('ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY  Aborted removal of modules directory due to no TTY'); process.exit(1);\n");
    fs.appendFileSync(path.join(home, 'config.toml'), `setup = ['node "${script}"']\n`);
    const seen: TerminalLaunch[] = [];
    await expect(throwTrap({ address: 'amber-gull', cfg: loadConfig(), adapter: idle(seen), pollMs: 50, timeoutSecs: 1 })).rejects.toThrow(/setup command .* failed \(exit 1\)/);
    expect(seen).toHaveLength(0);
    const notice = listNotices().find((n) => n.kind === 'trap-start-failed' && n.refId === reg.trapId);
    expect(notice?.text).toContain('ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY');
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
    expect(seen[0]!.argv).toContain('check_for_update_on_startup=false');
    const held = readReservation(reg.trapId)!;
    expect(Date.parse(held.deadline) - Date.parse(held.reservedAt)).toBe(1000);
    await expect(throwTrap({ address: 'amber-gull', cfg, adapter: idle(seen) })).rejects.toThrow(TrapStartingError);
    expect(seen).toHaveLength(1);
    expireReservations(Date.parse(held.deadline) + 1);
    const ticket = /--ticket (\S+)/.exec(seen[0]!.argv.at(-1)!)![1]!;
    const on = lobstah(reg.worktree, 'soak', '--ticket', ticket, '--session', OTHER, '--harness', 'codex');
    expect(on.status, on.stderr || on.stdout).toBe(0);
    lobstah(reg.worktree, 'soak', '--session', OTHER, '--wait', '--timeout', '0');
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
    const codex = startCommand(row({ action: 'resume', resumeFrom: '/old-primary', harness: 'codex', model: 'gpt-5.5', config: { effort: 'high', permissionMode: 'default' } }), entry, 'T');
    expect(codex.cwd).toBe(entry.worktree);
    expect(codex.argv).toEqual(['codex', '--cd', entry.worktree, '-c', 'tui.terminal_title=[]', '-m', 'gpt-5.5', '-c', 'model_reasoning_effort="high"', 'resume', 'sess-1', '$lobstah:trap soak --ticket T']);
    expect(codex).toMatchObject({ unapplied: [], mode: 'default' });
    expect(startCommand(row({ harness: 'claude' }), entry, 'T')).toMatchObject({ cwd: '/w/soak-abcd1234', argv: ['claude', '--permission-mode', 'auto', '/lobstah:trap soak --ticket T'] });
  });

  it('adds the interactive Remote Control option under the trap name, before the prompt, and never Claude\'s option on Codex', () => {
    const base = { cwd: '/w', ticket: 'T' };
    expect(harnessCommand({ ...base, harness: 'claude', remoteControl: 'amber-gull' }).argv).toEqual(['claude', '--permission-mode', 'auto', '--remote-control', 'amber-gull', '/lobstah:trap soak --ticket T']);
    expect(harnessCommand({ ...base, harness: 'claude' }).argv).not.toContain('--remote-control');
    expect(harnessCommand({ ...base, harness: 'codex', remoteControl: 'amber-gull' }).argv).not.toContain('--remote-control');
  });

  processTest('--remote-control connects one new trap, and the glass finds the URL Claude wrote for it', async () => {
    const claudeHome = path.join(home, 'claude-home');
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome);
    try {
      const seen: TerminalLaunch[] = [];
      const result = await throwNew({ cfg: loadConfig(), repo: 'r', remoteControl: true, reason: 'phone pilot', adapter: fakeTerminal(OTHER, seen), timeoutSecs: 30 });
      const reg = result.registration;
      expect(seen[0]!.argv.slice(-3, -1)).toEqual(['--remote-control', reg.name]);
      expect(reg.remoteControlSince).toBeTruthy();
      const live = () => buildGlassSnapshot().traps.find((t) => t.trapId === reg.trapId)!;
      // Connected to nothing yet: no link, and the local session id isn't turned into one.
      expect(live().liveLink).toBeUndefined();
      const dir = path.join(claudeHome, 'projects', 'anywhere');
      fs.mkdirSync(dir, { recursive: true });
      const line = (url: string, ms: number) => JSON.stringify({ type: 'system', subtype: 'bridge_status', content: `/remote-control is active · Continue here, on your phone, or at ${url}`, url, isMeta: false, timestamp: new Date(ms).toISOString(), uuid: 'u' }) + '\n';
      const since = Date.parse(reg.remoteControlSince!);
      fs.writeFileSync(path.join(dir, `${OTHER}.jsonl`), line('https://claude.ai/code/session_old', since - 60_000));
      expect(live().liveLink).toBeUndefined();
      fs.appendFileSync(path.join(dir, `${OTHER}.jsonl`), line('https://claude.ai/code/session_live', since + 1000));
      expect(live().liveLink).toBe('https://claude.ai/code/session_live');
      stow(reg, true);
      expect(buildGlassSnapshot().traps.find((t) => t.trapId === reg.trapId)?.liveLink).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  processTest('lobstah adds no --remote-control by itself: a throw asks for it, new or returning', async () => {
    const seen: TerminalLaunch[] = [];
    const first = await throwNew({ cfg: loadConfig(), repo: 'r', reason: 'default', adapter: fakeTerminal(OTHER, seen), timeoutSecs: 30 });
    expect(seen[0]!.argv).not.toContain('--remote-control');
    expect(first.registration.remoteControlSince).toBeUndefined();
    stow(first.registration, true);
    const back = await throwTrap({ cfg: loadConfig(), address: first.registration.name!, adapter: fakeTerminal(OTHER, seen), timeoutSecs: 30 });
    expect(seen[1]!.argv).not.toContain('--remote-control');
    stow(back.registration, true);
    const again = await throwTrap({ cfg: loadConfig(), address: first.registration.name!, remoteControl: true, adapter: fakeTerminal(OTHER, seen), timeoutSecs: 30 });
    expect(seen[2]!.argv.slice(-3, -1)).toEqual(['--remote-control', first.registration.name]);
    expect(again.registration.remoteControlSince).toBeTruthy();
  });

  describe('one session, one writer (the 2026-11-03 incident)', () => {
    const ghost = (reg: TrapRegistration) => {
      recordRosterDeparture(reg, 'ghosted', 'ghosted: went quiet mid-watch');
      fs.rmSync(path.join(home, 'soaking', `${reg.trapId}.json`));
    };
    const thrown = async () => (await throwNew({ cfg: loadConfig(), repo: 'r', reason: 'incident', adapter: fakeTerminal(OTHER, []), timeoutSecs: 30 })).registration;
    const trapFile = (trapId: string) => path.join(home, 'soaking', `${trapId}.json`);
    const claudeFile = (sessionId: string, pid: number, pane: string, bridge: Record<string, unknown> = {}) => {
      fs.mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(claudeHome, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, tmux: `lobstah:@1.${pane}`, ...bridge }));
    };
    const running = async () => {
      const child = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000); console.log('up');"], { stdio: ['ignore', 'pipe', 'ignore'] });
      await new Promise((resolve) => child.stdout!.once('data', resolve));
      return child;
    };
    const ended = async (child: ChildProcess) => {
      child.kill('SIGKILL');
      if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once('exit', resolve));
    };

    processTest('a ghosted thrown trap comes back under its own name when its session re-soaks, with no new worktree', async () => {
      const reg = await thrown();
      ghost(reg);
      const worktrees = fs.readdirSync(path.join(home, 'worktrees'));
      const res = lobstah(primary, 'soak', '--session', OTHER, '--harness', 'claude');
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain(`name: ${reg.name}`);
      expect(listTraps().map((t) => t.trapId)).toEqual([reg.trapId]);
      expect(fs.readdirSync(path.join(home, 'worktrees'))).toEqual(worktrees);
    });

    processTest('a session re-soaking in another linked worktree is sent back to its own trap, and takes no name', async () => {
      const reg = await thrown();
      ghost(reg);
      const elsewhere = path.join(path.dirname(primary), 'elsewhere');
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'elsewhere', elsewhere], { cwd: primary });
      const res = lobstah(elsewhere, 'soak', '--session', OTHER, '--harness', 'claude');
      expect(res.status).not.toBe(0);
      expect(res.stderr + res.stdout).toContain(`belongs to trap ${trapLabel(reg)}`);
      expect(listTraps()).toEqual([]);
    });

    processTest('a live session can not sign on as a second trap from another linked worktree', async () => {
      const reg = await thrown();
      const elsewhere = path.join(path.dirname(primary), 'elsewhere2');
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'elsewhere2', elsewhere], { cwd: primary });
      const res = lobstah(elsewhere, 'soak', '--session', OTHER, '--harness', 'claude');
      expect(res.status).not.toBe(0);
      expect(res.stderr + res.stdout).toContain('already mans trap');
      expect(listTraps().map((t) => t.trapId)).toEqual([reg.trapId]);
    });

    processTest('a stow releases the session: it may volunteer elsewhere, or start again once its checkout is removed', async () => {
      const reg = await thrown();
      stow(reg, true);
      const elsewhere = path.join(path.dirname(primary), 'elsewhere3');
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'elsewhere3', elsewhere], { cwd: primary });
      const moved = lobstah(elsewhere, 'soak', '--session', OTHER, '--harness', 'claude');
      expect(moved.status, moved.stderr).toBe(0);
      const here = listTraps()[0]!;
      expect(here.trapId).not.toBe(reg.trapId);
      stow(here, true);
      fs.rmSync(reg.worktree, { recursive: true, force: true });
      execFileSync('git', ['worktree', 'prune'], { cwd: primary });
      fs.rmSync(elsewhere, { recursive: true, force: true });
      execFileSync('git', ['worktree', 'prune'], { cwd: primary });
      const again = lobstah(primary, 'soak', '--session', OTHER, '--harness', 'claude');
      expect(again.status, again.stderr).toBe(0);
      expect(listTraps()).toHaveLength(1);
    });

    processTest('a ghost whose checkout is gone is refused, not replaced with a new trap', async () => {
      const reg = await thrown();
      ghost(reg);
      fs.rmSync(reg.worktree, { recursive: true, force: true });
      const res = lobstah(primary, 'soak', '--session', OTHER, '--harness', 'claude');
      expect(res.status).not.toBe(0);
      expect(res.stderr + res.stdout).toContain(`lobstah man throw ${reg.name}`);
      expect(listTraps()).toEqual([]);
    });

    processTest('throw refuses a session live in another pane and names it, with or without --remote-control; nothing launches', async () => {
      const reg = await thrown();
      stow(reg, true);
      const project = path.join(claudeHome, 'projects', reg.worktree.replace(/[^A-Za-z0-9-]/g, '-'));
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(path.join(project, `${OTHER}.jsonl`), '{}\n');
      const child = await running();
      try {
        claudeFile(OTHER, child.pid!, '%14');
        const seen: TerminalLaunch[] = [];
        for (const remoteControl of [false, true]) {
          await expect(throwTrap({ cfg: loadConfig(), address: reg.name!, adapter: idle(seen), remoteControl, timeoutSecs: 1 })).rejects.toThrow(new RegExp(`process ${child.pid} \\(tmux pane %14\\).*kill ${child.pid}`));
        }
        expect(seen).toHaveLength(0);
        expect(readReservation(reg.trapId)).toBeUndefined();
      } finally {
        await ended(child);
      }
    });

    processTest('throw starts cold, with no resume, on a session another trap is registered on', async () => {
      const reg = await thrown();
      stow(reg, true);
      const project = path.join(claudeHome, 'projects', reg.worktree.replace(/[^A-Za-z0-9-]/g, '-'));
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(path.join(project, `${OTHER}.jsonl`), '{}\n');
      fs.writeFileSync(trapFile('93a6a892'), JSON.stringify({ trapId: '93a6a892', name: 'smooth-gull', worktree: path.join(home, 'x'), cwd: home, harness: 'claude', sessionId: OTHER, signedOnAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
      const seen: TerminalLaunch[] = [];
      const fresh = '33333333-4444-4555-8666-777777777777';
      const result = await throwTrap({ cfg: loadConfig(), address: reg.name!, adapter: fakeTerminal(fresh, seen), timeoutSecs: 20 });
      expect(result.action).toBe('cold');
      expect(result.why).toContain(`session ${OTHER.slice(0, 8)} belongs to live trap smooth-gull`);
      expect(seen).toHaveLength(1);
      expect(JSON.stringify(seen[0])).not.toContain('--resume');
      expect(JSON.stringify(seen[0])).not.toContain(OTHER);
      expect(result.registration.sessionId).toBe(fresh);
    });

    processTest('stow names a trap: with two on one session it refuses to guess, and --wt stows only that one', async () => {
      const reg = await thrown();
      fs.writeFileSync(trapFile('93a6a892'), JSON.stringify({ trapId: '93a6a892', name: 'smooth-gull', worktree: path.join(home, 'x'), cwd: home, harness: 'claude', sessionId: OTHER, signedOnAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
      const guess = lobstah(primary, 'stow', '--session', OTHER);
      expect(guess.status).not.toBe(0);
      expect(guess.stderr + guess.stdout).toContain('several traps share session');
      expect(listTraps()).toHaveLength(2);
      const quiet = lobstah(primary, 'stow', '--quiet', '--session', OTHER);
      expect(quiet.status, quiet.stderr).toBe(0);
      expect(listTraps()).toHaveLength(2);
      const named = lobstah(primary, 'stow', '--wt', '93a6a892');
      expect(named.status, named.stderr).toBe(0);
      expect(listTraps().map((t) => t.trapId)).toEqual([reg.trapId]);
    });

    processTest('the glass finds each trap\'s live link from its own process, with no flag at sign-on', async () => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome);
      const [a, b] = [await running(), await running()];
      try {
        const reg = await thrown();
        expect(reg.remoteControlSince).toBeUndefined();
        const live = () => buildGlassSnapshot().traps.find((t) => t.trapId === reg.trapId)!;
        const LINK = 'https://claude.ai/code/session_live';
        // This Claude keeps no records, and the trap wasn't started connected.
        expect(live().liveLink).toBeUndefined();
        // Its process runs and isn't connected: a URL in the transcript can't stand in for that.
        claudeFile(OTHER, a.pid!, '%14');
        const dir = path.join(claudeHome, 'projects', 'anywhere');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${OTHER}.jsonl`), JSON.stringify({ type: 'system', subtype: 'bridge_status', url: 'https://claude.ai/code/session_old', timestamp: new Date().toISOString() }) + '\n');
        expect(live().liveLink).toBeUndefined();
        // Connected, then disconnected: Claude sets and clears the id.
        claudeFile(OTHER, a.pid!, '%14', { bridgeSessionId: 'session_live' });
        expect(live().liveLink).toBe(LINK);
        claudeFile(OTHER, a.pid!, '%14', { bridgeSessionId: null });
        expect(live().liveLink).toBeUndefined();
        claudeFile(OTHER, a.pid!, '%14', { bridgeSessionId: 'session_live' });
        // A second writer takes the link away until one ends.
        claudeFile(OTHER, b.pid!, '%20', { bridgeSessionId: 'session_live' });
        expect(live().liveLink).toBeUndefined();
        expect(live().sessionWriters?.sort()).toEqual([a.pid!, b.pid!].sort());
        await ended(b);
        expect(live().liveLink).toBe(LINK);
        expect(live().sessionWriters).toBeUndefined();
        // Its process gone: nothing can open.
        await ended(a);
        expect(live().liveLink).toBeUndefined();
      } finally {
        await ended(a);
        await ended(b);
        vi.unstubAllEnvs();
      }
    });
  });

  describe('a Codex trap on the shared app-server', () => {
    const base = { cwd: '/w', ticket: 'T', harness: 'codex' };

    it('attaches with --remote before any subcommand, so resume reaches the same server', () => {
      expect(harnessCommand({ ...base, remoteControl: 'amber-gull' }).argv.slice(0, 3)).toEqual(['codex', '--remote', 'unix://']);
      const resumed = harnessCommand({ ...base, remoteControl: 'amber-gull', resume: 'thread-1' }).argv;
      expect(resumed.indexOf('--remote')).toBeLessThan(resumed.indexOf('resume'));
    });

    it('stays off unless asked for: the flag, or the setting', () => {
      expect(harnessCommand(base).argv).not.toContain('--remote');
      const cfg = (codexRemoteControl: boolean) => ({ cfg: { soak: { codexRemoteControl } } as ReturnType<typeof loadConfig> });
      expect(onCodexServer(cfg(false), 'codex')).toBe(false);
      expect(onCodexServer({ ...cfg(false), remoteControl: true }, 'codex')).toBe(true);
      expect(onCodexServer(cfg(true), 'codex')).toBe(true);
      expect(onCodexServer({ ...cfg(true), remoteControl: true }, 'claude')).toBe(false);
    });

    it('runs the preface in the pane, and starts the session whether or not it succeeds', () => {
      expect(launchShellText({ cwd: '/w', env: {}, argv: ['codex'], preface: 'lobstah soak remember-window --ticket T' })).toBe("cd /w && { lobstah soak remember-window --ticket T; } ; codex");
      expect(launchShellText({ cwd: '/w', env: {}, argv: ['codex'] })).toBe('cd /w && codex');
    });

    it('readies the server before the pane opens, reserves the trap for it, and hides the ticket', async () => {
      const order: string[] = [];
      const seen: TerminalLaunch[] = [];
      let shown = '';
      const adapter = (app: 'terminal' | 'iterm'): TerminalAdapter => ({ app, launch: async (launch) => { order.push('launch'); seen.push(launch); throw new Error('stop here'); } });
      await expect(throwNew({
        cfg: loadConfig(), repo: 'r', harness: 'codex', remoteControl: true, reason: 'test', adapter,
        prepareCodexServer: async () => { order.push('prepare'); },
        onLaunch: (launched) => { shown = launched.command; },
      })).rejects.toThrow('stop here');
      expect(order).toEqual(['prepare', 'launch']);
      expect(seen[0]!.argv.slice(0, 1)).toEqual(['codex']);
      expect(seen[0]!.argv).toContain('--remote');
      expect(seen[0]!.preface).toMatch(/^lobstah soak remember-window --ticket [0-9a-f]{8}-[0-9a-f]{32}$/);
      expect(shown).toBe('');
    });

    it('never prepares a server, or adds a preface, for a Codex trap that did not ask', async () => {
      const seen: TerminalLaunch[] = [];
      let prepared = false;
      const adapter = (app: 'terminal' | 'iterm'): TerminalAdapter => ({ app, launch: async (launch) => { seen.push(launch); throw new Error('stop here'); } });
      await expect(throwNew({ cfg: loadConfig(), repo: 'r', harness: 'codex', reason: 'test', adapter, prepareCodexServer: async () => { prepared = true; } })).rejects.toThrow('stop here');
      expect(prepared).toBe(false);
      expect(seen[0]!.argv).not.toContain('--remote');
      expect(seen[0]!.preface).toBeUndefined();
    });

    it('leaves the trap unstarted when the server can not be readied', async () => {
      const seen: TerminalLaunch[] = [];
      await expect(throwNew({
        cfg: loadConfig(), repo: 'r', harness: 'codex', remoteControl: true, reason: 'test', adapter: idle(seen),
        prepareCodexServer: async () => { throw new Error('could not start Codex shared server'); },
      })).rejects.toThrow('could not start Codex shared server');
      expect(seen).toHaveLength(0);
    });
  });

  it('starts every trap in auto mode by default; a roster permissionMode overrides; bypass wins', () => {
    const base = { cwd: '/w', ticket: 'T' };
    expect(harnessCommand({ ...base, harness: 'claude' })).toMatchObject({ argv: ['claude', '--permission-mode', 'auto', '/lobstah:trap soak --ticket T'], mode: 'auto' });
    // Codex auto: no OS sandbox; approvals on request, to Codex's automatic reviewer.
    const codexAuto: StartCommand = harnessCommand({ ...base, harness: 'codex' });
    expect(codexAuto).toMatchObject({
      argv: ['codex', '--cd', '/w', '-c', 'tui.terminal_title=[]', '--sandbox', 'danger-full-access', '--ask-for-approval', 'on-request', '-c', 'approvals_reviewer="auto_review"', '$lobstah:trap soak --ticket T'],
      mode: 'auto',
      unapplied: [],
    });
    // The roster profile's mode, as today.
    expect(harnessCommand({ ...base, harness: 'claude', config: { permissionMode: 'plan' } }).argv).toEqual(['claude', '--permission-mode', 'plan', '/lobstah:trap soak --ticket T']);
    expect(harnessCommand({ ...base, harness: 'codex', config: { permissionMode: 'acceptEdits' } })).toMatchObject({
      argv: ['codex', '--cd', '/w', '-c', 'tui.terminal_title=[]', '$lobstah:trap soak --ticket T'],
      unapplied: ['permissionMode=acceptEdits'],
    });
    // `man throw --bypass`, over any profile.
    expect(harnessCommand({ ...base, harness: 'claude', config: { permissionMode: 'plan' }, bypass: true })).toMatchObject({
      argv: ['claude', '--dangerously-skip-permissions', '/lobstah:trap soak --ticket T'],
      mode: 'bypassPermissions',
    });
    // `bypass` is a mode a profile or the config can name.
    expect(harnessCommand({ ...base, harness: 'claude', config: { permissionMode: 'bypass' } }).argv).toEqual(['claude', '--dangerously-skip-permissions', '/lobstah:trap soak --ticket T']);
    expect(harnessCommand({ ...base, harness: 'codex', config: { permissionMode: 'bypassPermissions' } }).argv).toEqual(['codex', '--cd', '/w', '-c', 'tui.terminal_title=[]', '--dangerously-bypass-approvals-and-sandbox', '$lobstah:trap soak --ticket T']);
    expect(harnessCommand({ ...base, harness: 'codex', bypass: true }).argv).toEqual(['codex', '--cd', '/w', '-c', 'tui.terminal_title=[]', '--dangerously-bypass-approvals-and-sandbox', '$lobstah:trap soak --ticket T']);
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
    expect(nextStartMode(cfg(), { repo: 'r', harness: 'claude' })).toBe('auto');
    expect(nextStartMode(cfg('bypass'), { repo: 'r', harness: 'claude' })).toBe('bypassPermissions');
    expect(nextStartMode(cfg('bypass', 'auto'), { repo: 'r', harness: 'claude' })).toBe('auto');
    expect(nextStartMode(cfg('bypass', 'auto'), { repo: 'other', harness: 'claude' })).toBe('bypassPermissions');
    expect(nextStartMode(cfg('bypass'), { repo: 'r', harness: 'claude', profile: { config: { permissionMode: 'plan' } } })).toBe('plan');
    expect(freshProfile(cfg('bypass'), 'r')).toMatchObject({ config: { permissionMode: 'bypassPermissions' } });
    expect(freshProfile(cfg(), 'r').config).toBeUndefined();
  });


  it('quotes every word of the shell text a terminal runs', () => {
    expect(launchShellText({ cwd: "/tmp/it's here", env: { A: 'x y' }, argv: ['claude', '$lobstah:trap soak --ticket T'] })).toBe(
      `cd '/tmp/it'\\''s here' && A='x y' claude '$lobstah:trap soak --ticket T'`,
    );
  });
});

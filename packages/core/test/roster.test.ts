import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ensureLayout,
  heartbeatTrap,
  listRoster,
  loadConfig,
  planThrow,
  readRoster,
  recordRosterSignOn,
  rosterByAddress,
  setRosterProfile,
  signOnTrap,
  stowTrap,
  sweepGhostTraps,
  writeTrapAnchor,
} from '../src/index.js';
import type { TrapRegistration } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let repoDir: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-roster-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  repoDir = path.join(home, 'repo');
  fs.mkdirSync(repoDir);
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = '${repoDir}'\ntrunk = 'main'\n`);
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const TTL_MS = 1800_000;
const SESSION = '11111111-2222-4333-8444-555555555555';

function signOn(name: string, extra: Partial<Parameters<typeof signOnTrap>[0]> = {}): TrapRegistration {
  const worktree = path.join(home, 'worktrees', name);
  fs.mkdirSync(worktree, { recursive: true });
  const res = signOnTrap({ worktree, cwd: worktree, repo: 'r', harness: 'claude', sessionId: SESSION, name, ttlMs: TTL_MS, ...extra });
  if (!('ok' in res)) throw new Error('held');
  return res.ok;
}

describe('roster records', () => {
  it('persists the model and config a registration carries, by the same names', () => {
    const reg = signOn('amber-gull');
    // The registration's shape: model string|null, config { effort, permissionMode } with nulls.
    recordRosterSignOn({ ...reg, model: null, config: { effort: null, permissionMode: null } } as TrapRegistration);
    expect(readRoster(reg.trapId)!.model).toBeUndefined();
    expect(readRoster(reg.trapId)!.config).toBeUndefined();
    const observed = { ...reg, model: 'claude-opus-5-5', config: { effort: null, permissionMode: 'acceptEdits' } } as TrapRegistration;
    fs.writeFileSync(path.join(home, 'soaking', `${reg.trapId}.json`), JSON.stringify(observed));
    stowTrap(reg.trapId); // observed after sign-on: the departure records it
    expect(readRoster(reg.trapId)).toMatchObject({ model: 'claude-opus-5-5', config: { permissionMode: 'acceptEdits' } });
  });

  it('a return keeps the saved profile and first sign-on, and lifts the departure', () => {
    const reg = signOn('amber-gull');
    setRosterProfile(reg.trapId, { model: 'opus', terminal: 'iterm', config: { effort: 'high' } });
    stowTrap(reg.trapId);
    expect(readRoster(reg.trapId)).toMatchObject({ state: 'stowed', leftReason: 'signed off' });
    signOn('amber-gull', { sessionId: '22222222-2222-4333-8444-555555555555', name: undefined });
    const back = readRoster(reg.trapId)!;
    expect(back).toMatchObject({ state: 'live', name: 'amber-gull', firstSignedOnAt: reg.signedOnAt, profile: { model: 'opus', terminal: 'iterm', config: { effort: 'high' } } });
    expect(back.leftAt).toBeUndefined();
    setRosterProfile(reg.trapId, { model: null, terminal: null, config: { effort: null } });
    expect(readRoster(reg.trapId)!.profile).toBeUndefined();
  });

  it('a ghost sweep records the departure even outside git', () => {
    const reg = signOn('amber-gull');
    heartbeatTrap(reg.trapId, { parked: true });
    sweepGhostTraps(1_000, Date.now() + 60_000);
    expect(readRoster(reg.trapId)).toMatchObject({ state: 'ghosted', leftReason: 'ghosted: went quiet mid-watch' });
    expect(rosterByAddress('amber-gull')?.trapId).toBe(reg.trapId);
    expect(rosterByAddress(`wt:${reg.trapId}`)?.name).toBe('amber-gull');
  });
});

describe('planThrow', () => {
  it('an app session starts cold, and says which app', () => {
    const reg = signOn('amber-gull', { link: 'vscode://anthropic.claude-code/open?session=abc' });
    stowTrap(reg.trapId);
    // Not a git checkout: no protected ref, but the checkout is kept.
    const [row] = planThrow(loadConfig(), { names: ['amber-gull'] }, { claudeHome: path.join(home, 'claude') });
    expect(row).toMatchObject({ action: 'cold', checkout: 'kept' });
    expect(row!.why).toContain('ran in the VS Code extension');
  });

  it('a Codex CLI rollout resumes; a desktop rollout starts cold', () => {
    const thread = '01999999-8888-7777-8666-555555555555';
    const codexHome = path.join(home, 'codex');
    const day = path.join(codexHome, 'sessions', '2026', '10', '07');
    fs.mkdirSync(day, { recursive: true });
    const rollout = path.join(day, `rollout-2026-10-07T00-00-00-${thread}.jsonl`);
    fs.writeFileSync(rollout, '{"type":"session_meta","payload":{"originator":"codex_cli_rs"}}\n');
    const reg = signOn('blue-heron', { harness: 'codex', sessionId: thread });
    stowTrap(reg.trapId);
    expect(planThrow(loadConfig(), { all: true }, { codexHome })[0]).toMatchObject({ action: 'resume' });
    fs.writeFileSync(rollout, '{"type":"session_meta","payload":{"originator":"Codex Desktop"}}\n');
    const [row] = planThrow(loadConfig(), { all: true }, { codexHome });
    expect(row).toMatchObject({ action: 'cold' });
    expect(row!.why).toContain('Codex Desktop');
  });

  it('an unconfigured repo, a foreign anchor, and a pre-roster worktree are unresolved', () => {
    const reg = signOn('amber-gull');
    stowTrap(reg.trapId);
    writeTrapAnchor(reg.worktree, { trapId: 'feedface' });
    expect(planThrow(loadConfig(), { names: ['amber-gull'] })[0]).toMatchObject({ action: 'unresolved', why: `${reg.worktree} now anchors wt:feedface` });
    fs.writeFileSync(path.join(home, 'config.toml'), `[repos.other]\npath = '${repoDir}'\ntrunk = 'main'\n`);
    expect(planThrow(loadConfig(), { names: ['amber-gull'] })[0]).toMatchObject({ action: 'unresolved', why: 'repo r is no longer configured' });

    fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = '${repoDir}'\ntrunk = 'main'\n`);
    const old = path.join(home, 'worktrees', 'soak-0ld0ld00');
    fs.mkdirSync(old);
    writeTrapAnchor(old, { trapId: '0ld0ld00', name: 'misty-cove', createdBy: 'soak', repo: 'r', sessionId: SESSION });
    const rows = planThrow(loadConfig(), { all: true });
    expect(rows.find((r) => r.name === 'misty-cove')).toMatchObject({ action: 'unresolved' });
    expect(rows.find((r) => r.name === 'misty-cove')!.why).toContain('no roster record');
    expect(listRoster().map((e) => e.name)).toEqual(['amber-gull']); // the plan wrote nothing
  });

  it('--all stays inside the grounds; --repo narrows', () => {
    const reg = signOn('amber-gull');
    stowTrap(reg.trapId);
    expect(planThrow(loadConfig(), { all: true }, { repos: ['elsewhere'] })).toEqual([]);
    expect(planThrow(loadConfig(), { repo: 'r' }, { repos: ['r'] }).map((r) => r.name)).toEqual(['amber-gull']);
  });

  it('the terminal comes from the profile, then [soak].terminal, then the last sign-on, then Terminal.app', () => {
    const reg = signOn('amber-gull', { window: { termProgram: 'iTerm.app' } });
    stowTrap(reg.trapId);
    const terminal = () => planThrow(loadConfig(), { names: ['amber-gull'] })[0]!;
    expect(terminal()).toMatchObject({ terminal: 'iterm', terminalFrom: 'last sign-on' });
    fs.appendFileSync(path.join(home, 'config.toml'), `[soak]\nterminal = 'terminal'\n`);
    expect(terminal()).toMatchObject({ terminal: 'terminal', terminalFrom: 'config' });
    setRosterProfile(reg.trapId, { terminal: 'iterm' });
    expect(terminal()).toMatchObject({ terminal: 'iterm', terminalFrom: 'profile' });
  });
});

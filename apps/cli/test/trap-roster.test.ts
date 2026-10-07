import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setImmediate as yieldToWorker } from 'node:timers/promises';
import {
  ensureLayout,
  heartbeatTrap,
  listRoster,
  listSignedOff,
  listTraps,
  readRoster,
  readTrap,
  releaseSignedOff,
  sweepGhostTraps,
  type TrapRegistration,
} from '@lobstah/core';
import { applyCull, planPressureCull } from '../src/cull.js';
import { removeTempDir } from '../../../test/temp-dir.js';

// End to end: the roster and the protected ref through the built CLI,
// against throwaway repos with a bare origin.
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const SESSION = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';

const processTest = (name: string, run: () => void) => it(name, run, 90_000);

let tmp: string;
let home: string;
let claudeHome: string;
let codexHome: string;
let origin: string;
let primary: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-roster-')));
  home = path.join(tmp, 'home');
  claudeHome = path.join(tmp, 'claude');
  codexHome = path.join(tmp, 'codex');
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  origin = path.join(tmp, 'origin.git');
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
});

function lobstah(cwd: string, ...args: string[]) {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX') && k !== 'TERM_PROGRAM' && k !== '__CFBundleIdentifier'),
  );
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...base, LOBSTAH_HOME: home, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome },
    input: '',
    timeout: 60_000,
  });
}

const soak = (cwd: string, session = SESSION, ...args: string[]) => lobstah(cwd, 'soak', '--session', session, '--harness', 'claude', ...args);
const only = (): TrapRegistration => {
  const traps = listTraps();
  expect(traps).toHaveLength(1);
  return traps[0]!;
};
/** Paths as registrations store them: native realpath, lowercased on Windows. */
const canon = (p: string) => (process.platform === 'win32' ? fs.realpathSync.native(p).toLowerCase() : fs.realpathSync.native(p));
const refOf = (trapId: string) => spawnSync('git', ['-C', primary, 'rev-parse', '--verify', '-q', `refs/lobstah/traps/${trapId}`], { encoding: 'utf8' });
const hasBranch = (b: string) => spawnSync('git', ['-C', primary, 'rev-parse', '--verify', '-q', `refs/heads/${b}`]).status === 0;

/** Commit on the trap's branch and push it, so stow may remove the checkout and delete the branch. */
function pushedCommit(reg: TrapRegistration): string {
  fs.writeFileSync(path.join(reg.worktree, 'work.txt'), 'done\n');
  git(reg.worktree, 'add', 'work.txt');
  git(reg.worktree, 'commit', '-q', '-m', 'work');
  git(reg.worktree, 'push', '-q', '-u', 'origin', 'HEAD');
  return git(reg.worktree, 'rev-parse', 'HEAD');
}

/** A saved Claude transcript for a session that started in `cwd`. */
function claudeTranscript(cwd: string, session: string): void {
  const dir = path.join(claudeHome, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session}.jsonl`), '{}\n');
}

/** `man throw --plan` as JSON rows. */
function plan(...args: string[]) {
  const res = lobstah(primary, 'man', 'throw', '--plan', '--json', ...args);
  expect(res.status, res.stderr || res.stdout).toBe(0);
  return (JSON.parse(res.stdout) as { traps: Array<Record<string, unknown>> }).traps;
}

describe('the roster outlives the registration', () => {
  processTest('sign-on records the trap; stow and the end of the grace leave the record', () => {
    expect(soak(primary, SESSION, '--name', 'amber-gull').status).toBe(0);
    const reg = only();
    expect(readRoster(reg.trapId)).toMatchObject({
      trapId: reg.trapId,
      name: 'amber-gull',
      repo: 'r',
      worktree: reg.worktree,
      harness: 'claude',
      sessionId: SESSION,
      createdWorktree: true,
      soakBranch: `lobstah/soak-${reg.trapId}`,
      branch: `lobstah/soak-${reg.trapId}`,
      ref: `refs/lobstah/traps/${reg.trapId}`,
      state: 'live',
    });
    expect(readRoster(reg.trapId)!.gitDir).toBe(canon(path.join(primary, '.git')));

    const stow = lobstah(reg.worktree, 'stow', '--session', SESSION, '--keep');
    expect(stow.status, stow.stderr).toBe(0);
    expect(readTrap(reg.trapId)).toBeUndefined();
    expect(listSignedOff().map((s) => s.trapId)).toEqual([reg.trapId]);
    releaseSignedOff(reg.trapId); // the grace ends
    expect(listSignedOff()).toEqual([]);
    expect(readRoster(reg.trapId)).toMatchObject({ name: 'amber-gull', state: 'stowed', leftReason: 'signed off', harness: 'claude', sessionId: SESSION });
  });

  processTest('the protected ref keeps the revision after stow removes the checkout and deletes its branch', () => {
    expect(soak(primary).status).toBe(0);
    const reg = only();
    const head = pushedCommit(reg);
    const branch = `lobstah/soak-${reg.trapId}`;
    const stow = lobstah(reg.worktree, 'stow', '--session', SESSION);
    expect(stow.status, stow.stderr).toBe(0);
    expect(stow.stdout).toMatch(/^worktree: removed$/m);
    expect(stow.stdout).toContain(`branchDeleted: ${branch}`);
    expect(fs.existsSync(reg.worktree)).toBe(false);
    expect(hasBranch(branch)).toBe(false);
    expect(refOf(reg.trapId).stdout.trim()).toBe(head);
    expect(readRoster(reg.trapId)).toMatchObject({ head, branch, state: 'stowed' });
  });

  processTest('a ghost sweep records the trap as ghosted and keeps its revision', () => {
    expect(soak(primary).status).toBe(0);
    const reg = only();
    const head = pushedCommit(reg);
    heartbeatTrap(reg.trapId, { parked: true });
    const actions = sweepGhostTraps(1_000, Date.now() + 60_000);
    expect(actions.map((a) => a.trapId)).toEqual([reg.trapId]);
    expect(readTrap(reg.trapId)).toBeUndefined();
    expect(readRoster(reg.trapId)).toMatchObject({ state: 'ghosted', head });
    expect(refOf(reg.trapId).stdout.trim()).toBe(head);
  });

  processTest('cull removes a stowed checkout; the roster record and the protected ref stay', () => {
    expect(soak(primary).status).toBe(0);
    const reg = only();
    const head = pushedCommit(reg);
    expect(lobstah(reg.worktree, 'stow', '--session', SESSION, '--keep').status).toBe(0);
    // Point the ref back at trunk: the cull itself must move it to the checkout's HEAD.
    git(primary, 'update-ref', `refs/lobstah/traps/${reg.trapId}`, git(primary, 'rev-parse', 'main'));
    const items = planPressureCull();
    expect(items.map((i) => canon(i.target))).toContain(canon(reg.worktree));
    applyCull(items);
    expect(fs.existsSync(reg.worktree)).toBe(false);
    expect(readRoster(reg.trapId)).toMatchObject({ state: 'stowed', head });
    expect(refOf(reg.trapId).stdout.trim()).toBe(head);
    expect(listRoster().map((e) => e.trapId)).toEqual([reg.trapId]);
  });
});

describe('a returning trap keeps its name', () => {
  processTest('sign-off and return, by another session, keep the name and the address', () => {
    expect(soak(primary, SESSION, '--name', 'amber-gull').status).toBe(0);
    const reg = only();
    expect(lobstah(reg.worktree, 'stow', '--session', SESSION, '--keep').status).toBe(0);
    // The name registry entry is lost: the roster still knows the name.
    fs.rmSync(path.join(home, 'trap-names', 'amber-gull.json'));
    const back = soak(reg.worktree, OTHER);
    expect(back.status, back.stderr).toBe(0);
    expect(only()).toMatchObject({ trapId: reg.trapId, name: 'amber-gull', sessionId: OTHER });
    expect(readRoster(reg.trapId)).toMatchObject({ name: 'amber-gull', state: 'live', sessionId: OTHER });
    expect(readRoster(reg.trapId)!.leftAt).toBeUndefined();
    expect(lobstah(primary, 'status', 'amber-gull').status).toBe(0);
  });
});

describe('man throw --plan', () => {
  processTest('resume, cold start, missing worktree, and live, each with its reason; nothing launches', () => {
    // live
    expect(soak(primary, SESSION, '--name', 'amber-gull').status).toBe(0);
    const live = only();
    // resume: kept checkout and a saved transcript
    expect(lobstah(live.worktree, 'stow', '--session', SESSION, '--keep').status).toBe(0);
    claudeTranscript(live.worktree, SESSION);
    let rows = plan('amber-gull');
    expect(rows).toEqual([
      expect.objectContaining({ name: 'amber-gull', action: 'resume', checkout: 'kept', harness: 'claude', terminal: 'terminal', terminalFrom: 'default' }),
    ]);
    expect(String(rows[0]!.why)).toContain(`claude --resume ${SESSION.slice(0, 8)}`);

    // cold: no saved history
    fs.rmSync(path.join(claudeHome, 'projects'), { recursive: true });
    rows = plan('--all');
    expect(rows).toEqual([expect.objectContaining({ name: 'amber-gull', action: 'cold', checkout: 'kept' })]);
    expect(String(rows[0]!.why)).toContain(`no saved Claude history for session ${SESSION.slice(0, 8)}`);

    // cold: the profile switches harness
    const set = lobstah(primary, 'man', 'roster', 'set', 'amber-gull', '--harness', 'codex', '--terminal', 'iterm', '--model', 'gpt-5.5', '--config', 'effort=high');
    expect(set.status, set.stderr || set.stdout).toBe(0);
    claudeTranscript(live.worktree, SESSION);
    rows = plan('amber-gull');
    expect(rows[0]).toMatchObject({ action: 'cold', harness: 'codex', harnessFrom: 'profile', model: 'gpt-5.5', config: { effort: 'high' }, terminal: 'iterm', terminalFrom: 'profile' });
    expect(String(rows[0]!.why)).toContain('a session resumes only under the harness that wrote it');
    expect(lobstah(primary, 'man', 'roster', 'set', 'amber-gull', '--harness', 'default', '--terminal', 'default').status).toBe(0);

    // missing worktree: recreated from the protected ref; without the ref, unresolved
    const reg2 = (() => {
      expect(soak(primary, OTHER, '--name', 'blue-heron').status).toBe(0);
      return listTraps().find((t) => t.name === 'blue-heron')!;
    })();
    const head = pushedCommit(reg2);
    expect(lobstah(reg2.worktree, 'stow', '--session', OTHER).status).toBe(0);
    expect(fs.existsSync(reg2.worktree)).toBe(false);
    rows = plan('blue-heron');
    expect(rows[0]).toMatchObject({ action: 'cold', checkout: 'recreate', revision: head });
    expect(String(rows[0]!.why)).toContain(`checkout recreated from refs/lobstah/traps/${reg2.trapId}`);
    git(primary, 'update-ref', '-d', `refs/lobstah/traps/${reg2.trapId}`);
    rows = plan('blue-heron');
    expect(rows[0]).toMatchObject({ action: 'unresolved' });
    expect(String(rows[0]!.why)).toContain('is gone and no protected ref keeps its revision');

    // live: skipped
    expect(soak(live.worktree, SESSION).status).toBe(0);
    rows = plan('--repo', 'r');
    expect(rows.map((r) => [r.name, r.action])).toEqual([
      ['amber-gull', 'skip'],
      ['blue-heron', 'unresolved'],
    ]);
    expect(String(rows[0]!.why)).toContain('live: session');

    // the plan wrote nothing a throw would: no reservation, no new trap
    expect(fs.readdirSync(path.join(home, 'soaking')).filter((f) => f.endsWith('.starting'))).toEqual([]);
    expect(listTraps().map((t) => t.name)).toEqual(['amber-gull']);
  });

  processTest('refuses without --plan, and the TOON output names the plan read-only', () => {
    expect(soak(primary).status).toBe(0);
    const bare = lobstah(primary, 'man', 'throw', '--all');
    expect(bare.status).toBe(2);
    expect(bare.stdout + bare.stderr).toContain('launches nothing yet');
    const res = lobstah(primary, 'man', 'throw', '--plan', '--all');
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('plan: read-only — launches nothing');
    expect(res.stdout).toMatch(/^throw\[1\]\{trap,repo,action,harness,model,config,terminal,checkout,revision,held,why\}:$/m);
  });
});

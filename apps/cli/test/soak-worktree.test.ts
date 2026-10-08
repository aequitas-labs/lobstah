import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setImmediate as yieldToWorker } from 'node:timers/promises';
import { ensureLayout, heartbeatTrap, listNotices, listTraps, queuedDescriptor, readEvidence, readTrap, readTrapAnchor, sweepGhostTraps, unhandledTrapMessages, type TrapRegistration } from '@lobstah/core';
import { planCull, planPressureCull, removeWorktree } from '../src/cull.js';
import { removeTempDir } from '../../../test/temp-dir.js';

// End to end: soak and stow through the built CLI, against throwaway repos
// with a bare origin. Every test has its own LOBSTAH_HOME.
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
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-soakwt-')));
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
afterEach(async () => {
  // Sync subprocess tests can occupy the worker for over Vitest's RPC deadline
  // as a group on Windows. Let task-update replies run between tests.
  await yieldToWorker();
  removeTempDir(tmp);
  delete process.env.LOBSTAH_HOME;
});

/** Run the CLI in `cwd` with no harness, app, or terminal environment of its own. */
function lobstah(cwd: string, ...args: string[]) {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX') && k !== 'TERM_PROGRAM' && k !== '__CFBundleIdentifier'),
  );
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
const worktreeCount = () => git(primary, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;
const hasBranch = (b: string) => spawnSync('git', ['-C', primary, 'rev-parse', '--verify', '-q', `refs/heads/${b}`]).status === 0;
const only = (): TrapRegistration => {
  const traps = listTraps();
  expect(traps).toHaveLength(1);
  return traps[0]!;
};
const same = (a: string, b: string) => {
  const c = (p: string) => (process.platform === 'win32' ? fs.realpathSync.native(p).toLowerCase() : fs.realpathSync.native(p));
  return c(a) === c(b);
};

describe('soak creates a worktree when the session has none', () => {
  processTest('stores only a valid --link and never creates a trap for an invalid one', () => {
    const invalid = soak(primary, '--link', 'javascript:alert(1)');
    expect(invalid.status).not.toBe(0);
    expect(invalid.stdout).toContain('invalid --link');
    expect(listTraps()).toEqual([]);
    expect(soakDirs()).toEqual([]);
    const valid = soak(primary, '--link', 'vscode://anthropic.claude-code/open?session=abc-123');
    expect(valid.status, valid.stderr).toBe(0);
    expect(only().link).toBe('vscode://anthropic.claude-code/open?session=abc-123');
    const res = lobstah(primary, 'focus', 'wt:missing');
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('Trap is not live.');
  });
  processTest('prints and changes a stable name, refusing malformed or taken names', () => {
    const first = soak(primary, '--name', 'amber-gull');
    expect(first.status, first.stderr).toBe(0);
    const reg = only();
    expect(kv(first.stdout, 'name')).toBe('amber-gull');
    expect(reg.name).toBe('amber-gull');
    expect(soak(primary).status).toBe(0);
    expect(only().name).toBe('amber-gull');
    expect(soak(primary, '--name', 'Amber Gull').status).not.toBe(0);
    expect(soak(primary, '--name', 'blue-heron').status).toBe(0);
    expect(only().name).toBe('blue-heron');
    expect(readTrapAnchor(reg.worktree)?.name).toBe('blue-heron');
  });

  processTest('dispatch, send, and stow accept name and id addresses', () => {
    expect(soak(primary, '--name', 'amber-gull').status).toBe(0);
    const reg = only();
    for (const [index, address] of ['amber-gull', 'wt:amber-gull', `wt:${reg.trapId}`].entries()) {
      const id = `aaaaaaaa-bbbb-4ccc-8ddd-${String(index).padStart(12, '0')}`;
      const sent = lobstah(primary, 'dispatch', '--repo', 'r', '--id', id, '--brief-text', 'do it', '--for', address);
      expect(sent.status, sent.stderr).toBe(0);
      expect(queuedDescriptor(id, 'work')?.for).toBe(`wt:${reg.trapId}`);
    }
    for (const address of ['amber-gull', 'wt:amber-gull', `wt:${reg.trapId}`]) {
      const sent = lobstah(primary, 'send', address, 'hello');
      expect(sent.status, sent.stderr).toBe(0);
    }
    expect(unhandledTrapMessages(reg.trapId)).toHaveLength(3);
    for (const address of ['amber-gull', 'wt:amber-gull', `wt:${reg.trapId}`]) {
      const status = lobstah(primary, 'status', address);
      expect(status.status, status.stderr).toBe(0);
      expect(kv(status.stdout, 'name')).toBe('amber-gull');
    }
    const unknown = lobstah(primary, 'dispatch', '--repo', 'r', '--brief-text', 'do it', '--for', 'missing-gull');
    expect(unknown.status).not.toBe(0);
    expect(`${unknown.stdout}${unknown.stderr}`).toContain('amber-gull');
    const unknownSend = lobstah(primary, 'send', 'missing-gull', 'hello');
    expect(unknownSend.status).not.toBe(0);
    expect(`${unknownSend.stdout}${unknownSend.stderr}`).toContain('amber-gull');
    const unknownStow = lobstah(primary, 'stow', '--wt', 'missing-gull');
    expect(unknownStow.status).not.toBe(0);
    expect(`${unknownStow.stdout}${unknownStow.stderr}`).toContain('amber-gull');
    expect(lobstah(primary, 'stow', '--wt', 'wt:amber-gull', '--keep').status).toBe(0);
    expect(soak(primary).status).toBe(0);
    expect(lobstah(primary, 'stow', '--wt', 'amber-gull', '--keep').status).toBe(0);
  });

  processTest('from a primary checkout: one worktree, on its own branch, marked as created by soak', () => {
    const res = soak(primary);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/^created: true$/m);
    expect(res.stdout).toContain('instruction: ');
    const reg = only();
    expect(reg.createdWorktree).toBe(true);
    expect(soakDirs()).toEqual([`soak-${reg.trapId}`]);
    expect(same(reg.worktree, path.join(home, 'worktrees', `soak-${reg.trapId}`))).toBe(true);
    expect(same(kv(res.stdout, 'worktree')!, reg.worktree)).toBe(true);
    expect(git(reg.worktree, 'branch', '--show-current')).toBe(`lobstah/soak-${reg.trapId}`);
    expect(git(reg.worktree, 'rev-parse', 'HEAD')).toBe(git(primary, 'rev-parse', 'origin/main'));
    expect(readTrapAnchor(reg.worktree)).toMatchObject({ trapId: reg.trapId, createdBy: 'soak', sessionId: SESSION, repo: 'r' });
    expect(worktreeCount()).toBe(2);
  });

  processTest('again from the primary checkout, or from anywhere else, re-uses the same trap', () => {
    expect(soak(primary).status).toBe(0);
    const first = only();
    const again = soak(primary);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).not.toMatch(/^created:/m);
    expect(kv(again.stdout, 'trap')).toBe(`wt:${first.trapId}`);
    const elsewhere = soak(outside);
    expect(elsewhere.status, elsewhere.stderr).toBe(0);
    expect(kv(elsewhere.stdout, 'trap')).toBe(`wt:${first.trapId}`);
    expect(only().trapId).toBe(first.trapId);
    expect(soakDirs()).toHaveLength(1);
    expect(worktreeCount()).toBe(2);
  });

  processTest('re-uses its own worktree after the registration was swept', () => {
    expect(soak(primary).status).toBe(0);
    const first = only();
    fs.rmSync(path.join(home, 'soaking', `${first.trapId}.json`));
    const res = soak(primary);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).not.toMatch(/^created:/m);
    expect(only()).toMatchObject({ trapId: first.trapId, createdWorktree: true });
    expect(soakDirs()).toHaveLength(1);
  });

  processTest('from a linked worktree: signs on there and creates nothing', () => {
    const linked = path.join(tmp, 'linked');
    git(primary, 'worktree', 'add', '-q', linked, '-b', 'mine');
    const res = soak(linked);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).not.toMatch(/^created:/m);
    expect(res.stdout).not.toContain('instruction: ');
    const reg = only();
    expect(same(reg.worktree, linked)).toBe(true);
    expect(reg.createdWorktree).toBeUndefined();
    expect(soakDirs()).toEqual([]);
  });

  processTest('from outside any repo: --repo names the repo; without it the error names --repo', () => {
    const bare = soak(outside);
    expect(bare.status).not.toBe(0);
    expect(bare.stdout).toContain('--repo <key>');
    expect(listTraps()).toEqual([]);
    const res = soak(outside, '--repo', 'r');
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/^created: true$/m);
    expect(only()).toMatchObject({ repo: 'r', createdWorktree: true });
  });

  processTest('a failed setup leaves no worktree, no branch, and no registration', () => {
    config(`setup = ['node -e "process.exit(3)"']\n`);
    const res = soak(primary);
    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain('could not create a worktree for repo r');
    expect(res.stdout).toContain('process.exit(3)');
    expect(listTraps()).toEqual([]);
    expect(soakDirs()).toEqual([]);
    expect(worktreeCount()).toBe(1);
    expect(git(primary, 'branch', '--list', 'lobstah/*')).toBe('');
  });

  processTest('a failed disk check or trunk fetch creates nothing', () => {
    config('', '[limits]\nminFreeGB = 1000000\n\n');
    const disk = soak(primary);
    expect(disk.status).not.toBe(0);
    expect(disk.stdout).toContain('[limits].minFreeGB');
    config();
    removeTempDir(origin);
    const fetch = soak(primary);
    expect(fetch.status).not.toBe(0);
    expect(fetch.stdout).toContain('could not create a worktree for repo r');
    expect(listTraps()).toEqual([]);
    expect(soakDirs()).toEqual([]);
    expect(worktreeCount()).toBe(1);
  });
});

describe('stow keeps the worktree; --remove removes one soak created', () => {
  processTest('a clean one is removed, with its branch; stow by session id from the primary checkout', () => {
    expect(soak(primary).status).toBe(0);
    const reg = only();
    git(reg.worktree, 'branch', '--set-upstream-to=origin/main');
    fs.mkdirSync(path.join(reg.worktree, 'build'));
    fs.writeFileSync(path.join(reg.worktree, 'build', 'out.js'), 'ignored output');
    const res = lobstah(primary, 'stow', '--session', SESSION, '--remove');
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain(`stowed: wt:${reg.trapId}`);
    expect(res.stdout).toMatch(/^worktree: removed$/m);
    expect(same(kv(res.stdout, 'returnTo')!, primary)).toBe(true);
    expect(fs.existsSync(reg.worktree)).toBe(false);
    expect(hasBranch(`lobstah/soak-${reg.trapId}`)).toBe(false);
    expect(listTraps()).toEqual([]);
    expect(worktreeCount()).toBe(1);
  });

  processTest('by default it signs off and keeps a clean worktree; --keep is the same; --force needs --remove', () => {
    expect(soak(primary).status).toBe(0);
    const reg = only();
    git(reg.worktree, 'branch', '--set-upstream-to=origin/main');
    const res = lobstah(primary, 'stow', '--session', SESSION);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/^worktree: kept$/m);
    expect(res.stdout).toContain('reason: stow keeps the worktree; --remove removes it');
    expect(fs.existsSync(reg.worktree)).toBe(true);
    expect(hasBranch(`lobstah/soak-${reg.trapId}`)).toBe(true);
    expect(listTraps()).toEqual([]);
    expect(soak(primary).status).toBe(0);
    expect(lobstah(primary, 'stow', '--session', SESSION, '--keep').stdout).toMatch(/^worktree: kept$/m);
    expect(soak(primary).status).toBe(0);
    expect(lobstah(primary, 'stow', '--session', SESSION, '--force').status).toBe(2);
    expect(lobstah(primary, 'stow', '--session', SESSION, '--remove', '--keep').status).toBe(2);
  });

  processTest('run from inside the worktree it removes', () => {
    expect(soak(primary).status).toBe(0);
    const reg = only();
    git(reg.worktree, 'branch', '--set-upstream-to=origin/main');
    const res = lobstah(reg.worktree, 'stow', '--remove');
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/^worktree: removed$/m);
    expect(same(kv(res.stdout, 'returnTo')!, primary)).toBe(true);
    expect(res.stdout).toContain(`cd ${kv(res.stdout, 'returnTo')}`);
    expect(fs.existsSync(reg.worktree)).toBe(false);
  });

  const kept = (setup: (wt: string) => void, reason: RegExp, branchSurvives = false) => () => {
    expect(soak(primary).status).toBe(0);
    const reg = only();
    setup(reg.worktree);
    const res = lobstah(primary, 'stow', '--session', SESSION, '--remove');
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain(`stowed: wt:${reg.trapId}`);
    expect(res.stdout).toMatch(/^worktree: kept$/m);
    expect(kv(res.stdout, 'reason')).toMatch(reason);
    expect(fs.existsSync(reg.worktree)).toBe(true);
    expect(fs.existsSync(path.join(reg.worktree, '.lobstah-trap'))).toBe(true);
    expect(listTraps()).toEqual([]);
    if (branchSurvives) expect(hasBranch(`lobstah/soak-${reg.trapId}`)).toBe(true);
  };
  processTest('keeps one with uncommitted changes, and says why', kept((wt) => fs.writeFileSync(path.join(wt, 'f.txt'), 'two\n'), /uncommitted changes in 1 file\(s\): f\.txt/));
  processTest('keeps one with untracked files, and says why', kept((wt) => fs.writeFileSync(path.join(wt, 'notes.md'), 'x'), /1 untracked file\(s\) that are not ignored: notes\.md/));
  processTest(
    'keeps one with unpushed commits, and says why',
    kept((wt) => {
      fs.writeFileSync(path.join(wt, 'g.txt'), 'g');
      git(wt, 'add', 'g.txt');
      git(wt, 'commit', '-q', '-m', 'local only');
    }, /1 commit\(s\) on no remote branch/, true),
  );

  processTest('keeps the checkout when commits pushed elsewhere are absent from its upstream', () => {
    expect(soak(primary).status).toBe(0);
    const reg = only();
    const wt = reg.worktree;
    git(wt, 'switch', '-q', '-c', 'feature');
    fs.writeFileSync(path.join(wt, 'g.txt'), 'g');
    git(wt, 'add', 'g.txt');
    git(wt, 'commit', '-q', '-m', 'pushed elsewhere');
    git(wt, 'push', '-q', 'origin', 'HEAD:other');
    git(wt, 'branch', '-q', '--set-upstream-to=origin/main');
    const res = lobstah(primary, 'stow', '--session', SESSION, '--remove');
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/^worktree: kept$/m);
    expect(kv(res.stdout, 'reason')).toMatch(/1 unpushed commit/);
    expect(fs.existsSync(wt)).toBe(true);
    expect(hasBranch('feature')).toBe(true);
  });

  processTest('keeps a clean branch without an upstream', kept(() => {}, /no upstream/, true));

  processTest('--force explicitly removes unsaved files but keeps unique commits on the branch', () => {
    expect(soak(primary).status).toBe(0);
    const reg = only();
    fs.writeFileSync(path.join(reg.worktree, 'f.txt'), 'committed');
    git(reg.worktree, 'commit', '-qam', 'local work');
    fs.writeFileSync(path.join(reg.worktree, 'notes.md'), 'unsaved');
    const res = lobstah(primary, 'stow', '--session', SESSION, '--remove', '--force');
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/^worktree: removed$/m);
    expect(fs.existsSync(reg.worktree)).toBe(false);
    expect(hasBranch(`lobstah/soak-${reg.trapId}`)).toBe(true);
    expect(kv(res.stdout, 'branchKept')).toContain('1 commit(s)');
  });

  processTest('leaves a worktree soak did not create, and says so', () => {
    const linked = path.join(tmp, 'linked');
    git(primary, 'worktree', 'add', '-q', linked, '-b', 'mine');
    expect(soak(linked).status).toBe(0);
    const res = lobstah(linked, 'stow', '--remove');
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/^worktree: kept$/m);
    expect(kv(res.stdout, 'reason')).toContain('soak did not create this worktree');
    expect(fs.existsSync(linked)).toBe(true);
    expect(listTraps()).toEqual([]);
  });

  processTest('the SessionEnd hook signs off and keeps the worktree', () => {
    expect(soak(primary).status).toBe(0);
    const reg = only();
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX')));
    const res = spawnSync(process.execPath, [cli, 'stow', '--quiet'], {
      cwd: reg.worktree,
      encoding: 'utf8',
      env: { ...base, LOBSTAH_HOME: home },
      input: JSON.stringify({ session_id: SESSION, hook_event_name: 'SessionEnd', cwd: reg.worktree }),
      timeout: 60_000,
    });
    expect(res.status, res.stderr).toBe(0);
    expect(listTraps()).toEqual([]);
    expect(fs.existsSync(reg.worktree)).toBe(true);
  });

  processTest("the helm's stow --wt follows the same rules", () => {
    expect(soak(primary).status).toBe(0);
    const reg = only();
    git(reg.worktree, 'branch', '--set-upstream-to=origin/main');
    const keep = lobstah(outside, 'stow', '--wt', reg.trapId, '--keep', '--session', OTHER);
    expect(keep.status, keep.stderr).toBe(0);
    expect(keep.stdout).toMatch(/^worktree: kept$/m);
    expect(fs.existsSync(reg.worktree)).toBe(true);
    expect(soak(primary).status).toBe(0);
    fs.writeFileSync(path.join(reg.worktree, 'notes.md'), 'x');
    const dirty = lobstah(outside, 'stow', '--wt', reg.trapId, '--remove', '--session', OTHER);
    expect(dirty.stdout).toMatch(/^worktree: kept$/m);
    fs.rmSync(path.join(reg.worktree, 'notes.md'));
    const clean = lobstah(outside, 'stow', '--wt', reg.trapId, '--remove', '--session', OTHER);
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stdout).toMatch(/^worktree: removed$/m);
    expect(fs.existsSync(reg.worktree)).toBe(false);
  });
});

describe('a soak-created trap works by session id from the primary checkout', () => {
  processTest('soak --wait, send, and report', () => {
    expect(soak(primary).status).toBe(0);
    const reg = only();
    // --wait by session id: parks the same trap, a quiet timeout exits 3.
    const quiet = soak(primary, '--wait', '--timeout', '1');
    expect(quiet.status, quiet.stderr).toBe(3);
    expect(kv(quiet.stdout, 'trap')).toBe(`wt:${reg.trapId}`);
    expect(readTrap(reg.trapId)?.firstParkedAt).toBeDefined();
    // send by session address from here.
    const sent = lobstah(primary, 'send', `session:${SESSION}`, 'hello');
    expect(sent.status, sent.stderr).toBe(0);
    expect(sent.stdout).toContain(`to: wt:${reg.trapId}`);
    const woke = soak(primary, '--wait', '--timeout', '5');
    expect(woke.status, woke.stderr).toBe(0);
    expect(woke.stdout).toContain('hello');
    // Addressed work, claimed from the primary checkout.
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    expect(lobstah(primary, 'dispatch', '--repo', 'r', '--id', id, '--brief-text', 'do it', '--for', `wt:${reg.trapId}`).status).toBe(0);
    const caught = soak(primary, '--wait', '--timeout', '5');
    expect(caught.status, caught.stderr).toBe(0);
    expect(caught.stdout).toContain(`assigned dispatch ${id}`);
    fs.writeFileSync(path.join(reg.worktree, 'g.txt'), 'g');
    git(reg.worktree, 'add', 'g.txt');
    git(reg.worktree, 'commit', '-q', '-m', 'work');
    const done = lobstah(primary, 'report', id, 'done', '--session', SESSION, '--', 'finished');
    expect(done.status, done.stderr).toBe(0);
    expect(readEvidence(id, 'work')).toMatchObject({
      commits: [git(reg.worktree, 'rev-parse', 'HEAD')],
      branch: `lobstah/soak-${reg.trapId}`,
    });
  });
});

describe('cull and the auto-cull see soak-created worktrees', () => {
  processTest("a live trap's worktree is in use; once the trap is gone it ages out", () => {
    expect(soak(primary).status).toBe(0);
    const reg = only();
    git(reg.worktree, 'branch', '--set-upstream-to=origin/main');
    const old = new Date(Date.now() - 30 * 86_400_000);
    fs.utimesSync(reg.worktree, old, old);
    const id = `soak-${reg.trapId}`;
    expect(planCull(14, Date.now(), { measure: false }).some((i) => i.id === id)).toBe(false);
    expect(planPressureCull().some((i) => i.id === id)).toBe(false);
    fs.rmSync(path.join(home, 'soaking', `${reg.trapId}.json`));
    expect(planCull(14, Date.now(), { measure: false }).some((i) => i.kind === 'worktree' && i.id === id)).toBe(true);
    expect(planPressureCull().some((i) => i.id === id)).toBe(true);
  });

  for (const kind of ['dirty', 'unpushed', 'no-upstream', 'clean', 'unreadable', 'detached'] as const) {
    processTest(`ghost sweep ${kind === 'clean' ? 'removes' : 'preserves'} a ${kind} soak checkout`, () => {
      expect(soak(primary).status).toBe(0);
      const reg = only();
      if (kind !== 'no-upstream') git(reg.worktree, 'branch', '--set-upstream-to=origin/main');
      if (kind === 'dirty') fs.writeFileSync(path.join(reg.worktree, 'f.txt'), 'unsaved');
      if (kind === 'unpushed') {
        fs.writeFileSync(path.join(reg.worktree, 'f.txt'), 'local');
        git(reg.worktree, 'commit', '-qam', 'local work');
        // A commit existing on another remote branch is still unpushed to its upstream.
        git(reg.worktree, 'push', '-q', 'origin', 'HEAD:elsewhere');
      }
      if (kind === 'clean') {
        fs.writeFileSync(path.join(reg.worktree, 'f.txt'), 'pushed work');
        git(reg.worktree, 'commit', '-qam', 'pushed work');
        git(reg.worktree, 'push', '-qu', 'origin', 'HEAD');
      }
      if (kind === 'unreadable') fs.rmSync(path.join(reg.worktree, '.git'));
      if (kind === 'detached') git(reg.worktree, 'switch', '-q', '--detach');
      heartbeatTrap(reg.trapId, { parked: true });
      const actions = sweepGhostTraps(1000, Date.now() + 60_000);
      expect(actions).toEqual([{ trapId: reg.trapId, worktree: kind === 'clean' ? 'removed' : 'kept' }]);
      expect(readTrap(reg.trapId)).toBeUndefined();
      expect(fs.existsSync(reg.worktree)).toBe(kind !== 'clean');
      expect(hasBranch(`lobstah/soak-${reg.trapId}`)).toBe(true);
      const notice = listNotices().find((n) => n.kind === 'trap-ghosted')!;
      expect(notice.text).toContain(reg.worktree);
      const unknown = kind === 'unreadable' || kind === 'detached';
      expect(notice.text).toContain(`branch ${unknown ? 'unknown' : `lobstah/soak-${reg.trapId}`}`);
      expect(notice.text).toContain(`modified files ${unknown ? 'unknown' : kind === 'dirty' ? 1 : 0}`);
      expect(notice.text).toContain(`unpushed commits ${unknown ? 'unknown' : kind === 'unpushed' ? 1 : 0}`);
      if (kind !== 'clean') {
        const id = `soak-${reg.trapId}`;
        expect(planCull(0, Date.now(), { measure: false }).some((i) => i.id === id)).toBe(false);
        expect(planPressureCull().some((i) => i.id === id)).toBe(false);
        removeWorktree(id, reg.worktree);
        expect(fs.existsSync(reg.worktree)).toBe(true);
        expect(readTrapAnchor(reg.worktree)?.trapId).toBe(reg.trapId);
      }
    });
  }

  processTest('culling rechecks safety when files change after planning', () => {
    expect(soak(primary).status).toBe(0);
    const reg = only();
    git(reg.worktree, 'branch', '--set-upstream-to=origin/main');
    fs.rmSync(path.join(home, 'soaking', `${reg.trapId}.json`));
    const id = `soak-${reg.trapId}`;
    expect(planPressureCull().some((i) => i.id === id)).toBe(true);
    const file = path.join(reg.worktree, 'notes with spaces.md');
    fs.writeFileSync(file, 'unsaved');
    removeWorktree(id, reg.worktree);
    expect(fs.readFileSync(file, 'utf8')).toBe('unsaved');
    expect(readTrapAnchor(reg.worktree)?.trapId).toBe(reg.trapId);
  });
});

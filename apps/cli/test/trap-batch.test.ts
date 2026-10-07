import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setImmediate as yieldToWorker } from 'node:timers/promises';
import { ensureLayout, listNotices, listTraps, loadConfig, planThrow, readRoster, unseenNotices, type TrapRegistration } from '@lobstah/core';
import { throwBatch, type TerminalAdapter, type TerminalLaunch } from '../src/throw.js';
import { removeTempDir } from '../../../test/temp-dir.js';

// Batches, fresh traps, and forget, through the real reservation, checkout,
// and sign-on paths. Only the terminal is fake (see trap-throw.test.ts).
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const processTest = (name: string, run: () => Promise<void> | void) => it(name, run, 120_000);
const session = (n: number) => `11111111-2222-4333-8444-${String(n).padStart(12, '0')}`;

let tmp: string;
let home: string;
let primary: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-batch-')));
  home = path.join(tmp, 'home');
  process.env.LOBSTAH_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
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
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...base, LOBSTAH_HOME: home, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') }, input: '', timeout: 60_000 });
}

/** A trap that signed on, listened once, and (unless `live`) stowed with its worktree kept. */
function trap(n: number, name: string, live = false): TrapRegistration {
  const res = lobstah(primary, 'soak', '--session', session(n), '--harness', 'claude', '--name', name);
  expect(res.status, res.stderr).toBe(0);
  const reg = listTraps().find((t) => t.name === name)!;
  lobstah(reg.worktree, 'soak', '--session', session(n), '--wait', '--timeout', '1');
  if (!live) expect(lobstah(reg.worktree, 'stow', '--session', session(n)).status).toBe(0);
  return reg;
}

/** A terminal that signs a session on for every launch except those `refuse` names. */
function fakeTerminal(seen: TerminalLaunch[], refuse: (l: TerminalLaunch) => boolean = () => false): (app: 'terminal' | 'iterm') => TerminalAdapter {
  let next = 50;
  return (app) => ({
    app,
    async launch(launch) {
      seen.push(launch);
      if (refuse(launch)) return; // the session never starts
      const ticket = /--ticket (\S+)/.exec(launch.argv.at(-1)!)![1]!;
      const s = session(next++);
      const on = lobstah(launch.cwd, 'soak', '--ticket', ticket, '--session', s, '--harness', 'claude');
      expect(on.status, on.stderr || on.stdout).toBe(0);
      const reg = listTraps().find((t) => t.sessionId === s)!;
      lobstah(reg.worktree, 'soak', '--session', s, '--wait', '--timeout', '1');
    },
  });
}

describe('man throw --all', () => {
  processTest('a batch with one failure: the others come back, results per trap, one summary notice, no per-trap wakes', async () => {
    const a = trap(1, 'amber-gull');
    trap(2, 'blue-heron');
    const c = trap(3, 'crisp-tern');
    trap(4, 'dawn-otter', true); // live: skipped
    unseenNotices(true);
    const before = listNotices(100).at(-1)!.seq;

    const seen: TerminalLaunch[] = [];
    const rows = planThrow(loadConfig(), { all: true });
    const results = await throwBatch({ cfg: loadConfig(), rows, adapter: fakeTerminal(seen, (l) => l.cwd === c.worktree), pollMs: 50, timeoutSecs: 3 });
    expect(results.map((r) => [r.trap.split(' ')[0], r.result])).toEqual([
      ['amber-gull', 'cold'],
      ['blue-heron', 'cold'],
      ['crisp-tern', 'failed'],
      ['dawn-otter', 'skipped'],
    ]);
    expect(results.find((r) => r.result === 'failed')!.why).toContain('did not sign on within 3s');
    expect(results.find((r) => r.result === 'skipped')!.why).toContain('live: session');
    expect(seen).toHaveLength(3);
    expect(listTraps().map((t) => t.name).sort()).toEqual(['amber-gull', 'blue-heron', 'dawn-otter']);
    expect(readRoster(a.trapId)).toMatchObject({ state: 'live' });
    expect(readRoster(c.trapId)).toMatchObject({ state: 'stowed' });

    const kinds = listNotices(100).map((n) => n.kind);
    expect(kinds.filter((k) => k === 'trap-batch')).toHaveLength(1);
    const fresh = listNotices(100).filter((n) => n.seq > before && n.kind === 'trap-available');
    expect(fresh).toHaveLength(2);
    expect(fresh.every((n) => n.quiet)).toBe(true);
    const summary = listNotices(100).find((n) => n.kind === 'trap-batch')!;
    expect(summary.text).toContain('2 available (0 resumed, 2 cold, 0 new), 1 skipped, 1 failed — failed: crisp-tern');
    // What wakes the helm: the summary and the failed start, nothing per trap.
    expect(unseenNotices(true).map((n) => n.kind).sort()).toEqual(['trap-batch', 'trap-start-failed']);
  });

  processTest('--new --count N starts fresh traps from the primary checkout, as one batch', async () => {
    const seen: TerminalLaunch[] = [];
    const results = await throwBatch({ cfg: loadConfig(), repo: 'r', count: 2, adapter: fakeTerminal(seen), pollMs: 50, timeoutSecs: 20 });
    expect(results.map((r) => r.result)).toEqual(['new', 'new']);
    expect(seen.map((l) => l.cwd)).toEqual([primary, primary]);
    expect(seen[0]!.argv[0]).toBe('claude');
    const traps = listTraps();
    expect(traps).toHaveLength(2);
    expect(new Set(traps.map((t) => t.trapId)).size).toBe(2);
    expect(traps.every((t) => t.worktree.includes(`soak-${t.trapId}`))).toBe(true);
    expect(listNotices(100).filter((n) => n.kind === 'trap-batch')).toHaveLength(1);
  });

  processTest('--dry-run lists every eligible trap and launches nothing', () => {
    trap(1, 'amber-gull');
    const res = lobstah(primary, 'man', 'throw', '--all', '--dry-run');
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('plan: dry run — launches nothing');
    expect(res.stdout).toMatch(/amber-gull \(wt:[0-9a-f]{8}\),r,cold,/);
    const fresh = lobstah(primary, 'man', 'throw', '--new', '--count', '3', '--repo', 'r', '--dry-run');
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(fresh.stdout).toMatch(/^throw\[3\]/m);
    expect(listTraps()).toEqual([]);
  });
});

describe('man roster forget', () => {
  processTest('refuses a live trap and unpushed commits (naming them); forgets once the work is merged', () => {
    const reg = trap(1, 'amber-gull', true);
    const live = lobstah(primary, 'man', 'roster', 'forget', 'amber-gull');
    expect(live.status).not.toBe(0);
    expect(live.stdout + live.stderr).toContain('never forget a live trap');
    fs.writeFileSync(path.join(reg.worktree, 'w.txt'), 'w\n');
    git(reg.worktree, 'add', 'w.txt');
    git(reg.worktree, 'commit', '-q', '-m', 'local only work');
    expect(lobstah(reg.worktree, 'stow', '--session', session(1)).status).toBe(0);

    const refused = lobstah(primary, 'man', 'roster', 'forget', 'amber-gull');
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain('not forgetting amber-gull');
    expect(refused.stdout).toContain('1 commit(s) on no remote branch and not merged to main');
    expect(refused.stdout).toContain('local only work');
    expect(readRoster(reg.trapId)).toBeDefined();
    expect(fs.existsSync(reg.worktree)).toBe(true);

    // Merged to trunk: forget goes through.
    const head = git(reg.worktree, 'rev-parse', 'HEAD');
    git(primary, 'merge', '-q', '--ff-only', head);
    const res = lobstah(primary, 'man', 'roster', 'forget', 'amber-gull');
    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(res.stdout).toContain('worktree: removed');
    expect(res.stdout).toContain('ref: deleted');
    expect(readRoster(reg.trapId)).toBeUndefined();
    expect(fs.existsSync(reg.worktree)).toBe(false);
    expect(spawnSync('git', ['-C', primary, 'rev-parse', '-q', '--verify', `refs/lobstah/traps/${reg.trapId}`]).status).not.toBe(0);
    expect(lobstah(primary, 'man', 'throw', '--dry-run', 'amber-gull').stdout).toContain('no roster record');
  });

  processTest('--force forgets despite unpushed commits; the branch that holds them stays', () => {
    const reg = trap(1, 'amber-gull', true);
    fs.writeFileSync(path.join(reg.worktree, 'w.txt'), 'w\n');
    git(reg.worktree, 'add', 'w.txt');
    git(reg.worktree, 'commit', '-q', '-m', 'local only work');
    expect(lobstah(reg.worktree, 'stow', '--session', session(1)).status).toBe(0);
    const res = lobstah(primary, 'man', 'roster', 'forget', 'amber-gull', '--force');
    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(res.stdout).toContain('dropped: 1 commit(s) on no remote (--force)');
    expect(res.stdout).toContain(`branchKept: lobstah/soak-${reg.trapId}`);
    expect(readRoster(reg.trapId)).toBeUndefined();
  });
});

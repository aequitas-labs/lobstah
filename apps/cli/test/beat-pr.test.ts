import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendStatus, claimBait, enqueue, ensureLayout, laneDirs, listWatches, mergeEvidence, readEvidence, readTrap, readWatch, signOnTrap, upsertPr } from '@lobstah/core';
import type { Descriptor, PrEvidence, TrapRegistration } from '@lobstah/core';
import { runBeat } from '../src/beat.js';
import type { ProbeRun } from '../src/beat-pr.js';
import { deliverPrRepairs } from '../src/pr-repair.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const ID = 'bbbbbbbb-1111-2222-3333-444444444444';
const URL_ = 'https://github.com/acme/web/pull/41';
const KEY = 'pr:acme/web#41';
const T0 = Date.parse('2026-09-29T12:00:00Z');
let home: string;
let wt: string;

const git = (cwd: string, ...args: string[]) => {
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
};

/** A worktree with a remote: trunk pushed, and a feature branch pushed with its upstream set. */
function repo(): string {
  const remote = path.join(home, 'remote.git');
  const dir = path.join(home, 'wt');
  fs.mkdirSync(dir);
  git(home, 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'a');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  git(dir, 'switch', '-q', '-c', 'feature');
  git(dir, 'push', '-q', '-u', 'origin', 'feature');
  return dir;
}

function caughtTrap(): TrapRegistration {
  const signed = signOnTrap({ sessionId: 'trap-s', harness: 'claude', repo: 'web', worktree: wt, cwd: wt, ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('unexpected hold');
  enqueue({ id: ID, repo: 'web', brief: 'trap work' });
  expect(claimBait(signed.ok)?.id).toBe(ID);
  return readTrap(signed.ok.trapId)!;
}

/** Real git; a fake gh that answers with `gh` and counts its calls. */
function fakeRun(gh: () => { status: number | null; stdout: string }) {
  const calls = { git: 0, gh: 0 };
  const run: ProbeRun = (cmd, args, cwd) => {
    if (cmd === 'gh') {
      calls.gh++;
      return gh();
    }
    calls.git++;
    const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    return { status: res.status, stdout: res.stdout ?? '' };
  };
  return { run, calls };
}

const hook = (reg: TrapRegistration) => ({ session_id: 'trap-s', cwd: reg.worktree, tool_name: 'Bash', tool_input: { command: 'ls' } });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-beat-pr-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  wt = repo();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

describe('the trap beat records its catch PR', () => {
  it('records the PR and its watch once; the next beats run no gh', () => {
    const reg = caughtTrap();
    const { run, calls } = fakeRun(() => ({ status: 0, stdout: `${URL_}\n` }));
    runBeat(hook(reg), { run, now: T0 });
    expect(readEvidence(ID, 'work').prUrl).toBe(URL_);
    expect(readWatch(KEY)?.owner).toBe(`dispatch:${ID}`);
    expect(calls.gh).toBe(1);

    // Within the minute: no git and no gh.
    const gitCalls = calls.git;
    runBeat(hook(reg), { run, now: T0 + 30_000 });
    expect(calls.git).toBe(gitCalls);

    // After the minute, on the same branch: git only, and nothing new.
    runBeat(hook(reg), { run, now: T0 + 61_000 });
    expect(calls.gh).toBe(1);
    expect(listWatches().filter((w) => w.key === KEY)).toHaveLength(1);
  });

  it('records nothing with trunk checked out', () => {
    git(wt, 'switch', '-q', 'main');
    const reg = caughtTrap();
    const { run, calls } = fakeRun(() => ({ status: 0, stdout: URL_ }));
    runBeat(hook(reg), { run, now: T0 });
    expect(calls.gh).toBe(0);
    expect(readEvidence(ID, 'work').prUrl).toBeUndefined();
    expect(readWatch(KEY)).toBeUndefined();
  });

  it('asks gh nothing for a branch that still tracks trunk', () => {
    git(wt, 'switch', '-q', '-c', 'unpushed', '--track', 'origin/main');
    const reg = caughtTrap();
    const { run, calls } = fakeRun(() => ({ status: 0, stdout: URL_ }));
    runBeat(hook(reg), { run, now: T0 });
    expect(calls.gh).toBe(0);
    expect(readEvidence(ID, 'work').prUrl).toBeUndefined();
  });

  it('records nothing and does not throw when gh fails', () => {
    const reg = caughtTrap();
    const failing = fakeRun(() => ({ status: 1, stdout: '' }));
    expect(() => runBeat(hook(reg), { run: failing.run, now: T0 })).not.toThrow();
    expect(failing.calls.gh).toBe(1);
    const throwing: ProbeRun = (cmd) => {
      if (cmd === 'gh') throw new Error('gh exploded');
      return { status: 0, stdout: 'feature\n' };
    };
    expect(() => runBeat(hook(reg), { run: throwing, now: T0 + 61_000 })).not.toThrow();
    expect(readEvidence(ID, 'work').prUrl).toBeUndefined();
    expect(readWatch(KEY)).toBeUndefined();
    expect(fs.readFileSync(path.join(home, 'logs', 'beat.log'), 'utf8')).toContain('gh exploded');
  });
});

describe('a PR recorded before done repairs through its trap', () => {
  const SHA = 'cccccccccccccccccccccccccccccccccccccccc';
  const pr = (): PrEvidence => ({
    url: URL_,
    number: 41,
    state: 'OPEN',
    draft: false,
    reviewDecision: '',
    mergeStateStatus: 'DIRTY',
    headSha: SHA,
    baseRefName: 'main',
    headRefName: 'feature',
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    observedAt: new Date().toISOString(),
  });
  const queued = (): Descriptor[] =>
    (['work', 'chore'] as const).flatMap((lane) =>
      fs
        .readdirSync(laneDirs(lane).queue)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(laneDirs(lane).queue, f), 'utf8')) as Descriptor),
    );

  const record = {
    'the beat': () => runBeat(hook(readTrap(caughtTrapId)!), { run: fakeRun(() => ({ status: 0, stdout: URL_ })).run, now: T0 }),
    'report working --pr': () => {
      const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
      delete env.CLAUDE_CODE_SESSION_ID;
      const res = spawnSync(process.execPath, [cli, 'report', ID, 'working', 'pushed', '--pr', URL_], { encoding: 'utf8', env, timeout: 10_000 });
      expect(res.status).toBe(0);
    },
  };
  let caughtTrapId = '';

  for (const [how, recordPr] of Object.entries(record)) {
    it(`${how}: the repair is addressed to the trap`, () => {
      fs.writeFileSync(path.join(home, 'config.toml'), '[watch]\nrepairSettleSecs = 0\n');
      caughtTrapId = caughtTrap().trapId;
      recordPr();
      expect(readWatch(KEY)?.owner).toBe(`dispatch:${ID}`);
      // The trap finishes without naming the PR again; done records its HEAD.
      mergeEvidence(ID, 'work', { commits: [SHA] });
      appendStatus(ID, 'work', 'done', 'finished');
      upsertPr(pr(), ID);
      upsertPr(pr(), ID);
      expect(deliverPrRepairs(() => {}, 3)).toBe(1);
      expect(queued().find((d) => d.followUp === ID)?.for).toBe(`wt:${caughtTrapId}`);
    });
  }
});

import { afterEach, beforeEach, describe, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  addWatch,
  appendStatus,
  claimNext,
  dispatchWorktree,
  enqueue,
  ensureLayout,
  laneDirs,
  mergeEvidence,
  readEvidence,
  readWatch,
  readStatusLog,
  readWorktreeLock,
  signOnTrap,
  upsertPr,
  worktreePath,
} from '@lobstah/core';
import type { NormalizedEvent, PrEvidence } from '@lobstah/core';
import { AsyncQueue } from '@lobstah/adapters';
import type { Adapter, AdapterRun, AdapterStartOpts } from '@lobstah/adapters';
import { main } from '../src/run.js';
import { processTest as it } from '../../../test/process-test.js';

/**
 * Follow-ups reuse the origin chain's worktree. Real git throughout: a local
 * bare repo is the origin, the configured repo is a clone of it, and the
 * worktrees are real linked worktrees. Only the harness is a mock.
 */

let root: string;
let home: string;
let setupLog: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

function writeConfig(extra = ''): void {
  const repo = path.join(root, 'clone');
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    [
      '[repos.r]',
      `path = ${JSON.stringify(repo)}`,
      `origin = ${JSON.stringify(path.join(root, 'origin.git'))}`,
      'trunk = "main"',
      'scratch = ["tmp"]',
      // Counts setup runs outside the worktree, so the count never dirties it.
      `setup = [${JSON.stringify(`node -e "require('fs').appendFileSync(process.env.SETUP_LOG,'x')"`)}]`,
      '[repos.r.env]',
      `SETUP_LOG = ${JSON.stringify(setupLog)}`,
      extra,
    ].join('\n'),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-reuse-'));
  home = path.join(root, 'home');
  fs.mkdirSync(home);
  process.env.LOBSTAH_HOME = home;
  process.env.CODEX_HOME = path.join(root, 'codex');
  delete process.env.LOBSTAH_RESUME;
  delete process.env.LOBSTAH_NUDGE;
  ensureLayout();
  setupLog = path.join(root, 'setup.log');
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, seed);
  fs.writeFileSync(path.join(seed, 'pnpm-lock.yaml'), 'lockfileVersion: 1\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', origin, path.join(root, 'clone'));
  writeConfig();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
  delete process.env.CODEX_HOME;
});

const setupRuns = () => (fs.existsSync(setupLog) ? fs.readFileSync(setupLog, 'utf8').length : 0);

interface Seen {
  cwd: string;
  head: string;
  branch: string;
}

/**
 * A harness that records where it started (cwd, HEAD, branch), runs `work`
 * in the worktree, and reports done. `gate` holds it at the start, so tests
 * can run two dispatches at once.
 */
function harness(work: (cwd: string) => void = () => {}, gate?: Promise<void>, lane: 'work' | 'chore' = 'work') {
  const seen: Seen[] = [];
  const prompts: string[] = [];
  const adapter = (name: string): Adapter => ({
    name,
    async start(o: AdapterStartOpts): Promise<AdapterRun> {
      prompts.push(o.prompt);
      seen.push({ cwd: o.cwd, head: git(o.cwd, 'rev-parse', 'HEAD'), branch: git(o.cwd, 'rev-parse', '--abbrev-ref', 'HEAD') });
      const events = new AsyncQueue<NormalizedEvent>();
      let resolveDone!: (v: { sessionId?: string }) => void;
      const done = new Promise<{ sessionId?: string }>((r) => (resolveDone = r));
      void (async () => {
        await gate;
        const at = () => new Date().toISOString();
        events.push({ at: at(), type: 'session', data: { sessionId: `${o.id}-session` } });
        events.push({ at: at(), type: 'tool-start', data: { name: 'Bash' } });
        work(o.cwd);
        appendStatus(o.id, lane, 'done', 'finished');
        events.push({ at: at(), type: 'turn-end', data: {} });
      })();
      const finish = () => {
        events.close();
        resolveDone({ sessionId: `${o.id}-session` });
      };
      return { events, send: () => {}, end: finish, kill: finish, done };
    },
  });
  return { seen, prompts, deps: { loadAdapter: adapter } };
}

const commit = (msg: string, file = 'work.txt', body = msg) => (cwd: string) => {
  fs.writeFileSync(path.join(cwd, file), body);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', msg);
};

async function run(id: string, followUp: string | undefined, h: ReturnType<typeof harness>): Promise<void> {
  enqueue({ id, repo: 'r', brief: 'do it', ...(followUp ? { followUp } : {}) });
  expect(claimNext('work')).toBe(id);
  await main(path.join(laneDirs('work').active, id), 'work', h.deps);
}

const firstNote = (id: string) => readStatusLog(id, 'work')[0]?.note ?? '';

describe('a follow-up reuses its origin chain’s worktree', () => {
  for (const [kind, brief] of [
    ['repair', 'Repair the existing PR on feature/pr. Do not open a new PR.'],
    ['send', 'Continue the finished PR work.'],
  ]) it(`a ${kind} follow-up keeps the origin PR without creating a new remote branch`, async () => {
    await run('origin', undefined, harness(commit('origin work')));
    const prUrl = 'https://github.com/example/repo/pull/17';
    if (kind === 'send') mergeEvidence('origin', 'work', { prUrl });
    upsertPr({
      url: prUrl, number: 17, state: 'OPEN', draft: true,
      reviewDecision: '', mergeStateStatus: 'CLEAN',
      headSha: git(worktreePath('origin'), 'rev-parse', 'HEAD'),
      baseRefName: 'main', headRefName: 'feature/pr',
      checks: { total: 0, passed: 0, failed: 0, pending: 0 },
      observedAt: new Date().toISOString(),
    } satisfies PrEvidence, 'origin');
    // A drafted PR already has a watch; keep this integration test focused on
    // follow-up reuse rather than launching another CLI process under CI load.
    addWatch('pr:example/repo#17', 'echo {}', { owner: 'dispatch:origin' });
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const calls = path.join(root, 'gh-calls');
    const gh = path.join(bin, 'gh');
    fs.writeFileSync(gh, `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\nexit 1\n`);
    fs.chmodSync(gh, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
    try {
      const id = kind === 'repair' ? 'repair' : 'sent';
      enqueue({ id, repo: 'r', brief, followUp: 'origin' });
      expect(claimNext('work')).toBe(id);
      const worker = harness(commit(`${kind} work`));
      await main(path.join(laneDirs('work').active, id), 'work', worker.deps);
      expect(readEvidence(id, 'work').prUrl).toBe(prUrl);
      expect(worker.prompts[0]).toContain('Head branch: feature/pr');
      expect(readWatch('pr:example/repo#17')?.key).toBe('pr:example/repo#17');
      expect(git(path.join(root, 'origin.git'), 'branch', '--list', 'lobstah/repair')).toBe('');
      expect(git(path.join(root, 'origin.git'), 'branch', '--list', 'lobstah/sent')).toBe('');
      expect(fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '').not.toContain('pr create');
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it('reuses a finished origin’s clean worktree: same checkout, same HEAD, no second setup', async () => {
    const o = harness(commit('origin work'));
    await run('origin', undefined, o);
    const wt = worktreePath('origin');
    const originHead = git(wt, 'rev-parse', 'HEAD');
    expect(setupRuns()).toBe(1);
    expect(readWorktreeLock(wt)).toBeUndefined(); // released at finalize

    const f = harness(commit('review fix', 'fix.txt'));
    await run('fu', 'origin', f);

    expect(f.seen[0]).toEqual({ cwd: wt, head: originHead, branch: 'lobstah/origin' });
    expect(fs.existsSync(worktreePath('fu'))).toBe(false);
    expect(setupRuns()).toBe(1);
    expect(firstNote('fu')).toContain('reusing worktree of origin');
    expect(readEvidence('fu', 'work')).toMatchObject({ worktree: wt, worktreeOf: 'origin', branch: 'lobstah/origin' });
    expect(readEvidence('fu', 'work').commits).toHaveLength(2);
    expect(dispatchWorktree('fu', 'work')).toEqual({ path: wt, owner: 'origin', reused: true });
    expect(readWorktreeLock(wt)).toBeUndefined();

    // A follow-up of the follow-up resolves through the chain to the same checkout.
    const g = harness();
    await run('fu2', 'fu', g);
    expect(g.seen[0]!.cwd).toBe(wt);
    expect(readEvidence('fu2', 'work').worktreeOf).toBe('origin');
    expect(firstNote('fu2')).toContain('reusing worktree of fu');
  });

  it('re-runs setup when the lockfile changed since the origin ran it', async () => {
    await run('origin', undefined, harness(commit('bump deps', 'pnpm-lock.yaml', 'lockfileVersion: 2\n')));
    expect(setupRuns()).toBe(1);
    const f = harness();
    await run('fu', 'origin', f);
    expect(f.seen[0]!.cwd).toBe(worktreePath('origin'));
    expect(setupRuns()).toBe(2);
    // Recorded again: a third run in the same checkout does not repeat it.
    await run('fu2', 'fu', harness());
    expect(setupRuns()).toBe(2);
  });

  it('a dirty origin worktree is left alone and the follow-up allocates fresh', async () => {
    await run('origin', undefined, harness((cwd) => fs.writeFileSync(path.join(cwd, 'half-done.txt'), 'wip')));
    const wt = worktreePath('origin');
    const f = harness();
    await run('fu', 'origin', f);
    expect(f.seen[0]!.cwd).toBe(worktreePath('fu'));
    expect(firstNote('fu')).toContain('fresh worktree (origin worktree has uncommitted changes; allocated a fresh one)');
    expect(fs.readFileSync(path.join(wt, 'half-done.txt'), 'utf8')).toBe('wip');
    expect(git(wt, 'status', '--porcelain')).toBe('?? half-done.txt');
    expect(readEvidence('fu', 'work').worktreeOf).toBeUndefined();
  });

  it('untracked files under a scratch path do not block reuse', async () => {
    await run(
      'origin',
      undefined,
      harness((cwd) => {
        fs.mkdirSync(path.join(cwd, 'tmp'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'tmp', 'notes.md'), 'scratch');
      }),
    );
    const f = harness();
    await run('fu', 'origin', f);
    expect(f.seen[0]!.cwd).toBe(worktreePath('origin'));
  });

  it('an origin worktree already culled: fresh allocation', async () => {
    await run('origin', undefined, harness(commit('origin work')));
    git(path.join(root, 'clone'), 'worktree', 'remove', '--force', worktreePath('origin'));
    const f = harness();
    await run('fu', 'origin', f);
    expect(f.seen[0]!.cwd).toBe(worktreePath('fu'));
    expect(firstNote('fu')).toContain('fresh worktree (origin worktree is gone)');
  });

  it('two follow-ups of one origin at once: one reuses, the other allocates fresh', async () => {
    await run('origin', undefined, harness(commit('origin work')));
    enqueue({ id: 'fa', repo: 'r', brief: 'a', followUp: 'origin' });
    enqueue({ id: 'fb', repo: 'r', brief: 'b', followUp: 'origin' });
    expect(claimNext('work')).toBeTruthy();
    expect(claimNext('work')).toBeTruthy();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const a = harness(() => {}, gate);
    const b = harness(() => {}, gate);
    const runs = [
      main(path.join(laneDirs('work').active, 'fa'), 'work', a.deps),
      main(path.join(laneDirs('work').active, 'fb'), 'work', b.deps),
    ];
    // Both are now inside their harness: never two runners in one checkout.
    while (a.seen.length === 0 || b.seen.length === 0) await new Promise((r) => setTimeout(r, 10));
    const cwds = [a.seen[0]!.cwd, b.seen[0]!.cwd].sort();
    expect(cwds).toContain(worktreePath('origin'));
    expect(new Set(cwds).size).toBe(2);
    const fresh = cwds.find((c) => c !== worktreePath('origin'))!;
    expect([worktreePath('fa'), worktreePath('fb')]).toContain(fresh);
    open();
    await Promise.all(runs);
    const notes = [firstNote('fa'), firstNote('fb')].sort();
    expect(notes.some((n) => n.includes('reusing worktree of origin'))).toBe(true);
    expect(notes.some((n) => /fresh worktree \(origin worktree is in use by f[ab]\)/.test(n))).toBe(true);
  });

  it('a stale lock (its holder finished) does not block reuse', async () => {
    await run('origin', undefined, harness(commit('origin work')));
    const wt = worktreePath('origin');
    const gitDir = git(wt, 'rev-parse', '--path-format=absolute', '--git-dir');
    fs.writeFileSync(path.join(gitDir, 'lobstah.lock'), JSON.stringify({ id: 'origin', lane: 'work', pid: 1, at: 'x' }));
    const f = harness();
    await run('fu', 'origin', f);
    expect(f.seen[0]!.cwd).toBe(wt);
  });

  it('a worktree a trap is anchored in is never reused', async () => {
    await run('origin', undefined, harness(commit('origin work')));
    const wt = worktreePath('origin');
    const res = signOnTrap({ worktree: wt, cwd: wt, repo: 'r', harness: 'claude', sessionId: 's', ttlMs: 3_600_000 });
    expect('ok' in res).toBe(true);
    const f = harness();
    await run('fu', 'origin', f);
    expect(f.seen[0]!.cwd).toBe(worktreePath('fu'));
    expect(firstNote('fu')).toContain('fresh worktree (origin worktree is a trap’s)');
  });

  it('a headless repair of trap-built work starts from the PR head in its own checkout', async () => {
    await run('origin', undefined, harness(commit('origin work')));
    const wt = worktreePath('origin');
    const prHead = git(wt, 'rev-parse', 'HEAD');
    git(wt, 'push', '-q', 'origin', 'HEAD:refs/heads/feature/pr');
    expect(signOnTrap({ worktree: wt, cwd: wt, repo: 'r', harness: 'claude', sessionId: 's', ttlMs: 3_600_000 })).toHaveProperty('ok');

    enqueue({
      id: 'repair', repo: 'r', brief: 'Repair the existing PR', followUp: 'origin',
      pr: { url: 'https://github.com/example/repo/pull/17', headRefName: 'feature/pr', headSha: prHead },
      systemRepair: {},
    }, 'chore');
    expect(claimNext('chore')).toBe('repair');
    const worker = harness(() => {}, undefined, 'chore');
    await main(path.join(laneDirs('chore').active, 'repair'), 'chore', worker.deps);

    expect(worker.seen[0]).toEqual({ cwd: worktreePath('repair'), head: prHead, branch: 'lobstah/repair' });
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(prHead);
    expect(fs.existsSync(worktreePath('repair'))).toBe(true);
    expect(readEvidence('repair', 'chore')).toMatchObject({ worktree: worktreePath('repair'), prUrl: 'https://github.com/example/repo/pull/17' });
  });

  it('a headless repair of headless-built work reuses the safe origin checkout', async () => {
    await run('origin', undefined, harness(commit('origin work')));
    const wt = worktreePath('origin');
    const prHead = git(wt, 'rev-parse', 'HEAD');
    enqueue({
      id: 'repair', repo: 'r', brief: 'Repair the existing PR', followUp: 'origin',
      pr: { url: 'https://github.com/example/repo/pull/17', headRefName: 'feature/pr', headSha: prHead },
      systemRepair: {},
    }, 'chore');
    expect(claimNext('chore')).toBe('repair');
    const worker = harness(() => {}, undefined, 'chore');
    await main(path.join(laneDirs('chore').active, 'repair'), 'chore', worker.deps);

    expect(worker.seen[0]).toEqual({ cwd: wt, head: prHead, branch: 'lobstah/origin' });
    expect(fs.existsSync(worktreePath('repair'))).toBe(false);
    expect(readEvidence('repair', 'chore')).toMatchObject({ worktree: wt, worktreeOf: 'origin' });
  });

  it('reuseWorktree = false: every follow-up allocates fresh, as before', async () => {
    writeConfig('[limits]\nreuseWorktree = false');
    await run('origin', undefined, harness(commit('origin work')));
    const f = harness();
    await run('fu', 'origin', f);
    expect(f.seen[0]).toMatchObject({ cwd: worktreePath('fu'), branch: 'lobstah/fu' });
    expect(firstNote('fu')).not.toContain('worktree');
    expect(setupRuns()).toBe(2);
  });
});

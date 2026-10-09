import { afterEach, beforeEach, describe, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  acquireWorktreeLock,
  appendStatus,
  claimNext,
  enqueue,
  ensureLayout,
  laneDirs,
  listNotices,
  loadConfig,
  poolSlotPath,
  poolView,
  poolWaits,
  queuedDescriptor,
  readEvidence,
  readSlotClaim,
  readSlotOut,
  readStatusLog,
  readWorktreeLock,
  worktreePath,
} from '@lobstah/core';
import type { NormalizedEvent } from '@lobstah/core';
import { AsyncQueue } from '@lobstah/adapters';
import type { Adapter, AdapterRun, AdapterStartOpts } from '@lobstah/adapters';
import { claimPoolSlot, poolKeep, warmPool } from '@lobstah/worktree';
import { main } from '../src/run.js';
import { processTest as it } from '../../../test/process-test.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * Worktree pools: real git throughout (a local bare repo is the origin, the
 * configured repo a clone of it, the pool slots real linked worktrees). Only
 * the harness is a mock.
 */

let root: string;
let home: string;
let setupLog: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

function writeConfig(pool: { size?: number; overflow?: string; limits?: string[]; extraRepo?: string[] } = {}): void {
  const repo = path.join(root, 'clone');
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    [
      '[limits]',
      // No gh calls: a local bare origin has no PRs.
      'draftPr = false',
      ...(pool.limits ?? []),
      '[repos.r]',
      `path = ${JSON.stringify(repo)}`,
      `origin = ${JSON.stringify(path.join(root, 'origin.git'))}`,
      'trunk = "main"',
      // Counts setup runs outside the worktree, so the count never dirties it.
      `setup = [${JSON.stringify(`node -e "require('fs').appendFileSync(process.env.SETUP_LOG,'x')"`)}]`,
      ...(pool.extraRepo ?? []),
      '[repos.r.env]',
      `SETUP_LOG = ${JSON.stringify(setupLog)}`,
      '[pools.p]',
      'repo = "r"',
      `size = ${pool.size ?? 1}`,
      `overflow = ${JSON.stringify(pool.overflow ?? 'headless')}`,
    ].join('\n'),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-pool-'));
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
  fs.writeFileSync(path.join(seed, '.gitignore'), ['node_modules/', '.turbo/', 'build/', '.env*', ''].join('\n'));
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', origin, path.join(root, 'clone'));
  writeConfig();
});
afterEach(() => {
  removeTempDir(root);
  delete process.env.LOBSTAH_HOME;
  delete process.env.CODEX_HOME;
});

const setupRuns = () => (fs.existsSync(setupLog) ? fs.readFileSync(setupLog, 'utf8').length : 0);

interface Seen {
  id: string;
  cwd: string;
  branch: string;
}

/** A harness that records where it started, runs `work` there, and reports done. */
function harness(work: (cwd: string, id: string) => void = () => {}, gate?: Promise<void>) {
  const seen: Seen[] = [];
  const adapter = (name: string): Adapter => ({
    name,
    async start(o: AdapterStartOpts): Promise<AdapterRun> {
      seen.push({ id: o.id, cwd: o.cwd, branch: git(o.cwd, 'rev-parse', '--abbrev-ref', 'HEAD') });
      const events = new AsyncQueue<NormalizedEvent>();
      let resolveDone!: (v: { sessionId?: string }) => void;
      const done = new Promise<{ sessionId?: string }>((r) => (resolveDone = r));
      void (async () => {
        await gate;
        const at = () => new Date().toISOString();
        events.push({ at: at(), type: 'session', data: { sessionId: `${o.id}-session` } });
        events.push({ at: at(), type: 'tool-start', data: { name: 'Bash' } });
        work(o.cwd, o.id);
        appendStatus(o.id, 'work', 'done', 'finished');
        events.push({ at: at(), type: 'turn-end', data: {} });
      })();
      const finish = () => {
        events.close();
        resolveDone({ sessionId: `${o.id}-session` });
      };
      return { events, send: () => {}, end: finish, kill: finish, done };
    },
  });
  return { seen, deps: { loadAdapter: adapter } };
}

const commit = (msg: string, file = 'work.txt') => (cwd: string) => {
  fs.writeFileSync(path.join(cwd, file), msg);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', msg);
};

async function run(id: string, opts: { pool?: string; followUp?: string }, h: ReturnType<typeof harness>): Promise<void> {
  enqueue({ id, repo: 'r', brief: 'do it', ...(opts.pool ? { pool: opts.pool } : {}), ...(opts.followUp ? { followUp: opts.followUp } : {}) });
  expect(claimNext('work')).toBe(id);
  await main(path.join(laneDirs('work').active, id), 'work', h.deps);
}

const firstNote = (id: string) => readStatusLog(id, 'work')[0]?.note ?? '';
const slot1 = () => poolSlotPath('p', 1);
const real = (p: string) => fs.realpathSync(p);

describe('pool config', () => {
  it('parses [pools.<name>] with defaults and rejects a bad one', () => {
    expect(loadConfig().pools).toEqual({ p: { repo: 'r', size: 1, overflow: 'headless' } });
    fs.appendFileSync(path.join(home, 'config.toml'), '\n[pools.q]\nrepo = "r"\n');
    expect(loadConfig().pools.q).toEqual({ repo: 'r', size: 1, overflow: 'headless' });
    fs.appendFileSync(path.join(home, 'config.toml'), '\n[pools.bad]\nrepo = "nope"\n');
    expect(() => loadConfig()).toThrow(/repo "nope" is not a configured/);
  });

  it('rejects an unknown overflow', () => {
    writeConfig({ overflow: 'later' });
    expect(() => loadConfig()).toThrow(/overflow must be "headless" or "queue"/);
  });
});

describe('warm-up', () => {
  it('creates missing slots as detached trunk checkouts with setup run', async () => {
    writeConfig({ size: 2 });
    expect(poolView('p', loadConfig().pools.p!).slots.map((s) => s.state)).toEqual(['missing', 'missing']);
    expect(await warmPool('p')).toBe(true);
    const view = poolView('p', loadConfig().pools.p!);
    expect(view.slots.map((s) => s.state)).toEqual(['free', 'free']);
    expect(view.free).toBe(2);
    expect(git(slot1(), 'rev-parse', 'HEAD')).toBe(git(path.join(root, 'clone'), 'rev-parse', 'origin/main'));
    expect(setupRuns()).toBe(2);
  });

  it('respects [limits].minFreeGB: no slot is created on a full volume', async () => {
    writeConfig({ limits: ['minFreeGB = 10'] });
    await warmPool('p', { freeBytes: () => 1024 ** 3 });
    expect(fs.existsSync(slot1())).toBe(false);
    const s = poolView('p', loadConfig().pools.p!).slots[0]!;
    expect(s.state).toBe('missing');
    expect(s.reason).toMatch(/minFreeGB/);
    await warmPool('p', { freeBytes: () => 50 * 1024 ** 3 });
    expect(poolView('p', loadConfig().pools.p!).slots[0]!.state).toBe('free');
  });

  it('never disturbs a claimed slot, and takes a dirty released one out of rotation', async () => {
    await warmPool('p');
    // A live dispatch holds slot 1 and has uncommitted work there.
    enqueue({ id: 'busy', repo: 'r', brief: 'x' });
    expect(claimNext('work')).toBe('busy');
    expect(acquireWorktreeLock(slot1(), 'busy', 'work')).toBeUndefined();
    fs.writeFileSync(path.join(slot1(), 'half.txt'), 'in progress');
    fs.writeFileSync(path.join(path.dirname(slot1()), '.slots', '1.claim.json'), JSON.stringify({ id: 'busy', lane: 'work', at: new Date().toISOString() }));
    await warmPool('p');
    expect(readSlotOut('p', 1)).toBeUndefined();
    expect(readWorktreeLock(slot1())?.id).toBe('busy');
    expect(fs.existsSync(path.join(slot1(), 'half.txt'))).toBe(true);
    // The dispatch finishes and leaves the change behind: out, with a notice naming it.
    fs.renameSync(path.join(laneDirs('work').active, 'busy'), path.join(laneDirs('work').done, 'busy'));
    await warmPool('p');
    expect(readSlotOut('p', 1)?.reason).toMatch(/uncommitted changes in 1 file\(s\): half\.txt/);
    const notice = listNotices().find((n) => n.kind === 'pool-out');
    expect(notice?.text).toContain('p/1');
    expect(notice?.text).toContain(slot1());
    // Cleaned up by hand: the next pass returns it.
    fs.rmSync(path.join(slot1(), 'half.txt'));
    await warmPool('p');
    expect(readSlotOut('p', 1)).toBeUndefined();
    expect(poolView('p', loadConfig().pools.p!).slots[0]!.state).toBe('free');
  });
});

describe('claim and release', () => {
  it('a pool dispatch runs in a reset pool worktree with a fresh session, and the worktree returns when it finishes', async () => {
    await warmPool('p');
    const h = harness(commit('pool work'));
    await run('one', { pool: 'p' }, h);
    expect(real(h.seen[0]!.cwd)).toBe(real(slot1()));
    expect(h.seen[0]!.branch).toBe('lobstah/one');
    expect(firstNote('one')).toContain('pool worktree p/1');
    expect(readEvidence('one', 'work')).toMatchObject({ pool: 'p/1', branch: 'lobstah/one' });
    expect(fs.existsSync(worktreePath('one'))).toBe(false);
    expect(readSlotClaim('p', 1)?.id).toBe('one');
    // Released: the lock is gone and the slot is free; the work is on the remote.
    expect(readWorktreeLock(slot1())).toBeUndefined();
    expect(poolView('p', loadConfig().pools.p!).free).toBe(1);
    expect(git(slot1(), 'rev-list', '--count', 'HEAD', '--not', '--remotes')).toBe('0');
    // Warm-up verifies the release and keeps it in rotation.
    await warmPool('p');
    expect(readSlotOut('p', 1)).toBeUndefined();

    // The next dispatch gets the same worktree, reset to its own branch from trunk.
    const h2 = harness();
    await run('two', { pool: 'p' }, h2);
    expect(real(h2.seen[0]!.cwd)).toBe(real(slot1()));
    expect(h2.seen[0]!.branch).toBe('lobstah/two');
    expect(fs.existsSync(path.join(slot1(), 'work.txt'))).toBe(false);
  });

  it('reset keeps dependency and build caches and local env files, and drops production env files and other untracked files', async () => {
    writeConfig({ extraRepo: ['poolKeep = ["build/keep-me/"]'] });
    await warmPool('p');
    const before = setupRuns();
    await run('one', { pool: 'p' }, harness((cwd) => {
      commit('work')(cwd);
      fs.mkdirSync(path.join(cwd, 'node_modules', 'dep'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'node_modules', 'dep', 'index.js'), 'x');
      fs.mkdirSync(path.join(cwd, 'pkg', 'node_modules', 'inner'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'pkg', 'node_modules', 'inner', 'index.js'), 'x');
      fs.mkdirSync(path.join(cwd, '.turbo'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.turbo', 'cache'), 'x');
      fs.writeFileSync(path.join(cwd, '.env.local'), 'LOCAL=1');
      fs.writeFileSync(path.join(cwd, '.env.production'), 'PROD=1');
      fs.writeFileSync(path.join(cwd, '.env.production.local'), 'PROD=1');
      fs.mkdirSync(path.join(cwd, 'build', 'keep-me'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'build', 'out.js'), 'x');
      fs.writeFileSync(path.join(cwd, 'build', 'keep-me', 'k'), 'x');
    }));
    await run('two', { pool: 'p' }, harness());
    const wt = slot1();
    for (const kept of ['node_modules/dep/index.js', 'pkg/node_modules/inner/index.js', '.turbo/cache', '.env.local', 'build/keep-me/k']) {
      expect(fs.existsSync(path.join(wt, kept)), kept).toBe(true);
    }
    for (const gone of ['.env.production', '.env.production.local', 'build/out.js', 'work.txt']) {
      expect(fs.existsSync(path.join(wt, gone)), gone).toBe(false);
    }
    // Setup runs on every reset: once per dispatch.
    expect(setupRuns() - before).toBe(2);
    expect(poolKeep({ poolKeep: ['x/'] })).toContain('node_modules/');
  });
});

describe('safety: a reset never discards work', () => {
  for (const kind of ['uncommitted changes', 'unpushed commits'] as const) {
    it(`refuses a worktree with ${kind}: out of rotation, a helm notice, and the dispatch runs cold (headless overflow)`, async () => {
      // No pushes at all, so a commit stays local.
      writeConfig({ limits: ['pushEarly = false', 'checkpointOnStop = false'] });
      await warmPool('p');
      await run('one', { pool: 'p' }, harness(kind === 'unpushed commits' ? commit('local only') : (cwd) => fs.writeFileSync(path.join(cwd, 'seed.txt'), 'edit')));
      const head = git(slot1(), 'rev-parse', 'HEAD');
      const h = harness();
      await run('two', { pool: 'p' }, h);
      expect(real(h.seen[0]!.cwd)).toBe(real(worktreePath('two')));
      expect(firstNote('two')).toMatch(/pool p full \(p\/1: .*\): cold worktree/);
      const out = readSlotOut('p', 1);
      expect(out?.reason).toMatch(kind === 'unpushed commits' ? /1 commit\(s\) on no remote branch/ : /uncommitted changes/);
      expect(out?.dispatch).toBe('one');
      expect(listNotices().find((n) => n.kind === 'pool-out')?.text).toContain('p/1');
      // Nothing in the worktree changed.
      expect(git(slot1(), 'rev-parse', 'HEAD')).toBe(head);
      expect(git(slot1(), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('lobstah/one');
      expect(poolView('p', loadConfig().pools.p!).slots[0]!.state).toBe('out');
    });
  }
});

describe('overflow', () => {
  /** Hold slot 1 with a live dispatch. */
  function occupy(): void {
    enqueue({ id: 'holder', repo: 'r', brief: 'x' });
    expect(claimNext('work')).toBe('holder');
    expect(acquireWorktreeLock(slot1(), 'holder', 'work')).toBeUndefined();
  }

  it('headless: a full pool runs the dispatch in a normal cold worktree', async () => {
    await warmPool('p');
    occupy();
    const h = harness();
    await run('cold', { pool: 'p' }, h);
    expect(real(h.seen[0]!.cwd)).toBe(real(worktreePath('cold')));
    expect(firstNote('cold')).toContain('pool p full: cold worktree');
    expect(readEvidence('cold', 'work').pool).toBeUndefined();
  });

  it('queue: the daemon leaves it queued, and a runner that lost the race puts it back untouched', async () => {
    writeConfig({ overflow: 'queue' });
    await warmPool('p');
    occupy();
    enqueue({ id: 'waits', repo: 'r', brief: 'do it', pool: 'p' });
    expect(poolWaits(queuedDescriptor('waits', 'work')!, loadConfig())).toBe(true);
    // A runner that got it anyway (a race) hands it back to the queue.
    expect(claimNext('work')).toBe('waits');
    const h = harness();
    await main(path.join(laneDirs('work').active, 'waits'), 'work', h.deps);
    expect(h.seen).toEqual([]);
    expect(queuedDescriptor('waits', 'work')?.pool).toBe('p');
    expect(fs.existsSync(path.join(laneDirs('work').active, 'waits'))).toBe(false);
    expect(readStatusLog('waits', 'work')).toEqual([]);
    // The holder finishes: the slot is free and the dispatch may go.
    fs.renameSync(path.join(laneDirs('work').active, 'holder'), path.join(laneDirs('work').done, 'holder'));
    expect(poolWaits(queuedDescriptor('waits', 'work')!, loadConfig())).toBe(false);
    expect(claimNext('work')).toBe('waits');
    await main(path.join(laneDirs('work').active, 'waits'), 'work', h.deps);
    expect(real(h.seen[0]!.cwd)).toBe(real(slot1()));
  });

  it('queue: a claimed dispatch that has not taken its slot yet counts against the free ones', async () => {
    writeConfig({ overflow: 'queue' });
    await warmPool('p');
    enqueue({ id: 'first', repo: 'r', brief: 'x', pool: 'p' });
    enqueue({ id: 'second', repo: 'r', brief: 'x', pool: 'p' });
    expect(poolWaits(queuedDescriptor('first', 'work')!, loadConfig())).toBe(false);
    expect(claimNext('work', (d) => poolWaits(d, loadConfig()))).toBe('first');
    expect(poolWaits(queuedDescriptor('second', 'work')!, loadConfig())).toBe(true);
    expect(claimNext('work', (d) => poolWaits(d, loadConfig()))).toBeNull();
  });
});

describe('two dispatches race for the last free worktree', () => {
  it('exactly one claims it; the other is told the pool is full', async () => {
    await warmPool('p');
    const cfg = loadConfig();
    for (const id of ['a', 'b']) {
      enqueue({ id, repo: 'r', brief: 'x', pool: 'p' });
      expect(claimNext('work')).toBe(id);
    }
    const input = (id: string) => ({ name: 'p', pool: cfg.pools.p!, repo: cfg.repos.r!, id, lane: 'work' as const, warmWaitMs: 0 });
    const results = await Promise.all([claimPoolSlot(input('a')), claimPoolSlot(input('b'))]);
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(results.filter((r) => !r.claimed)).toHaveLength(1);
    const winner = results[0]!.claimed ? 'a' : 'b';
    expect(readWorktreeLock(slot1())?.id).toBe(winner);
    expect(readSlotClaim('p', 1)?.id).toBe(winner);
  });

  it('through the runner: one runs in the pool, the other cold', async () => {
    await warmPool('p');
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const h = harness(() => {}, gate);
    for (const id of ['a', 'b']) {
      enqueue({ id, repo: 'r', brief: 'x', pool: 'p' });
      expect(claimNext('work')).toBe(id);
    }
    const runs = ['a', 'b'].map((id) => main(path.join(laneDirs('work').active, id), 'work', h.deps));
    while (h.seen.length < 2) await new Promise((r) => setTimeout(r, 20));
    open();
    await Promise.all(runs);
    const cwds = h.seen.map((s) => real(s.cwd)).sort();
    const inPool = h.seen.filter((s) => real(s.cwd) === real(slot1()));
    expect(inPool).toHaveLength(1);
    const loser = inPool[0]!.id === 'a' ? 'b' : 'a';
    expect(cwds).toContain(real(worktreePath(loser)));
  });
});

describe('follow-ups', () => {
  it('reuse the pool worktree while it is still at their chain’s HEAD: same conversation, same worktree', async () => {
    await warmPool('p');
    await run('origin', { pool: 'p' }, harness(commit('origin work')));
    const head = git(slot1(), 'rev-parse', 'HEAD');
    const h = harness();
    await run('follow', { followUp: 'origin' }, h);
    expect(real(h.seen[0]!.cwd)).toBe(real(slot1()));
    expect(h.seen[0]!.branch).toBe('lobstah/origin');
    expect(git(slot1(), 'rev-parse', 'HEAD')).toBe(head);
    expect(firstNote('follow')).toContain('reusing worktree of origin');
    expect(readSlotClaim('p', 1)?.id).toBe('follow');
    // A second follow-up continues from the first.
    const h2 = harness();
    await run('follow2', { followUp: 'follow' }, h2);
    expect(real(h2.seen[0]!.cwd)).toBe(real(slot1()));
  });

  it('fall back as for a gone worktree once a pool dispatch has reset it, and say so in the first note', async () => {
    await warmPool('p');
    await run('origin', { pool: 'p' }, harness(commit('origin work')));
    await run('other', { pool: 'p' }, harness());
    const h = harness();
    await run('follow', { followUp: 'origin' }, h);
    expect(real(h.seen[0]!.cwd)).toBe(real(worktreePath('follow')));
    expect(firstNote('follow')).toContain('fresh worktree (origin pool worktree p/1 was reused by other)');
    // The pool worktree was left alone.
    expect(git(slot1(), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('lobstah/other');
  });

  it('a follow-up dispatched with --pool falls back into a free pool worktree', async () => {
    await warmPool('p');
    await run('origin', { pool: 'p' }, harness(commit('origin work')));
    await run('other', { pool: 'p' }, harness());
    expect(readEvidence('other', 'work').pool).toBe('p/1');
    const h = harness();
    await run('follow', { followUp: 'origin', pool: 'p' }, h);
    expect(firstNote('follow')).toContain('origin pool worktree p/1 was reused by other');
    expect(firstNote('follow')).toContain('pool worktree p/1');
    expect(h.seen[0]!.branch).toBe('lobstah/follow');
  });
});

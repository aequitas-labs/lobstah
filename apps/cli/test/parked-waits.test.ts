import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  activeIds,
  appendStatus,
  claimNext,
  enqueue,
  ensureLayout,
  laneDirs,
  addWatch,
  mergeEvidence,
  prRecordFile,
  readPr,
  readEvidence,
  readStatusLog,
  readWatch,
  requestCancel,
  sendMessage,
  slotUsage,
  unhandled,
} from '@lobstah/core';
import type { GhPrView, Lane, PrRef, WaitingOn } from '@lobstah/core';
import { tick } from '@lobstah/supervisor';
import type { ActiveState } from '@lobstah/supervisor';
import { cliCuller } from '../src/auto-cull.js';
import { runDoctor } from '../src/doctor.js';
import { finishResolvedWaits, observeWaitedPrs, registerWaitWatches } from '../src/pr-waits.js';
import { daemonStatus } from '../src/restart.js';
import { buildTendReport, renderTend } from '../src/tend.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * A dispatch parked on `paused` holds no slot, wakes when its wait ends, and
 * finishes when the PR it waits on merges or closes.
 */

const PR = 'https://github.com/o/r/pull/7';
let root: string;
let home: string;
let repo: string;
let now: number;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

/** A pid that is not running: a child that has already exited. */
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!;

function config(extra = ''): void {
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    `[repos.r]\npath = ${JSON.stringify(repo)}\ntrunk = "main"\n[limits]\nmaxConcurrent = 1\n${extra}`,
  );
}

/** An active headless dispatch whose runner exited after its worker's last report. */
function parked(
  id: string,
  opts: { followUp?: string; waitingOn?: WaitingOn; link?: string; until?: string; worktree?: boolean; lane?: Lane; noPr?: boolean } = {},
): void {
  const lane = opts.lane ?? 'work';
  enqueue({ id, repo: 'r', brief: 'b', ...(opts.followUp ? { followUp: opts.followUp } : {}) }, lane);
  expect(claimNext(lane)).toBe(id);
  const dir = path.join(laneDirs(lane).active, id);
  fs.writeFileSync(path.join(dir, 'runner.json'), JSON.stringify({ pid: deadPid(), startedAt: new Date(now - 60_000).toISOString(), attempts: 1 }));
  if (opts.worktree) {
    const wt = path.join(home, 'worktrees', id);
    git(repo, 'worktree', 'add', '-q', '-b', `lobstah/${id}`, wt, 'origin/main');
    fs.writeFileSync(path.join(wt, `${id}.txt`), id);
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', `work of ${id}`);
    git(wt, 'push', '-q', 'origin', `lobstah/${id}`);
    fs.writeFileSync(path.join(dir, 'worktree.json'), JSON.stringify({ path: wt }));
    mergeEvidence(id, lane, { worktree: wt, branch: `lobstah/${id}` });
  }
  mergeEvidence(id, lane, { ...(opts.noPr ? {} : { prUrl: PR }), sessionId: `session-${id}` });
  appendStatus(id, lane, 'working');
  appendStatus(id, lane, 'paused', 'waiting for approval', undefined, {
    ...(opts.waitingOn ? { waitingOn: opts.waitingOn } : {}),
    ...(opts.link ? { link: opts.link } : {}),
    ...(opts.until ? { until: opts.until } : {}),
  });
}

function prRecord(state: 'OPEN' | 'MERGED' | 'CLOSED', dispatches: string[] = [], url = PR): void {
  const n = Number(url.split('/').at(-1));
  const key = `pr:o/r#${n}`;
  fs.mkdirSync(path.dirname(prRecordFile(key)), { recursive: true });
  fs.writeFileSync(
    prRecordFile(key),
    JSON.stringify({
      key,
      repo: 'o/r',
      url,
      number: n,
      state,
      draft: false,
      reviewDecision: '',
      mergeStateStatus: 'UNKNOWN',
      headSha: 'x',
      checks: { total: 0, passed: 0, failed: 0, pending: 0 },
      dispatches,
      standingSince: {},
      observedAt: new Date(now).toISOString(),
    }),
  );
}

const verbOf = (id: string, lane: Lane = 'work') => readStatusLog(id, lane).at(-1);

/** One daemon tick with the CLI's hooks; returns the dispatches it spawned and the log. */
function daemonTick(): { spawned: Array<{ id: string; wake?: string; resume?: string; attempts: number }>; log: string[] } {
  const spawned: Array<{ id: string; wake?: string; resume?: string; attempts: number }> = [];
  const log: string[] = [];
  tick((m) => log.push(m), {
    culler: cliCuller,
    now: () => now,
    prWatches: (_at, l) => {
      finishResolvedWaits(l);
    },
    spawnRunner: (st: ActiveState, opts) => {
      spawned.push({ id: st.id, ...opts });
      // A spawned runner is alive from its spawn on.
      fs.writeFileSync(path.join(st.dir, 'runner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), attempts: opts.attempts }));
    },
  });
  return { spawned, log };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-parked-'));
  home = path.join(root, 'home');
  fs.mkdirSync(home);
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  now = Date.now();
  const origin = path.join(root, 'origin.git');
  repo = path.join(root, 'clone');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, repo);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(repo, 'push', '-q', 'origin', 'main');
  config();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(root);
});

describe('a merged or closed PR finishes the dispatches parked on it', () => {
  it('merge: a paused dispatch waiting on its PR reaches done on its own and frees its slot', () => {
    parked('d1', { waitingOn: 'review', link: PR });
    prRecord('OPEN', ['d1']);
    daemonTick();
    expect(verbOf('d1')?.verb).toBe('paused');
    prRecord('MERGED', ['d1']);
    daemonTick();
    expect(verbOf('d1')).toMatchObject({ verb: 'done', note: `the PR merged: ${PR}` });
    expect(fs.existsSync(path.join(laneDirs('work').done, 'd1'))).toBe(true);
    expect(activeIds('work')).toEqual([]);
    expect(slotUsage('work')).toEqual({ headless: 0, traps: 0, parked: 0 });
  });

  it('closed without merge finishes it failed', () => {
    parked('d1', { waitingOn: 'pr' });
    prRecord('CLOSED', ['d1']);
    expect(finishResolvedWaits()).toEqual([{ id: 'd1', lane: 'work', pr: 'pr:o/r#7', verb: 'failed' }]);
    expect(verbOf('d1')).toMatchObject({ verb: 'failed', note: `the PR closed without merge: ${PR}` });
  });

  it('every dispatch in the chain parked on the PR is finished, not only the latest', () => {
    parked('d1', { waitingOn: 'review' });
    parked('d2', { waitingOn: 'pr', followUp: 'd1' });
    parked('d3', { waitingOn: 'deploy', followUp: 'd2' });
    prRecord('MERGED', ['d1']);
    const finished = finishResolvedWaits().map((f) => f.id).sort();
    expect(finished).toEqual(['d1', 'd2']);
    expect(verbOf('d1')?.verb).toBe('done');
    expect(verbOf('d2')?.verb).toBe('done');
    // A wait on something other than a PR is not the PR's to end.
    expect(verbOf('d3')?.verb).toBe('paused');
  });

  it('the link names the PR waited on; a dispatch working is left alone', () => {
    const other = 'https://github.com/o/r/pull/8';
    parked('d1', { waitingOn: 'pr', link: other });
    prRecord('MERGED', ['d1']);
    expect(finishResolvedWaits()).toEqual([]);
    prRecord('MERGED', [], other);
    expect(finishResolvedWaits().map((f) => f.id)).toEqual(['d1']);
    enqueue({ id: 'w1', repo: 'r', brief: 'b' });
    claimNext('work');
    mergeEvidence('w1', 'work', { prUrl: PR });
    appendStatus('w1', 'work', 'working');
    expect(finishResolvedWaits()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('a merge finishes a paused dispatch before the same tick frees its worktree', () => {
    config('releaseOnMerge = true\n');
    parked('d1', { waitingOn: 'review', link: PR, worktree: true });
    parked('d2', { waitingOn: 'pr', followUp: 'd1' });
    const wt = path.join(home, 'worktrees', 'd1');
    expect(fs.existsSync(wt)).toBe(true);
    prRecord('MERGED', ['d1']);
    const { log } = daemonTick();
    expect(verbOf('d1')?.verb).toBe('done');
    expect(verbOf('d2')?.verb).toBe('done');
    expect(fs.existsSync(wt)).toBe(false);
    expect(readEvidence('d1', 'work').worktreeReleased).toBeTruthy();
    const finishedAt = log.findIndex((l) => l.startsWith('d1: waited on pr:o/r#7'));
    const releasedAt = log.findIndex((l) => l.startsWith('released on merge: 1 worktree(s)'));
    expect(finishedAt).toBeGreaterThanOrEqual(0);
    expect(releasedAt).toBeGreaterThan(finishedAt);
  });

  it('pausing on its own PR registers the PR watch; a link to another PR does not', () => {
    parked('d1', { waitingOn: 'review' });
    expect(registerWaitWatches('d1', 'work', verbOf('d1')!)[0]?.owner).toBe('dispatch:d1');
    expect(readWatch('pr:o/r#7')).toBeTruthy();
    parked('d2', { waitingOn: 'pr', link: 'https://github.com/o/r/pull/9' });
    expect(registerWaitWatches('d2', 'work', verbOf('d2')!)).toEqual([]);
    expect(readWatch('pr:o/r#9')).toBeUndefined();
  });
});

describe('a parked dispatch releases on whichever PR lobstah knows for it', () => {
  /** gh pr view for a PR in `state`; records every PR it was asked about. */
  const asked: string[] = [];
  const ghView = (state: 'OPEN' | 'MERGED' | 'CLOSED') => (ref: PrRef): GhPrView => {
    asked.push(ref.key);
    return {
      state,
      isDraft: false,
      headRefOid: 'a'.repeat(40),
      mergeStateStatus: state === 'OPEN' ? 'BLOCKED' : 'UNKNOWN',
      reviewDecision: '',
      statusCheckRollup: [],
      ...(state === 'MERGED' ? { mergedAt: new Date(now).toISOString() } : {}),
      ...(state === 'CLOSED' ? { closedAt: new Date(now).toISOString() } : {}),
    };
  };
  beforeEach(() => {
    asked.length = 0;
  });

  it('the link: a linked PR with no watch is observed, and its merge finishes the dispatch', () => {
    const linked = 'https://github.com/o/r/pull/8';
    parked('d1', { waitingOn: 'review', link: linked, noPr: true });
    expect(registerWaitWatches('d1', 'work', verbOf('d1')!)).toEqual([]);
    expect(observeWaitedPrs({ now, view: ghView('OPEN') })).toEqual(['pr:o/r#8']);
    expect(finishResolvedWaits()).toEqual([]);
    // Observed less than the poll interval ago: not read again.
    expect(observeWaitedPrs({ now: now + 10_000, view: ghView('MERGED') })).toEqual([]);
    expect(observeWaitedPrs({ now: now + 60_000, view: ghView('MERGED') })).toEqual(['pr:o/r#8']);
    expect(finishResolvedWaits().map((f) => f.id)).toEqual(['d1']);
    expect(verbOf('d1')).toMatchObject({ verb: 'done', note: `the PR merged: ${linked}` });
    // A linked PR that is not the dispatch's own is not stamped as its PR.
    expect(readPr('pr:o/r#8')?.dispatches).toEqual([]);
  });

  it("the catch's PR: a park without a link reads the PR its evidence names", () => {
    parked('d1', { waitingOn: 'review', noPr: true });
    mergeEvidence('d1', 'work', {
      pr: { url: PR, number: 7, state: 'OPEN', draft: false, reviewDecision: '', mergeStateStatus: 'BLOCKED', headSha: 'x', checks: { total: 0, passed: 0, failed: 0, pending: 0 }, observedAt: new Date(now).toISOString() },
    });
    expect(observeWaitedPrs({ now, view: ghView('CLOSED') })).toEqual(['pr:o/r#7']);
    expect(finishResolvedWaits()).toEqual([{ id: 'd1', lane: 'work', pr: 'pr:o/r#7', verb: 'failed' }]);
    expect(readPr('pr:o/r#7')?.dispatches).toEqual(['d1']);
  });

  it("the dispatch's pr watch: a PR known only by the watch it owns", () => {
    parked('d1', { waitingOn: 'pr', noPr: true });
    addWatch('pr:o/r#9', 'echo {}', { owner: 'dispatch:d1' });
    // The daemon's own pass observes a live dispatch-owned watch: this pass leaves it.
    expect(observeWaitedPrs({ now, view: ghView('MERGED') })).toEqual([]);
    prRecord('MERGED', [], 'https://github.com/o/r/pull/9');
    expect(finishResolvedWaits()).toEqual([{ id: 'd1', lane: 'work', pr: 'pr:o/r#9', verb: 'done' }]);
  });

  it('a helm-owned watch is observed for the parked dispatch', () => {
    parked('d1', { waitingOn: 'review', link: PR });
    addWatch('pr:o/r#7', 'echo {}', { owner: 'man' });
    expect(observeWaitedPrs({ now, view: ghView('MERGED') })).toEqual(['pr:o/r#7']);
    expect(finishResolvedWaits().map((f) => f.id)).toEqual(['d1']);
  });

  it('a gh failure is skipped; nothing parked, nothing read', () => {
    expect(observeWaitedPrs({ now, view: ghView('OPEN') })).toEqual([]);
    parked('d1', { waitingOn: 'review' });
    const fail = (): GhPrView => {
      throw new Error('gh: not authenticated');
    };
    expect(observeWaitedPrs({ now, view: fail })).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('report paused --waiting-on review warns when lobstah knows no PR for the wait', () => {
    const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
    parked('d1', { waitingOn: 'review', noPr: true });
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'report', 'd1', 'paused', ...args], { env: { ...process.env, LOBSTAH_HOME: home }, encoding: 'utf8' });
    const none = run('in review', '--waiting-on', 'review', '--link', 'https://example.com/review/1');
    expect(none.status, none.stderr).toBe(0);
    expect(none.stdout).toContain('warning: "no PR known for this wait');
    const linked = run('in review', '--waiting-on', 'review', '--link', PR);
    expect(linked.status, linked.stderr).toBe(0);
    expect(linked.stdout).not.toContain('warning');
    const person = run('asked Ana', '--waiting-on', 'person');
    expect(person.stdout).not.toContain('warning');
  });
});

describe('a dispatch with several PRs', () => {
  const PR8 = 'https://github.com/o/r/pull/8';
  const PR9 = 'https://github.com/o/r/pull/9';
  const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  const lobstah = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { cwd, env: { ...process.env, LOBSTAH_HOME: home }, encoding: 'utf8' });
  const claimed = (id: string) => {
    enqueue({ id, repo: 'r', brief: 'b' });
    expect(claimNext('work')).toBe(id);
  };

  it('report --pr is repeatable: each PR is recorded, gets its watch, and shows in catch and tend', () => {
    claimed('d1');
    const out = lobstah(root, 'report', 'd1', 'working', 'two PRs', '--pr', PR, '--pr', PR8);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/prs: "?https:\/\/github\.com\/o\/r\/pull\/7, https:\/\/github\.com\/o\/r\/pull\/8/);
    expect(readEvidence('d1', 'work')).toMatchObject({ prUrl: PR, prUrls: [PR, PR8] });
    expect(readWatch('pr:o/r#7')?.owner).toBe('dispatch:d1');
    expect(readWatch('pr:o/r#8')?.owner).toBe('dispatch:d1');
    prRecord('OPEN', ['d1']);
    expect(lobstah(root, 'status', 'd1').stdout).toMatch(/prs: "?https:\/\/github\.com\/o\/r\/pull\/7, https:\/\/github\.com\/o\/r\/pull\/8/);
    const caught = lobstah(root, 'catch', 'd1');
    expect(caught.stdout).toMatch(/prs: "?.*pull\/7; .*pull\/8/);
    const story = buildTendReport().stories.find((st) => st.dispatches.some((d) => d.id === 'd1'));
    expect(story?.prs).toEqual([expect.stringContaining(PR), PR8]);
    expect(renderTend(buildTendReport())).toContain(PR8);
  });

  it('a reported PR in a gh stack records every PR of the stack', () => {
    claimed('d1');
    const state = { schemaVersion: 1, stacks: [{ branches: [7, 8, 9].map((n) => ({ branch: `b${n}`, pullRequest: { number: n, url: `https://github.com/o/r/pull/${n}` } })) }] };
    fs.writeFileSync(path.join(repo, '.git', 'gh-stack'), JSON.stringify(state));
    const out = lobstah(repo, 'report', 'd1', 'done', 'stack sent', '--pr', PR9);
    expect(out.status, out.stderr).toBe(0);
    expect(readEvidence('d1', 'work')).toMatchObject({ prUrl: PR9, prUrls: [PR9, PR, PR8] });
    for (const n of [7, 8, 9]) expect(readWatch(`pr:o/r#${n}`)?.owner).toBe('dispatch:d1');
  });

  it('a parked dispatch finishes only when all its PRs have ended', () => {
    parked('d1', { waitingOn: 'review', link: PR });
    mergeEvidence('d1', 'work', { prUrls: [PR, PR8] });
    expect(registerWaitWatches('d1', 'work', verbOf('d1')!).map((w) => w.key)).toEqual(['pr:o/r#7', 'pr:o/r#8']);
    prRecord('MERGED', ['d1']);
    prRecord('OPEN', ['d1'], PR8);
    expect(finishResolvedWaits()).toEqual([]);
    expect(verbOf('d1')?.verb).toBe('paused');
    prRecord('CLOSED', ['d1'], PR8);
    expect(finishResolvedWaits()).toEqual([{ id: 'd1', lane: 'work', pr: 'pr:o/r#7, pr:o/r#8', verb: 'done' }]);
    expect(verbOf('d1')?.note).toBe(`the PRs ended — merged: ${PR}; closed without merge: ${PR8}`);
  });

  it('all merged: done; all closed: failed', () => {
    parked('d1', { waitingOn: 'pr' });
    mergeEvidence('d1', 'work', { prUrls: [PR, PR8] });
    parked('d2', { waitingOn: 'pr', noPr: true });
    mergeEvidence('d2', 'work', { prUrl: PR9, prUrls: [PR9, 'https://github.com/o/r/pull/10'] });
    prRecord('MERGED', ['d1']);
    prRecord('MERGED', ['d1'], PR8);
    prRecord('CLOSED', ['d2'], PR9);
    prRecord('CLOSED', ['d2'], 'https://github.com/o/r/pull/10');
    expect(finishResolvedWaits().map((f) => [f.id, f.verb])).toEqual([
      ['d1', 'done'],
      ['d2', 'failed'],
    ]);
    expect(verbOf('d1')?.note).toBe(`the PRs merged: ${PR}, ${PR8}`);
  });

  it.skipIf(process.platform === 'win32')('a merged PR does not release the worktree while another PR of the dispatch is open', () => {
    config('releaseOnMerge = true\n');
    parked('d1', { waitingOn: 'review', worktree: true });
    mergeEvidence('d1', 'work', { prUrls: [PR, PR8] });
    const wt = path.join(home, 'worktrees', 'd1');
    prRecord('MERGED', ['d1']);
    prRecord('OPEN', ['d1'], PR8);
    daemonTick();
    expect(verbOf('d1')?.verb).toBe('paused');
    expect(fs.existsSync(wt)).toBe(true);
    prRecord('MERGED', ['d1'], PR8);
    now += 3_600_000;
    daemonTick();
    expect(verbOf('d1')?.verb).toBe('done');
    expect(fs.existsSync(wt)).toBe(false);
  });
});

describe('a parked dispatch holds no slot', () => {
  it('a legacy review-paused rebase frees the single chore slot and finishes after merge', () => {
    config('choreConcurrent = 1\n');
    parked('rebase', { lane: 'chore', waitingOn: 'review', link: PR });
    prRecord('OPEN', ['rebase']);
    enqueue({ id: 'next-chore', repo: 'r', brief: 'next' }, 'chore');
    expect(slotUsage('chore')).toEqual({ headless: 0, traps: 0, parked: 1 });
    expect(daemonTick().spawned.map((s) => s.id)).toEqual(['next-chore']);
    expect(slotUsage('chore')).toEqual({ headless: 1, traps: 0, parked: 1 });
    expect(verbOf('rebase', 'chore')?.verb).toBe('paused');
    prRecord('MERGED', ['rebase']);
    daemonTick();
    expect(verbOf('rebase', 'chore')).toMatchObject({ verb: 'done', note: `the PR merged: ${PR}` });
    expect(fs.existsSync(path.join(laneDirs('chore').done, 'rebase'))).toBe(true);
    expect(slotUsage('chore')).toEqual({ headless: 1, traps: 0, parked: 0 });
  });

  it('does not count against maxConcurrent: queued work is claimed beside it', () => {
    parked('p1', { waitingOn: 'review' });
    enqueue({ id: 'q1', repo: 'r', brief: 'next' });
    expect(slotUsage('work')).toEqual({ headless: 0, traps: 0, parked: 1 });
    const { spawned } = daemonTick();
    expect(spawned.map((s) => s.id)).toEqual(['q1']);
    expect(slotUsage('work')).toEqual({ headless: 1, traps: 0, parked: 1 });
  });

  it('an operator message wakes it into the same session when a slot is free, before new work', () => {
    parked('p1', { waitingOn: 'person' });
    enqueue({ id: 'q1', repo: 'r', brief: 'next' });
    sendMessage('p1', 'work', 'approved, go on');
    const { spawned } = daemonTick();
    expect(spawned).toEqual([{ id: 'p1', attempts: 1, resume: 'session-p1', wake: '1 operator message(s) arrived' }]);
    // The woken runner holds the slot before it reports: the queued work waits.
    expect(slotUsage('work')).toMatchObject({ headless: 1, parked: 0 });
    expect(daemonTick().spawned).toEqual([]);
  });

  it('lobstah send delivers to a parked dispatch\'s inbox, not a new follow-up', () => {
    parked('p1', { waitingOn: 'review' });
    const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
    const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
    delete env.CLAUDE_CODE_SESSION_ID;
    const res = spawnSync(process.execPath, [cli, 'send', 'p1', 'approved'], { encoding: 'utf8', env, timeout: 30_000 });
    expect(res.stdout).toContain('delivered: inbox of p1');
    expect(unhandled('p1', 'work')).toHaveLength(1);
    expect(fs.readdirSync(laneDirs('work').queue).filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('a woken runner that dies before it reports restarts with its session', () => {
    parked('p1', { waitingOn: 'review' });
    sendMessage('p1', 'work', 'go');
    expect(daemonTick().spawned.map((s) => s.id)).toEqual(['p1']);
    // The woken runner died before its first report.
    fs.writeFileSync(
      path.join(laneDirs('work').active, 'p1', 'runner.json'),
      JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString(), attempts: 1 }),
    );
    expect(daemonTick().spawned).toEqual([expect.objectContaining({ id: 'p1', attempts: 2, resume: 'session-p1' })]);
  });

  it('waits for a slot to wake', () => {
    enqueue({ id: 'busy', repo: 'r', brief: 'b' });
    claimNext('work');
    fs.writeFileSync(path.join(laneDirs('work').active, 'busy', 'runner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), attempts: 1 }));
    appendStatus('busy', 'work', 'working');
    parked('p1', { waitingOn: 'review' });
    sendMessage('p1', 'work', 'go');
    expect(daemonTick().spawned).toEqual([]);
    appendStatus('busy', 'work', 'done', 'finished');
    expect(daemonTick().spawned.map((s) => s.id)).toEqual(['p1']);
  });

  it('the end of --until wakes it; a cancel finalizes it without a runner', () => {
    parked('p1', { waitingOn: 'deploy', until: new Date(now + 60_000).toISOString() });
    expect(daemonTick().spawned).toEqual([]);
    now += 120_000;
    expect(daemonTick().spawned).toEqual([expect.objectContaining({ id: 'p1', wake: 'the pause reached its --until time' })]);
    parked('p2', { waitingOn: 'review' });
    requestCancel('p2', 'work');
    daemonTick();
    expect(verbOf('p2')).toMatchObject({ verb: 'failed' });
    expect(fs.existsSync(path.join(laneDirs('work').done, 'p2'))).toBe(true);
  });

  it('status output during a review wait shows the parked dispatch and real capacity', async () => {
    parked('p1', { waitingOn: 'review', link: PR });
    fs.writeFileSync(path.join(home, 'executor.json'), JSON.stringify({ heartbeat: new Date().toISOString(), pid: process.pid, version: 't' }));
    const tend = buildTendReport();
    expect(tend.counts).toMatchObject({ headlessActive: 0, headlessLimit: 1, parked: 1 });
    expect(tend.parked).toEqual([expect.objectContaining({ id: 'p1', trap: false, waiting: expect.objectContaining({ on: 'review', link: PR }) })]);
    const text = renderTend(tend);
    expect(text).toContain('headless: 0 of 1; traps: 0; parked: 1 (no slot)');
    expect(text).toContain('parked (no slot)');
    const status = daemonStatus(true);
    expect(status).toMatchObject({ headless: 0, parked: 1, slots: '0 of 1 work in use, 0 of 1 chore in use' });
    expect(String(status.parkedOn)).toMatch(/^p1 waiting on review for .+ https:\/\/github\.com\/o\/r\/pull\/7$/);
    const daemonRow = (await runDoctor()).find((r) => r.check === 'daemon');
    expect(daemonRow?.detail).toContain('headless: 0 of 1 work');
    expect(daemonRow?.detail).toContain('parked: 1, no slot (p1 waiting on review for');
  });
});

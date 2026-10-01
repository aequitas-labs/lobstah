import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  addWatch,
  appendStatus,
  beatTrap,
  cancelQueued,
  ensureLayout,
  gitPushTargets,
  laneDirs,
  listNotices,
  mergeEvidence,
  readEvidence,
  readPr,
  readWatch,
  recordPush,
  releaseHeldWatches,
  resetRepairStreaks,
  sendMessage,
  sendTrapMessage,
  soakingDir,
  upsertPr,
} from '@lobstah/core';
import type { Descriptor, PrEvidence, PrRecord } from '@lobstah/core';
import { pumpClaudeMessage } from '../../../packages/adapters/src/claude.js';
import { deliverPrRepairs, holdCancelledRepair, stampRepairerBeat } from '../src/pr-repair.js';
import type { LatestChecks } from '../src/pr-repair.js';
import { buildTendReport, renderTend } from '../src/tend.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const T0 = Date.parse('2026-09-29T14:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const sha = (c: string) => c.repeat(40);
const uuid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(12)}`;

interface Pr {
  n: number;
  base: string;
  head: string;
  sha: string;
  owner: string;
}
/** A stack of three: #1 on main, #2 on #1's branch, #3 on #2's branch. */
const STACK: Pr[] = [
  { n: 1, base: 'main', head: 'b1', sha: sha('1'), owner: uuid('1') },
  { n: 2, base: 'b1', head: 'b2', sha: sha('2'), owner: uuid('2') },
  { n: 3, base: 'b2', head: 'b3', sha: sha('3'), owner: uuid('3') },
];
const key = (n: number) => `pr:acme/web#${n}`;

let dir: string;

function observed(p: Pr, over: Partial<PrEvidence> = {}): PrEvidence {
  return {
    url: `https://github.com/acme/web/pull/${p.n}`,
    number: p.n,
    state: 'OPEN',
    draft: false,
    reviewDecision: '',
    mergeStateStatus: 'DIRTY',
    headSha: p.sha,
    baseRefName: p.base,
    baseSha: sha('b'),
    headRefName: p.head,
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    observedAt: iso(T0),
    ...over,
  };
}

function doneDispatch(id: string, commits: string[]): void {
  const done = path.join(laneDirs('work').done, id);
  fs.mkdirSync(done, { recursive: true });
  fs.writeFileSync(path.join(done, 'descriptor.json'), JSON.stringify({ id, repo: 'web', brief: 'make PR' } satisfies Descriptor));
  appendStatus(id, 'work', 'done', 'PR sent');
  mergeEvidence(id, 'work', { commits });
}

function activeDispatch(id: string, evidence: Parameters<typeof mergeEvidence>[2] = {}): void {
  const active = path.join(laneDirs('work').active, id);
  fs.mkdirSync(active, { recursive: true });
  fs.writeFileSync(path.join(active, 'descriptor.json'), JSON.stringify({ id, repo: 'web', brief: 'work' } satisfies Descriptor));
  appendStatus(id, 'work', 'working', 'on it');
  mergeEvidence(id, 'work', evidence);
}

/** Register the PR's owner and watch, and observe it twice (the first is a baseline). */
function stand(p: Pr, over: Partial<PrEvidence> = {}): void {
  doneDispatch(p.owner, [p.sha, sha('9')]);
  addWatch(key(p.n), 'echo {}', { owner: `dispatch:${p.owner}` });
  upsertPr(observed(p, { ...over, observedAt: iso(T0 - 3_600_000) }), p.owner);
  upsertPr(observed(p, over), p.owner);
}

/** Register the PR's owner and watch; its head is first seen at T0. */
function standFresh(p: Pr): void {
  doneDispatch(p.owner, [p.sha]);
  addWatch(key(p.n), 'echo {}', { owner: `dispatch:${p.owner}` });
  upsertPr(observed(p), p.owner);
  upsertPr(observed(p, { observedAt: iso(T0 + 1_000) }), p.owner);
}

/** A checkout made of files: `.git/HEAD` names the branch. */
function checkout(name: string, branch: string): string {
  const wt = path.join(dir, name);
  fs.mkdirSync(path.join(wt, '.git'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  return wt;
}

function trap(trapId: string, name: string, worktree: string, claimed: string): void {
  activeDispatch(claimed);
  fs.writeFileSync(
    path.join(laneDirs('work').active, claimed, 'claim.json'),
    JSON.stringify({ by: `wt:${trapId}`, sessionId: 's1', harness: 'claude', worktree, at: iso(T0) }),
  );
  fs.mkdirSync(soakingDir(), { recursive: true });
  fs.writeFileSync(
    path.join(soakingDir(), `${trapId}.json`),
    JSON.stringify({ trapId, name, worktree, cwd: worktree, harness: 'claude', sessionId: 's1', signedOnAt: iso(T0), heartbeatAt: new Date().toISOString(), claimed }),
  );
}

function queued(): Descriptor[] {
  return fs
    .readdirSync(laneDirs('chore').queue)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(laneDirs('chore').queue, f), 'utf8')) as Descriptor);
}

const later = T0 + 3_600_000;
const repair = (cap = 3, opts: Parameters<typeof deliverPrRepairs>[2] = {}) => deliverPrRepairs(() => {}, cap, { now: later, ...opts });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-pr-holds-'));
  process.env.LOBSTAH_HOME = dir;
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(dir);
});

describe('the repair circuit breaker', () => {
  const P = STACK[0]!;
  /** The last queued repair finishes done at `head`, and the PR is seen still conflicting there. */
  const repairedAt = (head: string, at: number) => {
    const id = readPr(key(1))!.repair!.dispatchId!;
    mergeEvidence(id, 'chore', { commits: [`${head.slice(0, 7)} resolve conflicts`] });
    appendStatus(id, 'chore', 'done', 'repaired');
    upsertPr(observed(P, { headSha: head, observedAt: iso(at) }), P.owner);
    upsertPr(observed(P, { headSha: head, observedAt: iso(at + 1000) }), P.owner);
    return id;
  };
  const step = 7_200_000;

  it('stops after [watch].maxRepairsWithoutProgress repairs that left the PR conflicting, with attention and a notice', () => {
    stand(P);
    expect(repair()).toBe(1);
    repairedAt(sha('4'), T0 + 100_000);
    expect(repair(3, { now: later + step })).toBe(1);
    expect(readPr(key(1))?.repairStreak?.count).toBe(1);
    repairedAt(sha('5'), T0 + step + 100_000);
    expect(repair(3, { now: later + 2 * step })).toBe(0);
    expect(queued()).toHaveLength(2);
    const rec = readPr(key(1))!;
    expect(rec.repair).toMatchObject({ status: 'gave-up', kind: 'conflict' });
    expect(rec.repair?.reason).toContain('no merge progress after 2 repair(s) in a row ([watch].maxRepairsWithoutProgress = 2)');
    expect(listNotices(50).filter((n) => n.kind === 'repair-stopped')).toHaveLength(1);
    const tend = buildTendReport();
    expect(tend.attention.find((a) => a.kind === 'pr:conflict' && a.key === key(1))?.note ?? JSON.stringify(tend.attention)).toContain('no merge progress');
    // It stays stopped on the next pass.
    expect(repair(3, { now: later + 2 * step + 60_000 })).toBe(0);
  });

  it('[watch].maxRepairsWithoutProgress sets the cap', () => {
    fs.writeFileSync(path.join(dir, 'config.toml'), '[watch]\nmaxRepairsWithoutProgress = 1\n');
    stand(P);
    expect(repair()).toBe(1);
    repairedAt(sha('4'), T0 + 100_000);
    expect(repair(3, { now: later + step })).toBe(0);
    expect(readPr(key(1))?.repair?.status).toBe('gave-up');
  });

  it('a push that is not the repair\'s resets the run; so does watch release after a stop', () => {
    stand(P);
    expect(repair()).toBe(1);
    const id = readPr(key(1))!.repair!.dispatchId!;
    mergeEvidence(id, 'chore', { commits: [`${sha('4').slice(0, 7)} resolve conflicts`] });
    appendStatus(id, 'chore', 'done', 'repaired');
    // Another push after the repair (here the owner's): the head is not the repair's.
    mergeEvidence(P.owner, 'work', { commits: [sha('6')] });
    upsertPr(observed(P, { headSha: sha('6'), observedAt: iso(T0 + 100_000) }), P.owner);
    upsertPr(observed(P, { headSha: sha('6'), observedAt: iso(T0 + 101_000) }), P.owner);
    expect(repair(3, { now: later + step })).toBe(1);
    expect(readPr(key(1))?.repairStreak?.count).toBe(0);

    // Two repairs without progress stop it; a release lets it repair again.
    repairedAt(sha('7'), T0 + step + 100_000);
    expect(repair(3, { now: later + 2 * step })).toBe(1);
    repairedAt(sha('8'), T0 + 2 * step + 100_000);
    expect(repair(3, { now: later + 3 * step })).toBe(0);
    expect(readPr(key(1))?.repair?.status).toBe('gave-up');
    const out = spawnSync(process.execPath, [cli, 'watch', 'release', key(1)], { env: { ...process.env, LOBSTAH_HOME: dir }, encoding: 'utf8' });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain(`repairsResumed: ${key(1)}`);
    expect(readPr(key(1))?.repairStreak).toBeUndefined();
    expect(resetRepairStreaks(key(1))).toEqual([]);
    expect(repair(3, { now: later + 3 * step + 60_000 })).toBe(1);
  });

  it('a merge or close ends the run', () => {
    fs.writeFileSync(path.join(dir, 'config.toml'), '[watch]\nmaxRepairsWithoutProgress = 1\n');
    stand(P);
    expect(repair()).toBe(1);
    repairedAt(sha('4'), T0 + 100_000);
    expect(repair(3, { now: later + step })).toBe(0);
    expect(readPr(key(1))?.repairStreak).toBeDefined();
    upsertPr(observed(P, { headSha: sha('4'), state: 'MERGED', observedAt: iso(T0 + step + 200_000) }), P.owner);
    expect(readPr(key(1))?.repairStreak).toBeUndefined();
  });

  it('a conflict repair never starts within the settle time of an approval', () => {
    stand(P, { review: { changesRequested: false, lastApprovalAt: iso(later - 8_000) } });
    expect(repair()).toBe(0);
    expect(readPr(key(1))?.repair).toMatchObject({ status: 'waiting', heldBy: 'settle' });
    expect(readPr(key(1))?.repair?.reason).toContain('the PR was approved at');
    expect(repair(3, { now: later + 600_000 })).toBe(1);
  });
});

describe('repairing the bottom of a stack updates the PRs above it', () => {
  const [bottom, top] = [STACK[0]!, STACK[1]!];
  const trunk = () => fs.writeFileSync(path.join(dir, 'config.toml'), '[repos.web]\npath = "/w"\ntrunk = "main"\n');

  it('a two-PR stack whose bottom gets a merge repair: the brief merges the base into the top too, never force-pushing', () => {
    trunk();
    stand(bottom);
    stand(top, { mergeStateStatus: 'BEHIND' });
    expect(repair()).toBe(1);
    const brief = queued()[0]!.brief;
    expect(brief).toContain('Fetch origin/main and merge it into b1 with a merge commit');
    expect(brief).toContain('Push only to the existing branch b1 and the branches of the PRs stacked on it named below.');
    expect(brief).toContain('PRs are stacked on this PR: #2 (https://github.com/acme/web/pull/2, branch b2 on b1).');
    expect(brief).toContain('merge its updated base into it with a merge commit (`git merge origin/<its base>`), and push with a normal push. Never force-push.');
    expect(brief).not.toContain('--force-with-lease');
    expect(brief).toContain('lobstah repairs a conflicting PR as its own repair');
  });

  it('a stacked bottom repaired by rebase: the PRs above rebase with a lease', () => {
    stand(top);
    stand(STACK[2]!, { mergeStateStatus: 'BEHIND' });
    expect(repair()).toBe(1);
    const brief = queued()[0]!.brief;
    expect(brief).toContain('PRs are stacked on this PR: #3 (');
    expect(brief).toContain('git rebase --onto origin/<its base>');
    expect(brief).toContain('--force-with-lease=<its branch>:<its head you started from>');
  });

  it('a conflict in the top PR becomes that PR\'s own repair, after the bottom\'s', () => {
    trunk();
    stand(bottom);
    stand(top);
    expect(repair()).toBe(1);
    const bottomRepair = readPr(key(1))!.repair!.dispatchId!;
    expect(readPr(key(2))?.repair).toMatchObject({ status: 'waiting', heldBy: 'stack' });
    // The bottom's repair finished; the top still conflicts with its updated base.
    appendStatus(bottomRepair, 'chore', 'done', 'merged main; #2 conflicts, left for its own repair');
    expect(repair(3, { now: later + 600_000 })).toBe(1);
    const topRepair = queued().find((d) => d.followUp === top.owner)!;
    expect(topRepair.pr?.url).toBe('https://github.com/acme/web/pull/2');
    expect(readPr(key(2))?.repair).toMatchObject({ status: 'repairing', kind: 'conflict' });
    // #2 is stacked on b1: its own repair rebases onto it.
    expect(topRepair.brief).toContain('This PR is stacked on its base branch b1.');
  });
});

describe('brief hooks', () => {
  it("a conflict repair's brief ends with the repo's conflict hook, then its all hook", () => {
    fs.writeFileSync(path.join(dir, 'config.toml'), '[repos.web]\npath = "/w"\n[repos.web.briefHooks]\nconflict = "Run the conflict refresh."\nall = "Run /pr-refresh."\nchecks = "not this one"\n');
    stand(STACK[0]!);
    expect(repair()).toBe(1);
    const [chore] = queued();
    expect(chore!.brief.endsWith('\n\nRun the conflict refresh.\n\nRun /pr-refresh.')).toBe(true);
    expect(chore!.brief).not.toContain('not this one');
  });
});

describe('a live worker holds the branch', () => {
  it('a trap with a claimed dispatch has the head branch checked out: no repair, and the record says who holds it', () => {
    stand(STACK[0]!);
    trap('t1', 'brave-otter', checkout('wt-trap', 'b1'), uuid('a'));
    expect(repair()).toBe(0);
    expect(queued()).toHaveLength(0);
    expect(readPr(key(1))?.repair).toMatchObject({ status: 'waiting', heldBy: 'wt:brave-otter', attempts: 0 });
    expect(readPr(key(1))?.repair?.reason).toContain('has b1 checked out');
  });

  it('a worker whose branch tracks the head branch holds it; one in another forge repo does not', () => {
    stand(STACK[0]!);
    const repo = (name: string, origin: string): string => {
      const wt = path.join(dir, name);
      fs.mkdirSync(wt);
      const git = (...args: string[]) => {
        const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: wt, encoding: 'utf8' });
        expect(res.status, res.stderr).toBe(0);
      };
      git('init', '-q');
      git('checkout', '-q', '-b', 'local-work');
      git('commit', '-q', '--allow-empty', '-m', 'start');
      git('remote', 'add', 'origin', origin);
      git('update-ref', 'refs/remotes/origin/b1', 'HEAD');
      git('branch', '-q', '--set-upstream-to=origin/b1');
      return wt;
    };
    trap('t3', 'quiet-crab', repo('wt-other', 'https://github.com/other/web.git'), uuid('7'));
    expect(repair()).toBe(1);
    appendStatus(readPr(key(1))!.repair!.dispatchId!, 'chore', 'done', 'repaired');
    upsertPr(observed(STACK[0]!, { observedAt: iso(T0) }), STACK[0]!.owner);
    trap('t4', 'slow-gull', repo('wt-same', 'git@github.com:acme/web.git'), uuid('8'));
    expect(repair()).toBe(0);
    expect(readPr(key(1))?.repair).toMatchObject({ status: 'waiting', heldBy: 'wt:slow-gull', attempts: 1 });
    expect(readPr(key(1))?.repair?.reason).toContain('tracks origin/b1');
  });

  it('a signed-on trap between catches still holds the branch its worktree has checked out', () => {
    stand(STACK[0]!);
    trap('t1', 'brave-otter', checkout('wt-trap', 'b1'), uuid('a'));
    appendStatus(uuid('a'), 'work', 'done', 'finished');
    expect(repair()).toBe(0);
    expect(readPr(key(1))?.repair).toMatchObject({ status: 'waiting', heldBy: 'wt:brave-otter' });
    expect(readPr(key(1))?.repair?.reason).toBe('wt:brave-otter has b1 checked out');
  });

  it('a signed-on trap between catches on another branch holds nothing', () => {
    stand(STACK[0]!);
    trap('t1', 'brave-otter', checkout('wt-trap', 'lobstah/soak-t1'), uuid('a'));
    appendStatus(uuid('a'), 'work', 'done', 'finished');
    expect(repair()).toBe(1);
  });
  it('a live dispatch holds the base PR of a stack of three: no repair for the two PRs above it', () => {
    for (const p of STACK) stand(p);
    activeDispatch(uuid('b'));
    recordPush(uuid('b'), 'work', ['b1'], iso(T0));
    expect(repair()).toBe(0);
    expect(queued()).toHaveLength(0);
    for (const n of [2, 3]) {
      expect(readPr(key(n))?.repair).toMatchObject({ status: 'waiting', heldBy: 'dispatch:bbbbbbbb' });
      expect(readPr(key(n))?.repair?.reason).toContain('pushed b1');
      expect(readPr(key(n))?.repair?.reason).toContain('#1 is below this PR');
    }
    expect(readPr(key(1))?.repair?.status).toBe('waiting');
  });

  it('the same stack with no live worker: the bottom is repaired, and the PRs above wait for it (it updates them)', () => {
    for (const p of STACK) stand(p);
    expect(repair()).toBe(1);
    expect(queued().map((d) => d.followUp)).toEqual([STACK[0]!.owner]);
    expect(queued()[0]!.brief).toMatch(/PRs are stacked on this PR: #2 \(.*\), #3 \(/);
    for (const n of [2, 3]) {
      expect(readPr(key(n))?.repair).toMatchObject({ status: 'waiting', heldBy: 'stack' });
      expect(readPr(key(n))?.repair?.reason).toContain('a repair of #');
    }
  });

  it('a worker on a PR above does not hold the PR below it', () => {
    for (const p of STACK) stand(p);
    activeDispatch(uuid('c'), { prUrl: 'https://github.com/acme/web/pull/3' });
    expect(repair()).toBe(1);
    expect(readPr(key(1))?.repair?.status).toBe('repairing');
    // The bottom's repair updates #2 and stops below #3, which the worker holds.
    const brief = queued()[0]!.brief;
    expect(brief).toContain('PRs are stacked on this PR: #2 (');
    expect(brief).not.toContain('#3 (');
    expect(readPr(key(2))?.repair).toMatchObject({ status: 'waiting', heldBy: 'stack' });
    expect(readPr(key(3))?.repair).toMatchObject({ status: 'waiting', heldBy: 'dispatch:cccccccc' });
    expect(readPr(key(3))?.repair?.reason).toContain('works on this PR');
  });

  it('after the hold ends, the repair is queued', () => {
    stand(STACK[0]!);
    activeDispatch(uuid('d'));
    recordPush(uuid('d'), 'work', ['b1'], iso(T0));
    expect(repair()).toBe(0);
    appendStatus(uuid('d'), 'work', 'done', 'pushed');
    expect(repair()).toBe(1);
    expect(readPr(key(1))?.repair).toMatchObject({ status: 'repairing', attempts: 1 });
  });
});

describe('a trap told to work on the PR holds it', () => {
  it("its current dispatch's inbox names the PR: no repair", () => {
    stand(STACK[0]!);
    trap('t1', 'crisp-crab', checkout('wt-trap', 'lobstah/soak-t1'), uuid('a'));
    sendMessage(uuid('a'), 'work', 'Also rebase https://github.com/acme/web/pull/1 onto main.', 'helm');
    expect(repair()).toBe(0);
    expect(readPr(key(1))?.repair).toMatchObject({ status: 'waiting', heldBy: 'wt:crisp-crab' });
    expect(readPr(key(1))?.repair?.reason).toContain('was told to work on this PR');
  });

  it("its current dispatch's brief names the PR as owner/repo#n: no repair; another PR's number does not count", () => {
    stand(STACK[0]!);
    trap('t1', 'crisp-crab', checkout('wt-trap', 'lobstah/soak-t1'), uuid('a'));
    const file = path.join(laneDirs('work').active, uuid('a'), 'descriptor.json');
    fs.writeFileSync(file, JSON.stringify({ id: uuid('a'), repo: 'web', brief: 'Rebase acme/web#11 onto main.' } satisfies Descriptor));
    expect(repair()).toBe(1);
    appendStatus(readPr(key(1))!.repair!.dispatchId!, 'chore', 'done', 'repaired');
    upsertPr(observed(STACK[0]!, { observedAt: iso(T0) }), STACK[0]!.owner);
    fs.writeFileSync(file, JSON.stringify({ id: uuid('a'), repo: 'web', brief: 'Rebase acme/web#1 onto main.' } satisfies Descriptor));
    expect(repair()).toBe(0);
    expect(readPr(key(1))?.repair?.heldBy).toBe('wt:crisp-crab');
  });

  it('a message sent to the trap itself in the last day names the PR, between catches too; an older one does not', () => {
    stand(STACK[0]!);
    trap('t1', 'crisp-crab', checkout('wt-trap', 'lobstah/soak-t1'), uuid('a'));
    appendStatus(uuid('a'), 'work', 'done', 'finished');
    sendMessage('trap-t1', 'work', JSON.stringify({ from: 'helm', at: iso(Date.now() - 2 * 86_400_000), text: 'rebase acme/web#1' }), 'helm');
    expect(repair()).toBe(1);
    appendStatus(readPr(key(1))!.repair!.dispatchId!, 'chore', 'done', 'repaired');
    upsertPr(observed(STACK[0]!, { observedAt: iso(T0) }), STACK[0]!.owner);
    sendTrapMessage('t1', 'helm', 'Please rebase https://github.com/acme/web/pull/1 now.');
    expect(repair()).toBe(0);
    expect(readPr(key(1))?.repair).toMatchObject({ status: 'waiting', heldBy: 'wt:crisp-crab', reason: 'wt:crisp-crab was told to work on this PR' });
  });
});

describe('the settle time', () => {
  it('the head moved 60 seconds ago: no repair; after the settle time with no change: repair', () => {
    const p = STACK[0]!;
    doneDispatch(p.owner, [p.sha, sha('4')]);
    addWatch(key(1), 'echo {}', { owner: `dispatch:${p.owner}` });
    upsertPr(observed(p, { headSha: sha('4'), observedAt: iso(T0 - 3_600_000) }), p.owner);
    upsertPr(observed(p, { observedAt: iso(T0 - 60_000) }), p.owner);
    upsertPr(observed(p, { observedAt: iso(T0) }), p.owner);
    expect(readPr(key(1))?.headSince).toBe(iso(T0 - 60_000));
    expect(deliverPrRepairs(() => {}, 3, { now: T0 })).toBe(0);
    expect(readPr(key(1))?.repair).toMatchObject({ status: 'waiting', heldBy: 'settle', until: iso(T0 - 60_000 + 600_000) });
    expect(deliverPrRepairs(() => {}, 3, { now: T0 + 540_001 })).toBe(1);
  });

  it('a base head that moved restarts the settle time', () => {
    const p = STACK[1]!;
    stand(p);
    upsertPr(observed(p, { baseSha: sha('c'), observedAt: iso(later - 30_000) }), p.owner);
    expect(repair()).toBe(0);
    expect(readPr(key(2))?.repair?.until).toBe(iso(later - 30_000 + 600_000));
  });

  it('[watch].repairSettleSecs sets the settle time', () => {
    fs.writeFileSync(path.join(dir, 'config.toml'), '[watch]\nrepairSettleSecs = 30\n');
    standFresh(STACK[0]!);
    expect(deliverPrRepairs(() => {}, 3, { now: T0 + 10_000 })).toBe(0);
    expect(deliverPrRepairs(() => {}, 3, { now: T0 + 31_000 })).toBe(1);
  });
});

describe('a checks repair looks again', () => {
  const failing = { mergeStateStatus: 'BLOCKED', checks: { total: 1, passed: 0, failed: 1, pending: 0 }, failingChecks: [{ name: 'test' }] };
  const latest = (outcome: 'failed' | 'passed' | 'pending') => (p: PrRecord): LatestChecks => ({ headSha: p.headSha, checks: [{ name: 'test', outcome }] });

  it('the latest run is in progress: no repair', () => {
    stand(STACK[0]!, failing);
    expect(repair(3, { readChecks: latest('pending') })).toBe(0);
    expect(readPr(key(1))?.repair).toMatchObject({ status: 'waiting', heldBy: 'checks', reason: 'the latest run of test is in progress' });
  });

  it('the latest run passes: no repair', () => {
    stand(STACK[0]!, failing);
    expect(repair(3, { readChecks: latest('passed') })).toBe(0);
    expect(readPr(key(1))?.repair).toMatchObject({ status: 'waiting', reason: 'the latest run of test passed' });
  });

  it('the latest run still fails: repair', () => {
    stand(STACK[0]!, failing);
    expect(repair(3, { readChecks: latest('failed') })).toBe(1);
    expect(readPr(key(1))?.repair).toMatchObject({ status: 'repairing', kind: 'checks', attempts: 1 });
  });
});

describe('holds on the watch', () => {
  it('the helm cancels a repair: no second repair for the same PR until watch release', () => {
    stand(STACK[0]!);
    expect(repair()).toBe(1);
    const first = readPr(key(1))!.repair!.dispatchId!;
    expect(holdCancelledRepair(first)).toEqual([key(1)]);
    expect(cancelQueued(first, 'chore')).toBe(true);
    upsertPr(observed(STACK[0]!, { observedAt: iso(later) }), STACK[0]!.owner);
    expect(repair()).toBe(0);
    expect(readPr(key(1))?.repair).toMatchObject({ status: 'waiting', heldBy: 'helm', attempts: 1 });
    expect(readPr(key(1))?.repair?.reason).toContain(`the helm cancelled repair ${first.slice(0, 8)}`);
    expect(repair()).toBe(0);
    releaseHeldWatches(key(1));
    expect(repair()).toBe(1);
    expect(readPr(key(1))?.repair).toMatchObject({ status: 'repairing', attempts: 2 });
  });

  it('watch hold --for holds, and the hold ends when the dispatch ends', () => {
    stand(STACK[0]!);
    const holder = uuid('e');
    activeDispatch(holder);
    const out = spawnSync(process.execPath, [cli, 'watch', 'hold', 'acme/web#1', '--for', holder], {
      env: { ...process.env, LOBSTAH_HOME: dir },
      encoding: 'utf8',
    });
    expect(out.status).toBe(0);
    expect(readWatch(key(1))).toMatchObject({ heldFor: holder, heldReason: 'held for dispatch eeeeeeee', heldBy: 'dispatch:eeeeeeee' });
    const removedReason = spawnSync(process.execPath, [cli, 'watch', 'hold', 'acme/web#1', '--reason', 'custom'], {
      env: { ...process.env, LOBSTAH_HOME: dir }, encoding: 'utf8',
    });
    expect(removedReason.status).toBe(2);
    expect(removedReason.stdout).toContain('unknown flag --reason');
    expect(repair()).toBe(0);
    expect(readPr(key(1))?.repair).toMatchObject({ status: 'waiting', heldBy: 'dispatch:eeeeeeee' });
    appendStatus(holder, 'work', 'done', 'finished');
    expect(repair()).toBe(1);
    expect(readWatch(key(1))?.heldAt).toBeUndefined();
  });

  it('a wait does not raise the attempt count', () => {
    fs.writeFileSync(path.join(dir, 'config.toml'), '[watch]\nmaxRepairsPerPr = 1\n');
    standFresh(STACK[0]!);
    for (const at of [T0 + 1_000, T0 + 2_000, T0 + 3_000]) expect(deliverPrRepairs(() => {}, 3, { now: at })).toBe(0);
    expect(readPr(key(1))?.repair).toMatchObject({ status: 'waiting', attempts: 0 });
    expect(repair()).toBe(1);
    expect(readPr(key(1))?.repair).toMatchObject({ status: 'repairing', attempts: 1, maxAttempts: 1 });
  });

  it('man tend shows a waiting repair and raises no attention item for it', () => {
    stand(STACK[0]!);
    trap('t1', 'brave-otter', checkout('wt-trap', 'b1'), uuid('a'));
    stampRepairerBeat();
    repair();
    const report = buildTendReport();
    expect(report.repairsWaiting).toEqual([expect.objectContaining({ key: key(1), kind: 'conflict', heldBy: 'wt:brave-otter' })]);
    expect(renderTend(report)).toContain('repairs waiting');
    expect(report.attention.some((a) => a.kind === 'pr:conflict')).toBe(false);
  });
});

describe('pushes lobstah sees', () => {
  it('reads the branches of a git push command', () => {
    expect(gitPushTargets('npm test')).toBeUndefined();
    expect(gitPushTargets('git push')).toEqual(['HEAD']);
    expect(gitPushTargets('git push -u origin feature')).toEqual(['feature']);
    expect(gitPushTargets('git push --force-with-lease origin HEAD:refs/heads/stack-child')).toEqual(['stack-child']);
    expect(gitPushTargets('cd x && git -C y push -o ci.skip origin a +b:c; echo ok')).toEqual(['a', 'c']);
  });

  it('a trap beat records a push on its catch', () => {
    const wt = checkout('wt-beat', 'b2');
    fs.writeFileSync(path.join(wt, '.lobstah-trap'), JSON.stringify({ trapId: 't2' }));
    trap('t2', 'calm-heron', wt, uuid('f'));
    beatTrap({ cwd: wt, sessionId: 's1', toolName: 'Bash', toolInput: { command: 'git push origin HEAD' }, now: later });
    expect(readEvidence(uuid('f'), 'work').pushes).toEqual([{ branch: 'b2', at: iso(later) }]);
  });

  it('a headless worker push reaches the event stream as branch names only', () => {
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    pumpClaudeMessage(
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git push origin HEAD:b3 --token=secret' } }] } },
      (e) => events.push(e),
      () => {},
    );
    expect(events[0]?.data).toMatchObject({ name: 'Bash', pushes: ['b3'] });
    expect(JSON.stringify(events)).not.toContain('secret');
  });
});

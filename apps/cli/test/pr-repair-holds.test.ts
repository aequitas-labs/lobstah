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
  mergeEvidence,
  readEvidence,
  readPr,
  readWatch,
  recordPush,
  releaseHeldWatches,
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

  it('the same stack with no live worker: repairs are queued as today', () => {
    for (const p of STACK) stand(p);
    expect(repair()).toBe(3);
    expect(queued().map((d) => d.followUp).sort()).toEqual(STACK.map((p) => p.owner).sort());
  });

  it('a worker on a PR above does not hold the PR below it', () => {
    for (const p of STACK) stand(p);
    activeDispatch(uuid('c'), { prUrl: 'https://github.com/acme/web/pull/3' });
    expect(repair()).toBe(2);
    expect(readPr(key(1))?.repair?.status).toBe('repairing');
    expect(readPr(key(2))?.repair?.status).toBe('repairing');
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

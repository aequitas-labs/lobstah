import { CommandWatchType, WatchRegistry } from '@lobstah/watch-types';
import type { CommandWatchOptions, CommandWatchReference, CommandWatchState, WatchSnapshot, WatchDispatchPolicy } from '@lobstah/watch-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { builtinWatchRegistry, WatchRuntime, WatchJournal, pendingWatchEvents, addWatch, appendStatus, appendWatchEvents, ensureLayout, laneDirs, listNotices, listWatches, readWatch, runWatchCheck, claimCommandWatchContinuation, enqueue, releaseHeldWatches, signOnTrap, unhandled } from '@lobstah/core';
import type { Descriptor } from '@lobstah/core';
import { watchLoop, deliverDispatchOwned } from '../src/loops/watch.js';
import type { ReportNotification } from '../src/loops/report.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-watchloop-'));
  process.env.LOBSTAH_HOME = dir;
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(dir);
});

function eventCheck(events: Array<{ seq: number; summary: string; [key: string]: unknown }>, cursor: string): string {
  const script = path.join(dir, `check-${cursor}.cjs`);
  fs.writeFileSync(
    script,
    `const cursor = process.argv[2];
if (cursor === '0') console.log(JSON.stringify({ cursor: ${JSON.stringify(cursor)}, events: ${JSON.stringify(events)} }));
else console.log(JSON.stringify({ cursor }));
`,
  );
  return `node "${script}" {cursor}`;
}

function makeOwnerDispatch(id: string, repo = 'myrepo'): void {
  const activeDir = path.join(laneDirs('work').active, id);
  fs.mkdirSync(activeDir, { recursive: true });
  const d: Descriptor = { id, repo, brief: 'original brief' };
  fs.writeFileSync(path.join(activeDir, 'descriptor.json'), JSON.stringify(d));
}

function queuedDescriptors(): Descriptor[] {
  return fs
    .readdirSync(laneDirs('work').queue)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(laneDirs('work').queue, f), 'utf8')) as Descriptor);
}

describe('watchLoop', () => {
  it("a PR watch's continuation ends with the repo's ciFix hook; another watch's does not", async () => {
    fs.writeFileSync(path.join(dir, 'config.toml'), '[watch]\nautoRepair = false\n[repos.myrepo]\npath = "/m"\n[repos.myrepo.hooks.brief]\nciFix = "Run the CI refresh."\n');
    const pr = '22222222-2222-4222-8222-222222222222';
    makeOwnerDispatch(pr);
    appendStatus(pr, 'work', 'done', 'PR sent');
    // The daemon's PR poller writes a PR watch's events; the watch loop delivers them.
    addWatch('pr:acme/web#9', 'echo {}', { owner: `dispatch:${pr}`, brief: 'Fix {key}: {summaries}' });
    appendWatchEvents('pr:acme/web#9', [{ seq: 1, summary: 'review: CHANGES_REQUESTED', at: new Date().toISOString() }]);
    const other = '33333333-3333-4333-8333-333333333333';
    makeOwnerDispatch(other);
    appendStatus(other, 'work', 'paused', 'awaiting review');
    addWatch('ume:abc', eventCheck([{ seq: 1, summary: 'feedback batch' }], '1'), { owner: `dispatch:${other}` });
    await watchLoop(45, () => {});
    const queued = queuedDescriptors();
    expect(queued.find((d) => d.followUp === pr)?.brief).toBe('Fix pr:acme/web#9: - review: CHANGES_REQUESTED\n\nRun the CI refresh.');
    expect(unhandled(other, 'work')[0]?.text).toContain('feedback batch');
    expect(unhandled(other, 'work')[0]?.text).not.toContain('Run the CI refresh.');
  });

  it('dispatch-owned events fork one continuation of the owning chain', async () => {
    const owner = '11111111-1111-1111-1111-111111111111';
    makeOwnerDispatch(owner);
    appendStatus(owner, 'work', 'done', 'finished earlier work');
    addWatch('ume:abc', eventCheck([{ seq: 1, summary: 'feedback batch' }], '1'), { owner: `dispatch:${owner}` });

    await watchLoop(45, () => {});
    const queued = queuedDescriptors();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.followUp).toBe(owner);
    expect(queued[0]!.repo).toBe('myrepo');
    expect(queued[0]!.brief).toContain('feedback batch');
    expect(readWatch('ume:abc')!.lastFollowUpId).toBe(queued[0]!.id);
  });

  it('holds further continuations while one is in flight', async () => {
    const owner = '22222222-2222-2222-2222-222222222222';
    makeOwnerDispatch(owner);
    const w = addWatch('ume:def', eventCheck([{ seq: 1, summary: 'round 1' }], '1'), { owner: `dispatch:${owner}` });

    await watchLoop(45, () => {});
    const first = queuedDescriptors();
    expect(first).toHaveLength(1);

    // More events arrive while the continuation is queued (non-terminal).
    fs.appendFileSync(
      path.join(dir, 'watches', 'ume-def.events'),
      `${JSON.stringify({ seq: 2, summary: 'round 2', at: new Date().toISOString() })}\n`,
    );
    // Force the watch due again with a quiet check.
    addWatch(w.key, 'echo {}', { owner: `dispatch:${owner}` });
    await watchLoop(45, () => {});
    expect(queuedDescriptors()).toHaveLength(1); // still just the first

    // Continuation finishes → next sweep forks the buffered round from it.
    const contId = first[0]!.id;
    appendStatus(contId, 'work', 'done', 'round 1 handled');
    await watchLoop(45, () => {});
    const after = queuedDescriptors();
    expect(after).toHaveLength(2);
    const second = after.find((d) => d.id !== contId && d.followUp !== undefined && d.brief.includes('round 2'));
    expect(second?.followUp).toBe(contId); // forks the LATEST session in the chain
  });

  it('man-owned events fire the notify hook and never enqueue anything', async () => {
    addWatch('ume:plan', eventCheck([{ seq: 1, summary: 'verdict: approved' }], '1'));
    const pings: ReportNotification[] = [];
    await watchLoop(45, () => {}, (n) => pings.push(n));
    expect(queuedDescriptors()).toHaveLength(0);
    expect(pings).toHaveLength(1);
    expect(pings[0]!.verb).toBe('watch');
    expect(pings[0]!.note).toBe('verdict: approved');
    expect(listWatches()).toHaveLength(1); // stays standing for man wait to consume
  });

  it('delivers feedback to the active owner inbox for its live trap', async () => {
    const owner = '44444444-4444-4444-4444-444444444444';
    makeOwnerDispatch(owner);
    appendStatus(owner, 'work', 'paused', 'awaiting review');
    const worktree = path.join(process.env.LOBSTAH_HOME!, 'wt-live');
    fs.mkdirSync(worktree, { recursive: true });
    const res = signOnTrap({ sessionId: 'sess-1', harness: 'claude', worktree, cwd: worktree, ttlMs: 1800_000 });
    const trapId = 'ok' in res ? res.ok.trapId : '';
    fs.writeFileSync(
      path.join(laneDirs('work').active, owner, 'claim.json'),
      JSON.stringify({ by: `wt:${trapId}`, sessionId: 'sess-1', harness: 'claude', worktree, at: new Date().toISOString() }),
    );
    addWatch('ume:live', eventCheck([{ seq: 1, summary: 'round' }], '1'), { owner: `dispatch:${owner}` });

    await watchLoop(45, () => {});
    const queued = queuedDescriptors();
    expect(queued).toHaveLength(0);
    expect(unhandled(owner, 'work')[0]?.text).toContain('round');
  });

  it('keeps feedback in the active owner inbox when its trap is gone', async () => {
    const owner = '55555555-5555-5555-5555-555555555555';
    makeOwnerDispatch(owner);
    appendStatus(owner, 'work', 'paused', 'awaiting review');
    fs.writeFileSync(
      path.join(laneDirs('work').active, owner, 'claim.json'),
      JSON.stringify({ by: 'wt:deadbeef', sessionId: 'gone', harness: 'claude', worktree: '/wt', at: new Date().toISOString() }),
    );
    addWatch('ume:ghosted', eventCheck([{ seq: 1, summary: 'round' }], '1'), { owner: `dispatch:${owner}` });

    await watchLoop(45, () => {});
    const queued = queuedDescriptors();
    expect(queued).toHaveLength(0);
    expect(unhandled(owner, 'work')[0]?.text).toContain('round');
  });

  it('drops a dispatch-owned watch whose owner is gone', async () => {
    addWatch('ume:orphan', eventCheck([{ seq: 1, summary: 'x' }], '1'), {
      owner: 'dispatch:33333333-3333-3333-3333-333333333333',
    });
    await watchLoop(45, () => {});
    expect(queuedDescriptors()).toHaveLength(0);
    expect(listWatches()).toHaveLength(0);
  });

  it('forks at most [watch].maxForksPerCycle continuations per cycle and holds the rest until released', async () => {
    const keys: string[] = [];
    for (let n = 1; n <= 5; n++) {
      const owner = `3333333${n}-3333-3333-3333-333333333333`;
      makeOwnerDispatch(owner);
      appendStatus(owner, 'work', 'done', 'shipped');
      const key = `ci:${n}`;
      keys.push(key);
      addWatch(key, eventCheck([{ seq: 1, summary: `check failed ${n}` }], `c${n}`), { owner: `dispatch:${owner}` });
    }
    const logs: string[] = [];
    await watchLoop(45, (m) => logs.push(m));
    expect(queuedDescriptors()).toHaveLength(3);
    const held = listWatches().filter((w) => w.heldAt).map((w) => w.key).sort();
    expect(held).toHaveLength(2);
    expect(logs.some((l) => l.includes('fork cap 3 reached'))).toBe(true);
    const notices = listNotices(50).filter((n) => n.kind === 'watch-held');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain(held[0]!);

    // Held watches stay held across cycles: nothing more forks, no second notice.
    await watchLoop(45, () => {});
    expect(queuedDescriptors()).toHaveLength(3);
    expect(listNotices(50).filter((n) => n.kind === 'watch-held')).toHaveLength(1);

    // Release lets them fork on the next cycle.
    expect(releaseHeldWatches().sort()).toEqual(held);
    await watchLoop(45, () => {});
    expect(queuedDescriptors()).toHaveLength(5);
    expect(listWatches().filter((w) => w.heldAt)).toEqual([]);
  });

  it('reads the fork cap from [watch].maxForksPerCycle', async () => {
    fs.writeFileSync(path.join(dir, 'config.toml'), '[watch]\nmaxForksPerCycle = 1\n');
    for (let n = 1; n <= 3; n++) {
      const owner = `4444444${n}-4444-4444-4444-444444444444`;
      makeOwnerDispatch(owner);
      addWatch(`ci:${n}`, eventCheck([{ seq: 1, summary: `fail ${n}` }], `d${n}`), { owner: `dispatch:${owner}` });
    }
    await watchLoop(45, () => {});
    expect(queuedDescriptors()).toHaveLength(1);
    expect(listWatches().filter((w) => w.heldAt)).toHaveLength(2);
  });
});

// A `#!/bin/sh` gh stub: POSIX only.
describe.skipIf(process.platform === 'win32')('watchLoop failure logging', () => {
  it("logs the check's own reason with the watch key and exit code, then backs off", async () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'gh'),
      `#!/bin/sh\necho 'GraphQL: Resource not accessible by integration (repository.pullRequest.statusCheckRollup)' >&2\nexit 1\n`,
    );
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
    addWatch('pr:owner/repo#12', `PATH="${bin}:$PATH" gh pr view 12 --repo owner/repo --json statusCheckRollup`);
    const lines: string[] = [];
    await watchLoop(45, (m) => lines.push(m));
    expect(lines).toEqual([
      'pr:owner/repo#12 check failed: Resource not accessible by integration (repository.pullRequest.statusCheckRollup) (exit 1) — grant the GitHub App `Checks: read` (or use a token with the `repo` scope); see docs/github.md',
    ]);
    // Backed off: the next cycle, one cadence later, does not re-run the check.
    const w = readWatch('pr:owner/repo#12')!;
    w.lastCheckedAt = new Date(Date.now() - 50_000).toISOString();
    fs.writeFileSync(path.join(dir, 'watches', 'pr-owner-repo-12.json'), JSON.stringify(w));
    await watchLoop(45, (m) => lines.push(m));
    expect(lines).toHaveLength(1);
  });
});

// A crash can occur after enqueue but before markFollowUp records its receipt.
it('replays a reserved continuation without filing a second dispatch after restart', () => {
  const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  makeOwnerDispatch(owner); appendStatus(owner, 'work', 'done', 'source ready');
  const watch = addWatch('custom:restart', eventCheck([{ seq: 1, summary: 'resume once' }], '1'), { owner: `dispatch:${owner}` });
  runWatchCheck(watch);
  const reserved = claimCommandWatchContinuation(watch.key)!.id;
  enqueue({ id: reserved, repo: 'myrepo', brief: 'already filed before the crash', followUp: owner });
  // A later event must survive replay of the earlier, already queued brief.
  appendWatchEvents(watch.key, [{ seq: 2, summary: 'arrived after the crash', at: new Date().toISOString() }]);
  runWatchCheck(readWatch(watch.key)!);
  // The restart sees an unacknowledged outbox but the same committed ID.
  deliverDispatchOwned(() => {});
  expect(queuedDescriptors().map((descriptor) => descriptor.id)).toEqual([reserved]);
  expect(readWatch(watch.key)?.lastFollowUpId).toBe(reserved);
  expect(readWatch(watch.key)?.seen).toBe(1);
});

it('a journal-only source delivers its own instructions and replays the same continuation, including fork holds', () => {
  const owner = '33333333-3333-4333-8333-333333333333';
  makeOwnerDispatch(owner); appendStatus(owner, 'work', 'done', 'ready');
  class FixtureWatch extends CommandWatchType {
    readonly descriptor = { id: 'fixture', apiVersion: 1 as const, stateVersion: 1, version: '1.0.0' };
    committed = new Set<string>();
    readonly dispatchPolicy: WatchDispatchPolicy<CommandWatchReference, CommandWatchState, string, CommandWatchOptions> = {
      plan: ({ snapshot, events }) => ({ disposition: this.committed.has(snapshot.key) ? 'ignore' : 'continue', eventIds: events.map((event) => event.id), notes: [], state: { recorded: true } }),
      delivered: ({ snapshot }) => { this.committed.add(snapshot.key); },
    };
    poll() { return { cursor: '1', events: [{ id: 'changed', kind: 'fixture:changed', summary: 'Fixture needs a response', at: new Date().toISOString(), data: null }] }; }
    present(snapshot: WatchSnapshot<CommandWatchReference, CommandWatchState, string, CommandWatchOptions>) {
      return { ...super.present(snapshot), worker: { steps: ['Read the fixture feedback and respond.'], read: { executable: 'fixture', args: ['feedback', snapshot.key], environment: { FIXTURE_PROJECT: 'example' } } } };
    }
  }
  const registry = new WatchRegistry(); registry.register(new FixtureWatch());
  const runtime = new WatchRuntime(registry);
  for (const key of ['fixture:one', 'fixture:two']) { runtime.register('fixture', key, { check: 'unused' }, { kind: 'dispatch', chainId: owner, grounds: 'home' }); runtime.checkSync(key); }
  deliverDispatchOwned(() => {}, 1, registry);
  expect(queuedDescriptors()).toHaveLength(1);
  expect(queuedDescriptors()[0]?.brief).toContain('Read the fixture feedback and respond.');
  expect(queuedDescriptors()[0]?.brief).toContain('FIXTURE_PROJECT');
  expect(queuedDescriptors()[0]?.brief).toContain('Fixture needs a response');
  const snapshots = new WatchJournal().list();
  const delivered = snapshots.find((snapshot) => snapshot.deliveryProgress?.lastFollowUpId)!;
  const held = snapshots.find((snapshot) => snapshot.deliveryProgress?.heldAt)!;
  expect(held).toBeTruthy();
  runtime.journal.update(delivered.key, (snapshot) => {
    snapshot!.deliveries.forEach((receipt) => { receipt.status = 'pending'; });
    snapshot!.deliveryProgress = {};
    return { snapshot, result: undefined };
  });
  deliverDispatchOwned(() => {}, 1, registry);
  expect(queuedDescriptors()).toHaveLength(1);
  expect(runtime.journal.read(delivered.key)?.deliveryProgress?.lastFollowUpId).toBe(queuedDescriptors()[0]?.id);
  expect(runtime.journal.read(delivered.key)?.deliveries.every((receipt) => receipt.status === 'delivered')).toBe(true);
  expect(releaseHeldWatches(held.key)).toEqual([held.key]);
  deliverDispatchOwned(() => {}, 2, registry);
  expect(queuedDescriptors()).toHaveLength(2);
  expect(pendingWatchEvents(false, 'dispatch')).toEqual([]);
});

it('a journal-only PR keeps check-round policy state and human gates across delivery replay', () => {
  const owner = '44444444-4444-4444-8444-444444444444';
  makeOwnerDispatch(owner); appendStatus(owner, 'work', 'done', 'ready');
  fs.writeFileSync(path.join(dir, 'config.toml'), '[watch]\nautoRepair=false\n[repos.myrepo]\npath="/repo"\nhumanGateChecks=["Approval Gate"]\n');
  const registry = builtinWatchRegistry(), runtime = new WatchRuntime(registry);
  const key = 'pr:acme/web#40';
  const check = eventCheck([
    { seq: 1, summary: 'verify failed', kind: 'check-completed', name: 'verify', conclusion: 'FAILURE', headSha: 'head' },
    { seq: 2, summary: 'approval needed', kind: 'check-completed', name: 'Approval Gate', conclusion: 'FAILURE', headSha: 'head' },
  ], '2');
  runtime.register('pr', key, { check }, { kind: 'dispatch', chainId: owner, grounds: 'home' });
  runtime.checkSync(key);
  deliverDispatchOwned(() => {}, 3, registry);
  expect(queuedDescriptors()).toHaveLength(1);
  const workId = queuedDescriptors()[0]!.id;
  expect(runtime.journal.read(key)?.state).toEqual({ checkRounds: ['head:verify'] });
  runtime.journal.update(key, (snapshot) => {
    const receipt = snapshot!.deliveries.find((entry) => entry.continuationId === workId)!;
    receipt.status = 'pending'; snapshot!.deliveryProgress = {};
    return { snapshot, result: undefined };
  });
  deliverDispatchOwned(() => {}, 3, registry);
  expect(queuedDescriptors()).toHaveLength(1);
  expect(runtime.journal.read(key)?.deliveryProgress?.lastFollowUpId).toBe(workId);
  appendStatus(workId, 'work', 'done', 'checked');
  deliverDispatchOwned(() => {}, 3, registry);
  expect(pendingWatchEvents(false, 'dispatch')).toEqual([]);
  runtime.journal.update(key, (snapshot) => {
    snapshot!.events.push({ id: '3', kind: 'check-completed', summary: 'verify still failed', at: new Date().toISOString(), data: { kind: 'check-completed', name: 'verify', conclusion: 'FAILURE', headSha: 'head' } });
    snapshot!.deliveries.push({ id: 'later', eventIds: ['3'], status: 'pending' });
    return { snapshot, result: undefined };
  });
  deliverDispatchOwned(() => {}, 3, registry);
  expect(queuedDescriptors()).toHaveLength(1);
  expect(pendingWatchEvents(false, 'dispatch')).toEqual([]);
});

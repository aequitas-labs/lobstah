import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, claimNext, enqueue, ensureLayout, pendingIds, readDescriptor } from '@lobstah/core';
import type { Evidence, Verb } from '@lobstah/core';
import { PickupState } from '../src/state.js';
import { dispatchLoop } from '../src/loops/dispatch.js';
import { reportLoop } from '../src/loops/report.js';
import { reconcileLoop } from '../src/loops/reconcile.js';
import { approvalDedupKey, mergeLoop, qualifiedApproval, qualifyingSet } from '../src/loops/merge.js';
import { DEFAULT_MERGE_POLICY } from '../src/types.js';
import type { MergeSource, PrCandidate, Source, TrackedItem, WorkItem } from '../src/types.js';
import { readMergeView } from '../src/merge-view.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-pick-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

class FakeSource implements Source {
  name = 'fake';
  items: WorkItem[] = [];
  claimable = true;
  tracked: TrackedItem[] = [];
  recoverable = new Map<string, string>();
  resets: string[] = [];
  reports: Array<{ key: string; verb: Verb; uuid: string }> = [];
  inboundMsgs = new Map<string, string[]>();

  async poll() { return this.items; }
  async claim() { return this.claimable; }
  async report(key: string, verb: Verb, ev: Evidence & { uuid: string }) {
    this.reports.push({ key, verb, uuid: ev.uuid });
  }
  async inbound(key: string) { return this.inboundMsgs.get(key) ?? []; }
  async inProgress() { return this.tracked; }
  async recoverUuid(key: string) { return this.recoverable.get(key); }
  async reset(key: string) { this.resets.push(key); }
}

const item = (key: string, kind: 'issue' | 'review' = 'issue', followUp?: string): WorkItem => ({
  key, kind, repoKey: 'demo', title: 't', brief: 'do it', followUp,
});

describe('dispatch loop', () => {
  it('claims, enqueues, and maps — once per tracker key', async () => {
    const src = new FakeSource();
    src.items = [item('fake:1')];
    const st = new PickupState();
    await dispatchLoop(src, st);
    await dispatchLoop(src, st); // second poll of the same item
    expect(pendingIds('work')).toHaveLength(1);
    expect(st.get('fake:1')?.uuid).toBeDefined();
  });

  it('a lost claim means no dispatch', async () => {
    const src = new FakeSource();
    src.items = [item('fake:2')];
    src.claimable = false;
    const st = new PickupState();
    await dispatchLoop(src, st);
    expect(pendingIds('work')).toHaveLength(0);
    expect(st.get('fake:2')).toBeUndefined();
  });

  it('review items fork the implementation dispatch; issues start cold', async () => {
    const src = new FakeSource();
    const impl = '11111111-1111-1111-1111-111111111111';
    enqueue({ id: impl, repo: 'demo', brief: 'implement it' }, 'work');
    appendStatus(impl, 'work', 'done');
    src.items = [{ ...item('fake:pr1@e1', 'review', impl), subject: 'fake:pr1' }, item('fake:3')];
    const st = new PickupState();
    await dispatchLoop(src, st);
    const descs = pendingIds('work').map((id) => JSON.parse(fs.readFileSync(path.join(home, 'queue', `${id}.json`), 'utf8')));
    expect(descs.find((d) => d.followUp === impl)).toBeDefined();
    expect(descs.filter((d) => d.followUp === undefined && d.id !== impl)).toHaveLength(1);
  });

  it('a review round holds while the prior round runs, then forks the newest finished round', async () => {
    const src = new FakeSource();
    const impl = '11111111-1111-1111-1111-111111111111';
    enqueue({ id: impl, repo: 'demo', brief: 'implement it' }, 'work');
    appendStatus(impl, 'work', 'done');
    const st = new PickupState();
    src.items = [{ ...item('fake:pr2@e1', 'review', impl), subject: 'fake:pr2' }];
    await dispatchLoop(src, st);
    const round1 = st.get('fake:pr2@e1')!.uuid;

    src.items = [{ ...item('fake:pr2@e2', 'review', impl), subject: 'fake:pr2' }];
    await dispatchLoop(src, st); // round1 not terminal yet — e2 buffers
    expect(st.get('fake:pr2@e2')).toBeUndefined();

    appendStatus(round1, 'work', 'done');
    await dispatchLoop(src, st);
    const round2 = st.get('fake:pr2@e2')!.uuid;
    const desc = JSON.parse(fs.readFileSync(path.join(home, 'queue', `${round2}.json`), 'utf8'));
    expect(desc.followUp).toBe(round1); // the latest session in the chain, not the implementation
  });

  it('a review round whose chain was culled starts cold', async () => {
    const src = new FakeSource();
    src.items = [{ ...item('fake:pr3@e1', 'review', '22222222-2222-2222-2222-222222222222'), subject: 'fake:pr3' }];
    const st = new PickupState();
    await dispatchLoop(src, st);
    const uuid = st.get('fake:pr3@e1')!.uuid;
    const desc = JSON.parse(fs.readFileSync(path.join(home, 'queue', `${uuid}.json`), 'utf8'));
    expect(desc.followUp).toBeUndefined();
  });
});

describe('report loop', () => {
  it('replays verb changes and advances lastReported only on success', async () => {
    const src = new FakeSource();
    src.items = [item('fake:4')];
    const st = new PickupState();
    await dispatchLoop(src, st);
    const uuid = st.get('fake:4')!.uuid;
    claimNext('work');
    appendStatus(uuid, 'work', 'working');
    await reportLoop(src, st);
    appendStatus(uuid, 'work', 'done');
    await reportLoop(src, st);
    await reportLoop(src, st); // no change → no extra report
    expect(src.reports.map((r) => r.verb)).toEqual(['working', 'done']);
    expect(src.reports.every((r) => r.uuid === uuid)).toBe(true);
  });

  it('notifies on each verb transition with note and uuid', async () => {
    const src = new FakeSource();
    src.items = [item('fake:n1')];
    const st = new PickupState();
    await dispatchLoop(src, st);
    const uuid = st.get('fake:n1')!.uuid;
    claimNext('work');
    const seen: Array<{ verb: string; note?: string }> = [];
    appendStatus(uuid, 'work', 'working');
    await reportLoop(src, st, () => {}, (n) => seen.push({ verb: n.verb, note: n.note }));
    appendStatus(uuid, 'work', 'done', 'shipped it');
    await reportLoop(src, st, () => {}, (n) => seen.push({ verb: n.verb, note: n.note }));
    await reportLoop(src, st, () => {}, (n) => seen.push({ verb: n.verb, note: n.note }));
    expect(seen).toEqual([{ verb: 'working', note: undefined }, { verb: 'done', note: 'shipped it' }]);
  });

  it('forwards human comments into the dispatch inbox', async () => {
    const src = new FakeSource();
    src.items = [item('fake:5')];
    const st = new PickupState();
    await dispatchLoop(src, st);
    const uuid = st.get('fake:5')!.uuid;
    claimNext('work');
    src.inboundMsgs.set('fake:5', ['please also update the docs']);
    await reportLoop(src, st);
    const inboxDir = path.join(home, 'inbox', uuid);
    expect(fs.readdirSync(inboxDir).filter((f) => f.endsWith('.msg'))).toHaveLength(1);
  });
});

describe('reconcile loop', () => {
  it('rebuilds a missing mapping from the tracker trail instead of resetting', async () => {
    const src = new FakeSource();
    src.tracked = [{ key: 'fake:6', open: true }];
    src.recoverable.set('fake:6', '22222222-2222-2222-2222-222222222222');
    const st = new PickupState();
    await reconcileLoop(src, st);
    expect(src.resets).toEqual([]);
    expect(st.get('fake:6')?.uuid).toBe('22222222-2222-2222-2222-222222222222');
    expect(st.get('fake:6')?.recovered).toBe(true);
  });

  it('resets a genuinely orphaned item only after rebuild misses', async () => {
    const src = new FakeSource();
    src.tracked = [{ key: 'fake:7', open: true }];
    const st = new PickupState();
    await reconcileLoop(src, st);
    expect(src.resets).toEqual(['fake:7']);
  });

  it('cancels an orphaned dispatch when its item closes', async () => {
    const src = new FakeSource();
    src.items = [item('fake:8')];
    const st = new PickupState();
    await dispatchLoop(src, st);
    const uuid = st.get('fake:8')!.uuid;
    claimNext('work');
    src.tracked = [{ key: 'fake:8', open: false }];
    await reconcileLoop(src, st);
    expect(fs.existsSync(path.join(home, 'active', uuid, 'cancel'))).toBe(true);
  });
});

describe('failed issue retries', () => {
  function finalize(uuid: string) {
    fs.renameSync(path.join(home, 'active', uuid), path.join(home, 'done', uuid));
  }

  it('releases a finalized failure after reporting, then dispatches a fresh attempt', async () => {
    const src = new FakeSource();
    src.items = [item('linear:DEMO-1')];
    const st = new PickupState();
    await dispatchLoop(src, st);
    const first = st.get('linear:DEMO-1')!.uuid;
    claimNext('work');
    appendStatus(first, 'work', 'failed');
    await reportLoop(src, st);
    await dispatchLoop(src, st); // failure reported, but the old worker still owns the slot
    expect(st.get('linear:DEMO-1')!.uuid).toBe(first);
    expect(st.get('linear:DEMO-1')!.released).not.toBe(true);

    finalize(first);
    await reportLoop(src, st);
    expect(st.get('linear:DEMO-1')).toMatchObject({ released: true, attempts: 1 });
    await reportLoop(src, st); // no duplicate report from the released entry
    expect(src.reports.map((r) => r.verb)).toEqual(['failed']);
    const reloaded = new PickupState();
    await dispatchLoop(src, reloaded);
    expect(reloaded.get('linear:DEMO-1')).toMatchObject({ attempts: 2 });
    expect(reloaded.get('linear:DEMO-1')!.uuid).not.toBe(first);
    expect(reloaded.get('linear:DEMO-1')!.lastReported).toBeUndefined();
    expect(pendingIds('work')).toHaveLength(1);
  });

  it('does not release when the tracker report fails; retries the report next tick', async () => {
    const src = new FakeSource();
    src.items = [item('linear:DEMO-2')];
    const st = new PickupState();
    await dispatchLoop(src, st);
    const uuid = st.get('linear:DEMO-2')!.uuid;
    claimNext('work');
    appendStatus(uuid, 'work', 'failed');
    finalize(uuid);
    const report = src.report.bind(src);
    src.report = async () => { throw new Error('tracker offline'); };
    await expect(reportLoop(src, st)).rejects.toThrow('tracker offline');
    await dispatchLoop(src, st);
    expect(st.get('linear:DEMO-2')!.uuid).toBe(uuid);
    expect(st.get('linear:DEMO-2')!.released).not.toBe(true);
    src.report = report;
    await reportLoop(src, st);
    expect(st.get('linear:DEMO-2')!.released).toBe(true);
  });

  it.each([0, 2])('bounds retries across reloads using maxRestartAttempts = %s', async (retries) => {
    fs.writeFileSync(path.join(home, 'config.toml'), `[limits]\nmaxRestartAttempts = ${retries}\n`);
    const src = new FakeSource();
    src.items = [item('linear:DEMO-3')];
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      const st = new PickupState();
      await dispatchLoop(src, st);
      expect(st.get('linear:DEMO-3')!.attempts).toBe(attempt);
      const uuid = st.get('linear:DEMO-3')!.uuid;
      claimNext('work');
      appendStatus(uuid, 'work', 'failed');
      finalize(uuid);
      await reportLoop(src, st);
    }
    const st = new PickupState();
    const last = st.get('linear:DEMO-3')!.uuid;
    await dispatchLoop(src, st);
    await dispatchLoop(src, st);
    expect(st.get('linear:DEMO-3')!.uuid).toBe(last);
    expect(pendingIds('work')).toHaveLength(0);
    expect(fs.readdirSync(path.join(home, 'done'))).toHaveLength(retries + 1);
  });

  it('counts a legacy failed entry as the first attempt', async () => {
    const src = new FakeSource();
    src.items = [item('linear:DEMO-4')];
    const st = new PickupState();
    const uuid = '55555555-5555-5555-5555-555555555555';
    enqueue({ id: uuid, repo: 'demo', brief: 'legacy' }, 'work');
    claimNext('work');
    appendStatus(uuid, 'work', 'failed');
    finalize(uuid);
    st.set('linear:DEMO-4', { uuid, kind: 'issue', createdAt: new Date().toISOString(), lastReported: 'failed' });
    await reportLoop(src, st);
    await dispatchLoop(src, st);
    expect(st.get('linear:DEMO-4')!.attempts).toBe(2);
    expect(st.get('linear:DEMO-4')!.uuid).not.toBe(uuid);
  });

  it.each([['issue', 'done'], ['review', 'failed']] as const)('keeps %s / %s entries deduplicated', async (kind, verb) => {
    const src = new FakeSource();
    src.items = [item('fake:keep', kind)];
    const st = new PickupState();
    await dispatchLoop(src, st);
    const uuid = st.get('fake:keep')!.uuid;
    claimNext('work');
    appendStatus(uuid, 'work', verb);
    finalize(uuid);
    await reportLoop(src, st);
    await dispatchLoop(src, st);
    expect(st.get('fake:keep')!.uuid).toBe(uuid);
    expect(st.get('fake:keep')!.released).not.toBe(true);
    expect(pendingIds('work')).toHaveLength(0);
  });
});

class FakeMergeSource implements MergeSource {
  name = 'fake-merge';
  candidates: PrCandidate[] = [];
  merged: number[] = [];
  updated: number[] = [];
  comments: Array<{ n: number; text: string }> = [];
  labels: Array<{ n: number; label: string }> = [];

  dispositions: Record<number, 'open' | 'merged' | 'closed'> = {};

  async mergeCandidates() { return this.candidates; }
  async refresh(n: number) { return this.candidates.find((c) => c.number === n); }
  async updateBranch(n: number) { this.updated.push(n); }
  async merge(n: number) { this.merged.push(n); }
  async comment(n: number, text: string) { this.comments.push({ n, text }); }
  async addLabel(n: number, label: string) { this.labels.push({ n, label }); }
  async disposition(n: number) { return this.dispositions[n] ?? (this.merged.includes(n) ? ('merged' as const) : ('closed' as const)); }
  repoKey() { return 'demo'; }
  forgeRepo() { return 'demo/demo'; }
}

const pr = (over: Partial<PrCandidate> = {}): PrCandidate => ({
  number: 1,
  url: 'https://x/pr/1',
  author: 'lobstah-bot',
  headSha: 'abc',
  headRef: 'lobstah/33333333-3333-3333-3333-333333333333',
  labels: [],
  assignees: ['alice'],
  reviews: [{ id: 10, author: 'alice', state: 'APPROVED', sha: 'abc' }],
  mergeableState: 'clean',
  ...over,
});

const policy = { ...DEFAULT_MERGE_POLICY, enabled: true, approvers: ['chris'], restrictedLabels: ['risk:high'] };

describe('merge policy — monotone by construction', () => {
  it('assignees join the floor normally', () => {
    expect(qualifyingSet(policy, pr()).sort()).toEqual(['alice', 'chris']);
  });
  it('a restricted label collapses to the floor', () => {
    expect(qualifyingSet(policy, pr({ labels: ['risk:high'] }))).toEqual(['chris']);
  });
  it('outstanding CHANGES_REQUESTED blocks any approval', () => {
    const p = pr({ reviews: [
      { id: 10, author: 'alice', state: 'APPROVED', sha: 'abc' },
      { id: 11, author: 'bob', state: 'CHANGES_REQUESTED', sha: 'abc' },
    ]});
    expect(qualifiedApproval(policy, p)).toBeUndefined();
  });
  it('an approval on a stale head does not qualify', () => {
    expect(qualifiedApproval(policy, pr({ reviews: [{ id: 10, author: 'chris', state: 'APPROVED', sha: 'old' }] }))).toBeUndefined();
  });
});

describe('merge loop', () => {
  it('merges a qualified PR and consumes the approval exactly once', async () => {
    const ms = new FakeMergeSource();
    ms.candidates = [pr()];
    const st = new PickupState();
    await mergeLoop(ms, policy, st);
    await mergeLoop(ms, policy, st); // same approval again
    expect(ms.merged).toEqual([1]);
    expect(st.approvalConsumed(approvalDedupKey(pr(), { id: 10 }))).toBe(true);
  });

  it('restricted label + assignee-only approval does not merge', async () => {
    const ms = new FakeMergeSource();
    ms.candidates = [pr({ labels: ['risk:high'] })];
    const st = new PickupState();
    await mergeLoop(ms, policy, st);
    expect(ms.merged).toEqual([]);
  });

  it('cleanly behind updates the branch instead of merging', async () => {
    const ms = new FakeMergeSource();
    ms.candidates = [pr({ mergeableState: 'behind' })];
    const st = new PickupState();
    await mergeLoop(ms, policy, st);
    expect(ms.updated).toEqual([1]);
    expect(ms.merged).toEqual([]);
  });

  it('a real conflict writes a rebase chore to the chore lane, once', async () => {
    const ms = new FakeMergeSource();
    ms.candidates = [pr({ mergeableState: 'dirty' })];
    const st = new PickupState();
    await mergeLoop(ms, policy, st);
    await mergeLoop(ms, policy, st); // chore still active → no second chore
    const chores = pendingIds('chore');
    expect(chores).toHaveLength(1);
    const desc = readChore(chores[0]!);
    expect(desc.repo).toBe('demo');
    expect(desc.brief).toMatch(/Rebase the branch/);
    expect(desc.followUp).toBeUndefined(); // rebase chores start cold on purpose
  });

  it('a failed rebase chore flags for a human and stops, bounded at one attempt', async () => {
    const ms = new FakeMergeSource();
    ms.candidates = [pr({ mergeableState: 'dirty' })];
    const st = new PickupState();
    await mergeLoop(ms, policy, st);
    const choreId = pendingIds('chore')[0]!;
    claimNext('chore');
    appendStatus(choreId, 'chore', 'failed', 'could not resolve');
    fs.renameSync(path.join(home, 'chores', 'active', choreId), path.join(home, 'chores', 'done', choreId));
    await mergeLoop(ms, policy, st);
    await mergeLoop(ms, policy, st); // stays flagged, no second chore, no spam
    expect(ms.labels).toEqual([{ n: 1, label: 'needs-human' }]);
    expect(ms.comments).toHaveLength(1);
    expect(pendingIds('chore')).toHaveLength(0);
  });
});

describe('merge view — the persisted forge observation', () => {
  it('records a gate per open PR, with the dispatch uuid from the branch', async () => {
    const ms = new FakeMergeSource();
    ms.candidates = [
      pr({ number: 1, reviews: [] }),
      pr({ number: 2, url: 'https://x/pr/2', headRef: 'lobstah/44444444-4444-4444-4444-444444444444', mergeableState: 'blocked' }),
    ];
    await mergeLoop(ms, policy, new PickupState());
    const view = readMergeView()!;
    expect(view.repo).toBe('demo/demo');
    expect(view.open.map((p) => [p.number, p.gate])).toEqual([
      [1, 'waiting-approval'],
      [2, 'blocked'],
    ]);
    expect(view.open[0]?.uuid).toBe('33333333-3333-3333-3333-333333333333');
  });

  it('a PR that leaves the open set gets a disposition in recent', async () => {
    const ms = new FakeMergeSource();
    ms.candidates = [pr()]; // qualified → merges this tick, so it never enters open
    const st = new PickupState();
    await mergeLoop(ms, policy, st);
    expect(readMergeView()!.open).toHaveLength(0);
    // it was open last tick in a prior run: simulate by seeding the view
    ms.candidates = [pr({ number: 7, url: 'https://x/pr/7', reviews: [] })];
    await mergeLoop(ms, policy, st);
    ms.candidates = [];
    ms.dispositions[7] = 'closed';
    await mergeLoop(ms, policy, st);
    const view = readMergeView()!;
    expect(view.open).toHaveLength(0);
    expect(view.recent).toEqual([expect.objectContaining({ number: 7, disposition: 'closed' })]);
  });
});

function readChore(id: string) {
  return JSON.parse(fs.readFileSync(path.join(home, 'chores', 'queue', `${id}.json`), 'utf8'));
}

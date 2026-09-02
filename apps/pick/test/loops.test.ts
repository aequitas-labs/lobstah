import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, claimNext, ensureLayout, pendingIds, readDescriptor } from '@lobstah/core';
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

  it('review items fork via followUp; issues start cold', async () => {
    const src = new FakeSource();
    const impl = '11111111-1111-1111-1111-111111111111';
    src.items = [item('fake:pr1', 'review', impl), item('fake:3')];
    const st = new PickupState();
    await dispatchLoop(src, st);
    const ids = pendingIds('work');
    const descs = ids.map((id) => JSON.parse(fs.readFileSync(path.join(home, 'queue', `${id}.json`), 'utf8')));
    expect(descs.find((d) => d.followUp === impl)).toBeDefined();
    expect(descs.filter((d) => d.followUp === undefined)).toHaveLength(1);
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

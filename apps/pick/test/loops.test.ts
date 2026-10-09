import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, claimNext, enqueue, ensureLayout, pendingIds, readDescriptor, slotUsage } from '@lobstah/core';
import type { Evidence, Verb } from '@lobstah/core';
import { PickupState } from '../src/state.js';
import { dispatchLoop } from '../src/loops/dispatch.js';
import { reportLoop } from '../src/loops/report.js';
import { reconcileLoop } from '../src/loops/reconcile.js';
import { approvalDedupKey, mergeLoop, qualifiedApproval, qualifyingSet, rebaseBrief, staleApprovals } from '../src/loops/merge.js';
import { DEFAULT_MERGE_POLICY } from '../src/types.js';
import type { MergeSource, PrCandidate, Source, TrackedItem, WorkItem } from '../src/types.js';
import { readMergeView } from '../src/merge-view.js';
import { cycle } from '../src/run.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-pick-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

class FakeSource implements Source {
  name = 'fake';
  owned: (key: string) => boolean = () => true;
  inboundKeys: string[] = [];
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
  owns(key: string) { return this.owned(key); }
  async inbound(key: string) {
    this.inboundKeys.push(key);
    return this.inboundMsgs.get(key) ?? [];
  }
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

  it('issues go to the first [pickup].pools pool that serves their repo; reviews keep their chain rule', async () => {
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      ['[repos.demo]', 'path = "/tmp/demo"', '[repos.other]', 'path = "/tmp/other"', '[pools.o]', 'repo = "other"', '[pools.d]', 'repo = "demo"'].join('\n'),
    );
    const src = new FakeSource();
    src.items = [item('fake:pool'), item('fake:review', 'review')];
    const st = new PickupState();
    await dispatchLoop(src, st, () => {}, ['o', 'd']);
    const issue = claimNext('work')!;
    const review = claimNext('work')!;
    const byId = new Map([issue, review].map((id) => [id, readDescriptor(id, 'work')]));
    expect(byId.get(st.get('fake:pool')!.uuid)?.pool).toBe('d');
    expect(byId.get(st.get('fake:review')!.uuid)?.pool).toBeUndefined();
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
  it('keeps one editable live comment, throttles routine changes, and announces terminal verbs', async () => {
    const src = new FakeSource() as FakeSource & {
      createLiveComment: (key: string, body: string) => Promise<string>;
      editLiveComment: (key: string, id: string, body: string) => Promise<void>;
    };
    const created: string[] = [];
    const edits: string[] = [];
    src.createLiveComment = async (_key, body) => { created.push(body); return 'comment-1'; };
    src.editLiveComment = async (_key, _id, body) => { edits.push(body); };
    src.items = [item('fake:live')];
    const st = new PickupState();
    await dispatchLoop(src, st);
    const uuid = st.get('fake:live')!.uuid;
    claimNext('work');
    appendStatus(uuid, 'work', 'working');
    await reportLoop(src, st);
    await reportLoop(src, st);
    expect(created).toHaveLength(1);
    expect(edits).toHaveLength(0);
    expect(src.reports).toHaveLength(0);
    expect(created[0]).toContain('elapsed:');
    expect(created[0]).toContain('updated ');

    appendStatus(uuid, 'work', 'done');
    await reportLoop(src, st);
    expect(created).toHaveLength(1);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain('**done**');
    expect(src.reports.map((r) => r.verb)).toEqual(['done']);
    await reportLoop(src, st);
    expect(edits).toHaveLength(1);
  });

  it('falls back to transition comments when live editing fails', async () => {
    const src = new FakeSource() as FakeSource & {
      createLiveComment: (key: string, body: string) => Promise<string>;
      editLiveComment: (key: string, id: string, body: string) => Promise<void>;
    };
    src.createLiveComment = async () => { throw new Error('no edit permission'); };
    src.editLiveComment = async () => {};
    src.items = [item('fake:fallback')];
    const st = new PickupState();
    await dispatchLoop(src, st);
    const uuid = st.get('fake:fallback')!.uuid;
    claimNext('work');
    appendStatus(uuid, 'work', 'working');
    await reportLoop(src, st);
    expect(st.get('fake:fallback')!.liveCommentUnavailable).toBe(true);
    expect(src.reports.map((r) => r.verb)).toEqual(['working']);
  });

  it('posts a transition when editing an existing live comment becomes unavailable', async () => {
    const src = new FakeSource() as FakeSource & {
      createLiveComment: (key: string, body: string) => Promise<string>;
      editLiveComment: (key: string, id: string, body: string) => Promise<void>;
    };
    let created = 0;
    src.createLiveComment = async () => { created++; return 'comment-1'; };
    src.editLiveComment = async () => { throw new Error('edit permission revoked'); };
    src.items = [item('fake:edit-fallback')];
    const st = new PickupState();
    await dispatchLoop(src, st);
    const uuid = st.get('fake:edit-fallback')!.uuid;
    claimNext('work');
    appendStatus(uuid, 'work', 'working');
    await reportLoop(src, st);
    appendStatus(uuid, 'work', 'done');
    await reportLoop(src, st);
    expect(created).toBe(1);
    expect(st.get('fake:edit-fallback')!.liveCommentUnavailable).toBe(true);
    expect(src.reports.map((r) => r.verb)).toEqual(['done']);
  });

  it('keeps the live comment id across pickup restarts and never creates a second one', async () => {
    const src = new FakeSource() as FakeSource & {
      createLiveComment: (key: string, body: string) => Promise<string>;
      editLiveComment: (key: string, id: string, body: string) => Promise<void>;
    };
    const created: string[] = [];
    const edited: string[] = [];
    src.createLiveComment = async () => { created.push('new'); return 'comment-1'; };
    src.editLiveComment = async (_key, id) => { edited.push(id); };
    src.items = [item('fake:restart')];
    const st = new PickupState();
    await dispatchLoop(src, st);
    const uuid = st.get('fake:restart')!.uuid;
    claimNext('work');
    appendStatus(uuid, 'work', 'working');
    await reportLoop(src, st);
    const restarted = new PickupState();
    expect(restarted.get('fake:restart')!.liveCommentId).toBe('comment-1');
    appendStatus(uuid, 'work', 'done');
    await reportLoop(src, restarted);
    expect(created).toHaveLength(1);
    expect(edited).toEqual(['comment-1']);
  });

  it('with liveComment=false keeps transition comments exactly as before', async () => {
    const src = new FakeSource() as FakeSource & {
      createLiveComment: (key: string, body: string) => Promise<string>;
      editLiveComment: (key: string, id: string, body: string) => Promise<void>;
    };
    let created = 0;
    src.createLiveComment = async () => { created++; return 'comment-1'; };
    src.editLiveComment = async () => {};
    src.items = [item('fake:disabled')];
    const st = new PickupState();
    await dispatchLoop(src, st);
    const uuid = st.get('fake:disabled')!.uuid;
    claimNext('work');
    appendStatus(uuid, 'work', 'working');
    await reportLoop(src, st, () => {}, () => {}, false);
    appendStatus(uuid, 'work', 'done');
    await reportLoop(src, st, () => {}, () => {}, false);
    expect(created).toBe(0);
    expect(src.reports.map((r) => r.verb)).toEqual(['working', 'done']);
  });

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

  it("walks only its own keys in the shared ledger — never another source's", async () => {
    // Linear and GitHub share one ledger. Before owns(), each source's
    // inbound() threw on the other's keys and the loop never got past them.
    const linear = new FakeSource();
    linear.owned = (k) => k.startsWith('linear:');
    const github = new FakeSource();
    github.owned = (k) => k.startsWith('gh:o/r#');
    linear.items = [item('linear:DEMO-10')];
    github.items = [item('gh:o/r#pr7@rv1', 'review')];
    const st = new PickupState();
    await dispatchLoop(linear, st);
    await dispatchLoop(github, st);
    for (const key of ['linear:DEMO-10', 'gh:o/r#pr7@rv1']) {
      claimNext('work');
      appendStatus(st.get(key)!.uuid, 'work', 'working');
    }
    await reportLoop(linear, st);
    await reportLoop(github, st);
    expect(linear.reports.map((r) => r.key)).toEqual(['linear:DEMO-10']);
    expect(github.reports.map((r) => r.key)).toEqual(['gh:o/r#pr7@rv1']);
    expect(linear.inboundKeys).toEqual(['linear:DEMO-10']);
    expect(github.inboundKeys).toEqual(['gh:o/r#pr7@rv1']);
  });

  it('one unreachable item does not starve the rest of the ledger', async () => {
    const src = new FakeSource();
    src.items = [item('fake:gone'), item('fake:ok')];
    const st = new PickupState();
    await dispatchLoop(src, st);
    for (const key of ['fake:gone', 'fake:ok']) {
      claimNext('work');
      appendStatus(st.get(key)!.uuid, 'work', 'working');
    }
    src.inbound = async (key: string) => {
      if (key === 'fake:gone') throw new Error('Entity not found: Issue');
      return [];
    };
    await expect(reportLoop(src, st)).rejects.toThrow('fake:gone: Entity not found: Issue');
    expect(st.get('fake:ok')!.lastReported).toBe('working');
  });
});

describe('pickup cycle', () => {
  it('reconciles even when the report loop throws', async () => {
    const src = new FakeSource();
    src.items = [item('fake:r1')];
    const st = new PickupState();
    await dispatchLoop(src, st);
    claimNext('work');
    appendStatus(st.get('fake:r1')!.uuid, 'work', 'working');
    src.items = [];
    src.inbound = async () => { throw new Error('tracker hiccup'); };
    src.tracked = [{ key: 'fake:orphan', open: true }];
    const logs: string[] = [];
    await cycle([src], [], st, 60, (m) => logs.push(m), () => {});
    expect(logs.some((m) => m.includes('fake:r1: tracker hiccup'))).toBe(true);
    expect(src.resets).toEqual(['fake:orphan']);
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
  reviewRequests: Array<{ n: number; reviewers: string[] }> = [];
  comments: Array<{ n: number; text: string }> = [];
  labels: Array<{ n: number; label: string }> = [];

  dispositions: Record<number, 'open' | 'merged' | 'closed'> = {};

  async mergeCandidates() { return this.candidates; }
  async refresh(n: number) { return this.candidates.find((c) => c.number === n); }
  async updateBranch(n: number) { this.updated.push(n); }
  async requestReview(n: number, reviewers: string[]) { this.reviewRequests.push({ n, reviewers }); }
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
  it('finds only qualifying stale approvers and never the author', () => {
    expect(staleApprovals(policy, pr({ reviews: [
      { id: 10, author: 'chris', state: 'APPROVED', sha: 'old' },
      { id: 11, author: 'alice', state: 'APPROVED', sha: 'older' },
      { id: 12, author: 'bob', state: 'APPROVED', sha: 'old' },
      { id: 13, author: 'lobstah-bot', state: 'APPROVED', sha: 'old' },
    ] }))).toEqual(['chris', 'alice']);
  });
  it('an outstanding change request suppresses every stale approval', () => {
    expect(staleApprovals(policy, pr({ reviews: [
      { id: 10, author: 'chris', state: 'APPROVED', sha: 'old' },
      { id: 11, author: 'bob', state: 'CHANGES_REQUESTED', sha: 'abc' },
    ] }))).toEqual([]);
  });
  it('non-qualifying and author approvals alone are not stale approval signals', () => {
    expect(staleApprovals(policy, pr({ reviews: [
      { id: 10, author: 'bob', state: 'APPROVED', sha: 'old' },
      { id: 11, author: 'lobstah-bot', state: 'APPROVED', sha: 'old' },
    ] }))).toEqual([]);
  });
});

describe('merge loop', () => {
  it('re-requests a stale approval once per head and distinguishes a never-approved PR', async () => {
    const ms = new FakeMergeSource();
    const stale = pr({ reviews: [{ id: 10, author: 'alice', state: 'APPROVED', sha: 'old' }] });
    const never = pr({ number: 2, url: 'https://x/pr/2', reviews: [] });
    ms.candidates = [stale, never];
    const st = new PickupState();
    await mergeLoop(ms, policy, st);
    expect(ms.reviewRequests).toEqual([{ n: 1, reviewers: ['alice'] }]);
    expect(readMergeView()!.open.map((p) => [p.number, p.gate])).toEqual([
      [1, 'stale-approval'], [2, 'waiting-approval'],
    ]);
    await mergeLoop(ms, policy, st);
    expect(ms.reviewRequests).toHaveLength(1);
    stale.headSha = 'new-head';
    await mergeLoop(ms, policy, st);
    expect(ms.reviewRequests).toEqual([
      { n: 1, reviewers: ['alice'] }, { n: 1, reviewers: ['alice'] },
    ]);
    expect(new PickupState().reviewRequested('fake-merge#1', 'new-head')).toBe(true);
  });

  it('records the head even if a stale review re-request is refused', async () => {
    const ms = new FakeMergeSource();
    ms.candidates = [pr({ reviews: [{ id: 10, author: 'alice', state: 'APPROVED', sha: 'old' }] })];
    let attempts = 0;
    ms.requestReview = async () => { attempts++; throw new Error('reviewer unavailable'); };
    const notes: string[] = [];
    const st = new PickupState();
    await mergeLoop(ms, policy, st, (note) => notes.push(note));
    await mergeLoop(ms, policy, st, (note) => notes.push(note));
    expect(attempts).toBe(1);
    expect(notes.some((note) => note.includes('review re-request refused: reviewer unavailable'))).toBe(true);
    expect(readMergeView()!.open[0]?.gate).toBe('stale-approval');
  });

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
    expect(desc.brief).toMatch(/^Bring the branch \S+ of https:\/\/x\/pr\/1 up to date with its base branch/);
    expect(desc.followUp).toBeUndefined(); // rebase chores start cold on purpose
    // Bound to the PR: the runner pushes no other branch and opens no PR.
    expect(desc.pr).toEqual({ url: 'https://x/pr/1', headRefName: 'lobstah/33333333-3333-3333-3333-333333333333', headSha: 'abc' });
    expect(desc.brief).toContain(`lobstah report ${chores[0]} failed "push rejected:`);
    expect(desc.brief).toContain('Never open a new PR.');
  });

  it('a standalone PR (based on trunk) merges its base in; a stacked PR rebases onto its base', async () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[repos.demo]\npath = "/d"\ntrunk = "main"\n');
    const ms = new FakeMergeSource();
    ms.candidates = [pr({ mergeableState: 'dirty', baseRef: 'main' })];
    await mergeLoop(ms, policy, new PickupState());
    const standalone = readChore(pendingIds('chore')[0]!).brief;
    expect(standalone).toContain('merge it into');
    expect(standalone).toContain('git merge origin/main');
    expect(standalone).toContain('Never force-push.');
    expect(standalone).not.toContain('--force-with-lease');
    expect(rebaseBrief({ ...pr(), baseRef: 'feature/parent' }, 'x', 'main')).toContain('stacked on its base branch feature/parent');
    expect(rebaseBrief({ ...pr(), baseRef: 'feature/parent' }, 'x', 'main')).toContain('--force-with-lease');
  });

  it('reviewed and unreviewed rebase briefs report done; the gate owns review requests', () => {
    const reviewed = rebaseBrief(pr({ reviews: [
      { id: 10, author: 'alice', state: 'APPROVED', sha: 'abc' },
      { id: 11, author: 'bob', state: 'CHANGES_REQUESTED', sha: 'abc' },
      { id: 12, author: 'alice', state: 'COMMENTED', sha: 'abc' },
    ] }), 'c1', 'main');
    expect(reviewed).toContain('When pushed, report status done.');
    expect(reviewed).not.toContain('paused');
    expect(reviewed).not.toContain('re-request');
    expect(reviewed).not.toContain('--add-reviewer');
    const fresh = rebaseBrief(pr({ reviews: [] }), 'c2', 'main');
    expect(fresh).toContain('When pushed, report status done.');
    expect(fresh).not.toContain('re-request review');
  });

  it.each(['done', 'paused'] as const)('%s rebase with a moved head re-enters the approval gate and merges without a failure', async (verb) => {
    const ms = new FakeMergeSource();
    const candidate = pr({ mergeableState: 'dirty', url: 'https://github.com/demo/demo/pull/1' });
    ms.candidates = [candidate];
    const st = new PickupState();
    const notes: string[] = [];
    await mergeLoop(ms, policy, st);
    const id = pendingIds('chore')[0]!;
    claimNext('chore');
    appendStatus(id, 'chore', verb, 'pushed', undefined, verb === 'paused' ? { waitingOn: 'review', link: candidate.url } : undefined);
    // Even while the runner's directory remains active, it holds no chore slot.
    expect(slotUsage('chore')).toEqual({ headless: 0, traps: 0, parked: verb === 'paused' ? 1 : 0 });
    candidate.headSha = 'pushed-head';
    candidate.mergeableState = 'clean';
    await mergeLoop(ms, policy, st, (note) => notes.push(note));
    expect(st.rebase('fake-merge#1')).toBeUndefined();
    expect(readMergeView()!.open[0]?.gate).toBe('stale-approval');
    expect(ms.reviewRequests).toEqual([{ n: 1, reviewers: ['alice'] }]);
    await mergeLoop(ms, policy, st, (note) => notes.push(note));
    expect(ms.reviewRequests).toHaveLength(1);
    if (verb === 'paused') {
      expect(notes.filter((note) => note.includes('paused on review')).length).toBe(1);
    }
    candidate.reviews = [{ id: 11, author: 'alice', state: 'APPROVED', sha: candidate.headSha }];
    await mergeLoop(ms, policy, st);
    expect(ms.merged).toEqual([1]);
    expect(ms.labels).toEqual([]);
    expect(ms.comments).toEqual([]);
  });

  it.each(['done', 'paused'] as const)('%s rebase with an unchanged dirty head fails once, without another chore', async (verb) => {
    const ms = new FakeMergeSource();
    ms.candidates = [pr({ mergeableState: 'dirty' })];
    const st = new PickupState();
    await mergeLoop(ms, policy, st);
    const id = pendingIds('chore')[0]!;
    claimNext('chore');
    appendStatus(id, 'chore', verb, 'claimed push', undefined, verb === 'paused' ? { waitingOn: 'review' } : undefined);
    await mergeLoop(ms, policy, st);
    await mergeLoop(ms, policy, st);
    expect(ms.labels).toEqual([{ n: 1, label: 'needs-human' }]);
    expect(ms.comments).toEqual([{ n: 1, text: `Automated rebase failed (dispatch ${id}) — needs a human.` }]);
    expect(pendingIds('chore')).toHaveLength(0);
    expect(readMergeView()!.open[0]?.gate).toBe('rebase-failed');
    expect(ms.merged).toEqual([]);
  });

  it.each(['queue', 'done'] as const)('a pushed review pause wins over its %s bucket', async (bucket) => {
    const ms = new FakeMergeSource();
    const candidate = pr({ mergeableState: 'dirty' });
    ms.candidates = [candidate];
    const st = new PickupState();
    await mergeLoop(ms, policy, st);
    const id = pendingIds('chore')[0]!;
    if (bucket === 'done') {
      claimNext('chore');
      fs.renameSync(path.join(home, 'chores', 'active', id), path.join(home, 'chores', 'done', id));
    }
    appendStatus(id, 'chore', 'paused', 'pushed', undefined, { waitingOn: 'review' });
    candidate.headSha = 'new-head';
    candidate.mergeableState = 'clean';
    await mergeLoop(ms, policy, st);
    expect(st.rebase('fake-merge#1')).toBeUndefined();
    expect(readMergeView()!.open[0]?.gate).toBe('stale-approval');
    expect(ms.labels).toEqual([]);
    expect(ms.comments).toEqual([]);
  });

  it.each(['pr', 'deploy', 'person', 'external'] as const)('a chore paused on %s still holds its PR', async (waitingOn) => {
    const ms = new FakeMergeSource();
    ms.candidates = [pr({ mergeableState: 'dirty' })];
    const st = new PickupState();
    await mergeLoop(ms, policy, st);
    const id = pendingIds('chore')[0]!;
    claimNext('chore');
    appendStatus(id, 'chore', 'paused', 'still waiting', undefined, { waitingOn });
    await mergeLoop(ms, policy, st);
    expect(readMergeView()!.open[0]?.gate).toBe(`conflict-chore:${id}`);
    expect(st.rebase('fake-merge#1')?.uuid).toBe(id);
    expect(ms.labels).toEqual([]);
    expect(ms.comments).toEqual([]);
    expect(ms.merged).toEqual([]);
  });

  it("a rebase chore ends with the repo's rebase hook, then its all hook", async () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[repos.demo]\npath = "/d"\n[repos.demo.briefHooks]\nrebase = "Run the rebase refresh."\nall = "Run /pr-refresh."\nchecks = "not this one"\n');
    const ms = new FakeMergeSource();
    ms.candidates = [pr({ mergeableState: 'dirty' })];
    await mergeLoop(ms, policy, new PickupState());
    const desc = readChore(pendingIds('chore')[0]!);
    expect(desc.brief.endsWith('\n\nRun the rebase refresh.\n\nRun /pr-refresh.')).toBe(true);
    expect(desc.brief).not.toContain('not this one');
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

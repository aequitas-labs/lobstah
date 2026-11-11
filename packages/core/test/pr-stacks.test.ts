import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cutPrTitle, derivePrStacks, ensureLayout, laneDirs, prKeyLabel, prLabel, prNote, prStackTitle, listNotices, loadConfig, postNotice, readStackEpochs, syncStackReadiness, unseenNotices, upsertPr } from '../src/index.js';
import type { PrEvidence } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const time = Date.parse('2026-10-07T12:00:00Z');
const row = (n: number, over: Partial<PrEvidence> = {}): PrEvidence => ({
  url: `https://github.com/acme/web/pull/${n}`, number: n, state: 'OPEN', draft: false,
  headSha: `sha-${n}`, headRefName: `b${n}`, baseRefName: n === 1 ? 'main' : `b${n - 1}`,
  reviewDecision: '', mergeStateStatus: 'CLEAN', checks: { total: 1, passed: 1, failed: 0, pending: 0 },
  observedAt: new Date(time).toISOString(), ...over,
});
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-stack-ready-'));
  process.env.LOBSTAH_HOME = home; ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), 'readySettleSecs = 0\n');
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });
const sync = () => syncStackReadiness(loadConfig(), time);
const readyNotices = () => listNotices(100).filter((n) => n.kind === 'stack-ready');

describe('stack detection and readiness', () => {
  it('finds a chain bottom to top, not a lone PR', () => {
    expect(derivePrStacks([row(3), row(1), row(2)])[0]?.members.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(derivePrStacks([row(1)])).toEqual([]);
  });
  it('updates one stable item as a ready stack grows and partially merges', () => {
    [1, 2].forEach((n) => upsertPr(row(n))); sync();
    const id = readyNotices()[0]!.refId;
    expect(unseenNotices(true)).toHaveLength(1);
    upsertPr(row(3)); sync();
    expect(readyNotices()).toHaveLength(1);
    expect(readyNotices()[0]).toMatchObject({ refId: id, text: expect.stringContaining('#1 → #2 → #3') });
    expect(unseenNotices(true)).toHaveLength(1);
    upsertPr(row(1, { state: 'MERGED' })); upsertPr(row(2, { baseRefName: 'main' })); sync();
    expect(readyNotices()).toHaveLength(1);
    expect(readyNotices()[0]!.refId).toBe(id);
    expect(unseenNotices(true)).toEqual([]);
  });
  it('a PR added to a notified stack replaces its notice once, naming the added PR', () => {
    [1, 2].forEach((n) => upsertPr(row(n, { baseRefName: n === 1 ? 'v12' : 'b1' }))); sync();
    expect(unseenNotices(true)).toEqual([expect.objectContaining({ text: expect.stringMatching(/^stack ready to merge: acme\/web #1 → #2/) })]);
    upsertPr(row(3, { draft: true })); sync();
    upsertPr(row(3)); sync(); sync();
    expect(readyNotices()).toHaveLength(1);
    expect(unseenNotices(true)).toEqual([expect.objectContaining({ text: expect.stringMatching(/^Stack updated · #3 added — stack ready to merge: acme\/web #1 → #2 → #3/) })]);
    // A member that turns unready and back names the stack's range instead.
    upsertPr(row(2, { mergeStateStatus: 'DIRTY' })); sync(); upsertPr(row(2)); sync();
    expect(readyNotices()).toHaveLength(1);
    expect(unseenNotices(true)).toEqual([expect.objectContaining({ text: expect.stringMatching(/^Stack updated · #1–#3 — stack ready/) })]);
  });
  it('supersedes the ready notice immediately on growth, waking only after the new member is ready', () => {
    [1, 2].forEach((n) => upsertPr(row(n))); sync(); unseenNotices(true);
    const id = readyNotices()[0]!.refId;
    upsertPr(row(3, { draft: true })); sync();
    expect(readyNotices()).toEqual([expect.objectContaining({ refId: id, quiet: true, text: expect.stringContaining('stack waiting: 2 of 3 ready') })]);
    expect(unseenNotices(true)).toEqual([]);
    upsertPr(row(3)); sync(); sync();
    expect(readyNotices()).toHaveLength(1);
    expect(unseenNotices(true)).toHaveLength(1);
    sync(); expect(unseenNotices(true)).toEqual([]);
  });
  it('keeps its identity across branch renames/restacks with unchanged heads', () => {
    [1, 2, 3].forEach((n) => upsertPr(row(n))); sync(); unseenNotices(true);
    const id = readyNotices()[0]!.refId;
    [1, 2, 3].forEach((n) => upsertPr(row(n, { headRefName: `new-${n}`, baseRefName: n === 1 ? 'main' : `new-${n - 1}` }))); sync();
    expect(readyNotices()[0]!.refId).toBe(id);
    expect(unseenNotices(true)).toEqual([]);
  });
  it('never joins across repos, forks, or ambiguous siblings', () => {
    expect(derivePrStacks([row(1), row(2, { url: 'https://github.com/elsewhere/web/pull/2' })])).toEqual([]);
    expect(derivePrStacks([row(1), row(2, { isCrossRepository: true })])).toEqual([]);
    expect(derivePrStacks([row(1), row(2), row(9, { baseRefName: 'b1' })])).toEqual([]);
  });
  it('recognises a stack on any base branch, such as v12', () => {
    const numbers = (stacks: ReturnType<typeof derivePrStacks>) => stacks.map((s) => s.members.map((p) => p.number));
    expect(numbers(derivePrStacks([row(1, { baseRefName: 'v12' }), row(2), row(3)]))).toEqual([[1, 2, 3]]);
    // v12's own open PR to main has several stacks on it: each roots its own chain.
    const v12 = row(10, { headRefName: 'v12', baseRefName: 'main' });
    const other = [row(20, { headRefName: 'c20', baseRefName: 'v12' }), row(21, { headRefName: 'c21', baseRefName: 'c20' })];
    expect(numbers(derivePrStacks([v12, row(1, { baseRefName: 'v12' }), row(2), ...other]))).toEqual([[1, 2], [20, 21]]);
  });
  it("never puts v12's own PR under a chain: one open stack on v12, with merged PRs behind it", () => {
    const v12 = row(10, { headRefName: 'v12', baseRefName: 'main' });
    const merged = row(5, { headRefName: 'done', baseRefName: 'v12', state: 'MERGED' });
    const stacks = derivePrStacks([v12, merged, row(1, { baseRefName: 'v12' }), row(2)]);
    expect(stacks.map((s) => s.members.map((p) => p.number))).toEqual([[1, 2]]);
    expect(stacks[0]!.text).toContain('acme/web #1 → #2');
    // A closed attempt on a stack member's branch does not make it long-lived.
    const closed = row(7, { headRefName: 'b7', baseRefName: 'b1', state: 'CLOSED' });
    expect(derivePrStacks([row(1), closed, row(2), row(3)]).map((s) => s.members.map((p) => p.number))).toEqual([[1, 2, 3]]);
  });
  it('keeps a chain whose base is another open PR whole, not split at that PR', () => {
    const feature = row(1, { headRefName: 'feature', baseRefName: 'main' });
    const stacks = derivePrStacks([feature, row(2, { baseRefName: 'feature' }), row(3, { baseRefName: 'b2' })]);
    expect(stacks.map((s) => s.members.map((p) => p.number))).toEqual([[1, 2, 3]]);
  });
  it('uses the same ready rule, unknown checks and human gates never guessed green', () => {
    const bad = row(3, { draft: true });
    expect(derivePrStacks([row(1), row(2), bad])[0]).toMatchObject({ ready: 2, allReady: false, text: expect.stringContaining('— #3 draft') });
    for (const over of [
      { mergeStateStatus: 'DIRTY' }, { checks: { total: 1, passed: 0, failed: 1, pending: 0 } },
      { checks: { total: 0, passed: 0, failed: 0, pending: 0, unknown: 'no permission' as const } },
      { review: { changesRequested: true } },
    ]) expect(derivePrStacks([row(1), row(2, over)])[0]?.allReady).toBe(false);
  });
  it('wakes once for three PRs, across repeated scans and restarts', () => {
    [1, 2, 3].forEach((n) => upsertPr(row(n))); sync();
    expect(readyNotices()).toHaveLength(1);
    expect(unseenNotices(true).filter((n) => n.kind === 'stack-ready')).toHaveLength(1);
    sync(); sync();
    expect(unseenNotices(true)).toEqual([]);
    expect(readyNotices()[0]?.text).toContain('#1 → #2 → #3 (3 PRs, all green)');
    expect(readStackEpochs()['pr:acme/web#1']?.notified).toBe(true);
  });
  it.each([
    { draft: true }, { mergeStateStatus: 'DIRTY' },
    { checks: { total: 1, passed: 0, failed: 1, pending: 0 } },
  ])('re-notifies after an observed not-ready state clears: %j', (over) => {
    [1, 2, 3].forEach((n) => upsertPr(row(n))); sync();
    unseenNotices(true);
    upsertPr(row(2, over)); sync(); upsertPr(row(2)); sync(); sync();
    expect(readyNotices()).toHaveLength(1);
    expect(unseenNotices(true)).toHaveLength(1);
  });
  it('new heads settle, then re-notify once on a cadence scan without a forge event', () => {
    const cfg = { ...loadConfig(), readySettleSecs: 10 };
    [1, 2, 3].forEach((n) => upsertPr(row(n)));
    syncStackReadiness(cfg, time + 9000); expect(unseenNotices(true)).toHaveLength(0);
    syncStackReadiness(cfg, time + 10000); expect(readyNotices()).toHaveLength(1);
    expect(unseenNotices(true)).toHaveLength(1);
    upsertPr(row(2, { headSha: 'new', observedAt: new Date(time + 11000).toISOString() }));
    syncStackReadiness(cfg, time + 11000); expect(readyNotices()).toHaveLength(1);
    syncStackReadiness(cfg, time + 21000); syncStackReadiness(cfg, time + 22000);
    expect(readyNotices()).toHaveLength(1);
    expect(unseenNotices(true)).toHaveLength(1);
  });
  it('a member inside its settle window keeps the stack quiet: no notice wake, plain words', () => {
    const cfg = { ...loadConfig(), readySettleSecs: 600 };
    upsertPr(row(1)); upsertPr(row(2, { observedAt: new Date(time - 700_000).toISOString() }));
    syncStackReadiness(cfg, time);
    expect(readyNotices()).toEqual([expect.objectContaining({ quiet: true, text: 'stack waiting: 1 of 2 ready: acme/web #1 → #2 — #1 ready, confirming for 10 more min' })]);
    expect(unseenNotices(true)).toEqual([]);
    syncStackReadiness(cfg, time + 599_000); expect(unseenNotices(true)).toEqual([]);
    syncStackReadiness(cfg, time + 600_000);
    expect(unseenNotices(true)).toEqual([expect.objectContaining({ kind: 'stack-ready', text: expect.stringContaining('stack ready to merge') })]);
  });
  it('a 0-of-n stack never wakes, and names each member in plain words', () => {
    const cfg = { ...loadConfig(), readySettleSecs: 600 };
    upsertPr(row(1)); upsertPr(row(2, { mergeStateStatus: 'DIRTY' }));
    syncStackReadiness(cfg, time);
    expect(readyNotices()).toEqual([expect.objectContaining({
      quiet: true, text: 'stack waiting: 0 of 2 ready: acme/web #1 → #2 — #1 ready, confirming for 10 more min; #2 conflicts',
    })]);
    expect(unseenNotices(true)).toEqual([]);
    // #1 settles; the conflict still holds the stack: quiet, no wake.
    syncStackReadiness(cfg, time + 600_000);
    expect(readyNotices()).toEqual([expect.objectContaining({ quiet: true, text: 'stack waiting: 1 of 2 ready: acme/web #1 → #2 — #2 conflicts' })]);
    expect(unseenNotices(true)).toEqual([]);
  });
  it('bottom merges and retargets do not wake again for unchanged remaining heads', () => {
    [1, 2, 3].forEach((n) => upsertPr(row(n))); sync();
    upsertPr(row(1, { state: 'MERGED' })); sync(); // before GitHub retarget
    upsertPr(row(2, { baseRefName: 'main' })); sync(); sync();
    expect(readyNotices()).toHaveLength(1);
    expect(derivePrStacks([row(1, { state: 'MERGED' }), row(2, { baseRefName: 'main' }), row(3)])[0]?.members.map((p) => p.number)).toEqual([2, 3]);
  });
  it('follows pr:ready attention config, with an explicit stack-ready opt-in', () => {
    [1, 2, 3].forEach((n) => upsertPr(row(n)));
    syncStackReadiness({ ...loadConfig(), attentionKinds: ['question'] }, time);
    expect(readyNotices()[0]?.quiet).toBe(true); expect(unseenNotices(false)).toEqual([]);
    expect(loadConfig().attentionKinds).toContain('pr:ready');
    fs.writeFileSync(path.join(home, 'config.toml'), 'attentionKinds = ["stack-ready"]\n');
    expect(loadConfig().attentionKinds).toEqual(['stack-ready']);
  });
  it('never delivers stale or disabled stack notices, even before they were consumed', () => {
    [1, 2, 3].forEach((n) => upsertPr(row(n))); sync();
    upsertPr(row(2, { draft: true })); sync();
    expect(unseenNotices(false)).toEqual([]);
    upsertPr(row(2)); sync();
    expect(unseenNotices(false)).toHaveLength(1);
    fs.writeFileSync(path.join(home, 'config.toml'), 'attentionKinds = ["question"]\n');
    expect(unseenNotices(false)).toEqual([]);
  });
  it('a closed member invalidates an undelivered ready notice', () => {
    [1, 2, 3].forEach((n) => upsertPr(row(n))); sync();
    upsertPr(row(3, { state: 'CLOSED' })); sync();
    expect(unseenNotices(false).every((n) => n.refId !== 'pr:acme/web#3')).toBe(true);
  });
  it('collapses legacy shape notices without waking, then wakes on the next real change', () => {
    [1, 2, 3].forEach((n) => upsertPr(row(n)));
    fs.writeFileSync(path.join(home, 'pr-stacks.json'), JSON.stringify({
      'pr:acme/web#2': { heads: { 'pr:acme/web#1': 'sha-1', 'pr:acme/web#2': 'sha-2' }, ready: true, epoch: 0, at: new Date(time).toISOString(), notified: true },
      'pr:acme/web#3': { heads: { 'pr:acme/web#1': 'sha-1', 'pr:acme/web#2': 'sha-2', 'pr:acme/web#3': 'sha-3' }, ready: true, epoch: 0, at: new Date(time).toISOString(), notified: true },
    }));
    for (const n of [2, 3]) postNotice({ kind: 'stack-ready', refId: `pr:acme/web#${n}`, text: `old shape ${n}` });
    sync(); sync();
    expect(readyNotices()).toHaveLength(1);
    expect(readyNotices()[0]).toMatchObject({ refId: 'pr:acme/web#1', quiet: true, url: row(3).url });
    expect(Object.keys(readStackEpochs())).toEqual(['pr:acme/web#1']);
    expect(unseenNotices(true)).toEqual([]);
    upsertPr(row(2, { headSha: 'new' })); sync();
    expect(unseenNotices(true)).toHaveLength(1);
  });
});

describe('PR and stack titles', () => {
  /** A stored work dispatch, so a stack can take its name from the brief. */
  const dispatch = (id: string, brief: string, followUp?: string) => {
    const dir = path.join(laneDirs('work').done, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'descriptor.json'), JSON.stringify({ id, repo: 'web', brief, ...(followUp ? { followUp } : {}) }));
  };
  /** An observation from a PR record, naming the dispatches behind it. */
  const owned = (n: number, title: string | undefined, ...dispatches: string[]) =>
    ({ ...row(n), ...(title ? { title } : {}), dispatches });

  it('a PR shows its title beside its number, and its number alone without one', () => {
    expect(prLabel({ number: 7, title: 'Put job photos first' })).toBe('#7 Put job photos first');
    expect(prLabel({ number: 7 })).toBe('#7');
    expect(prNote({ number: 7, title: 'Put job photos first' }, 'draft')).toBe('#7 Put job photos first · draft');
    expect(prNote({ number: 7 }, 'draft')).toBe('#7 draft');
    expect(prKeyLabel('pr:o/r#7', 'Put job photos first')).toBe('pr:o/r#7 Put job photos first');
    expect(prKeyLabel('pr:o/r#7', undefined)).toBe('pr:o/r#7');
  });

  it('cuts a long title to its limit and keeps a title to one clean line', () => {
    const cut = prLabel({ number: 7, title: 'x'.repeat(200) });
    expect(Array.from(cut.slice('#7 '.length))).toHaveLength(48);
    expect(cut.endsWith('…')).toBe(true);
    expect(cutPrTitle('Fix\n\tthe \u001b[31mlogin\u001b[0m  test')).toBe('Fix the [31mlogin [0m test');
    expect(cutPrTitle(undefined)).toBe('');
  });

  it("a stack from no known dispatch takes its bottom PR's title", () => {
    const [s] = derivePrStacks([owned(1, 'Add the heavy line'), owned(2, 'Queue pushes'), owned(3, 'Show it in tend')], { now: time });
    expect(s).toMatchObject({ title: 'Add the heavy line', text: 'stack ready to merge: Add the heavy line (#1 → #3, 3 PRs, all green)', state: '3 PRs, all green' });
  });

  it('a waiting stack says the title, the count and what it waits on', () => {
    const [s] = derivePrStacks([owned(1, 'Add the heavy line'), { ...owned(2, 'Queue pushes'), draft: true }], { now: time });
    expect(s).toMatchObject({ text: 'stack waiting: Add the heavy line (#1 → #2, 1 of 2 ready) — #2 draft', state: '1 of 2 ready — #2 draft' });
  });

  it('a stack with no titles at all keeps its numbers', () => {
    const [s] = derivePrStacks([row(1), row(2)], { now: time });
    expect(s!.title).toBeUndefined();
    expect(s!.text).toBe('stack ready to merge: acme/web #1 → #2 (2 PRs, all green) — merge in this order, bottom first');
  });

  it("takes the name from the dispatch's brief heading, when every member came from it", () => {
    dispatch('d1', '# Heavy-check queue\n\nBuild it.');
    const [s] = derivePrStacks([owned(1, 'Add the heavy line', 'd1'), owned(2, 'Queue pushes', 'd1')], { now: time });
    expect(s).toMatchObject({ title: 'Heavy-check queue', text: 'stack ready to merge: Heavy-check queue (#1 → #2, 2 PRs, all green)' });
  });

  it('walks a follow-up back to the brief that has a heading, across one chain', () => {
    dispatch('root', '# Heavy-check queue\n\nPlan it.');
    dispatch('next', 'Follow-up instruction from helm on dispatch root:\nBuild it.', 'root');
    dispatch('last', 'Follow-up instruction from helm on dispatch next:\nFix the top.', 'next');
    const [s] = derivePrStacks([owned(1, 'Add the heavy line', 'next'), owned(2, 'Queue pushes', 'last')], { now: time });
    expect(s!.title).toBe('Heavy-check queue');
  });

  it("uses the bottom PR's title when the brief has no leading heading", () => {
    dispatch('d1', 'Follow-up instruction from helm:\n# not the name\nBuild it.');
    const [s] = derivePrStacks([owned(1, 'Add the heavy line', 'd1'), owned(2, 'Queue pushes', 'd1')], { now: time });
    expect(s!.title).toBe('Add the heavy line');
  });

  it("uses the bottom PR's title when the members came from different dispatches", () => {
    dispatch('d1', '# One thing');
    dispatch('d2', '# Another thing');
    const [s] = derivePrStacks([owned(1, 'Add the heavy line', 'd1'), owned(2, 'Queue pushes', 'd2')], { now: time });
    expect(s!.title).toBe('Add the heavy line');
  });

  it("uses the bottom PR's title when the dispatch also has an open PR outside the stack", () => {
    dispatch('d1', '# Everything at once');
    const other = { ...owned(9, 'Something else', 'd1'), headRefName: 'other', baseRefName: 'main' };
    const [s] = derivePrStacks([owned(1, 'Add the heavy line', 'd1'), owned(2, 'Queue pushes', 'd1'), other], { now: time });
    expect(s!.title).toBe('Add the heavy line');
  });

  it("a repair dispatch names nothing: the chore lane isn't read", () => {
    const dir = path.join(laneDirs('chore').active, 'r1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'descriptor.json'), JSON.stringify({ id: 'r1', repo: 'web', brief: '# Repair the PR' }));
    expect(prStackTitle([owned(1, 'Add the heavy line', 'r1')], [])).toBe('Add the heavy line');
  });

  it('the notice keeps the title, and a change note still leads', () => {
    upsertPr(owned(1, 'Add the heavy line')); upsertPr(owned(2, 'Queue pushes'));
    sync();
    expect(readyNotices()).toEqual([expect.objectContaining({ text: 'stack ready to merge: Add the heavy line (#1 → #2, 2 PRs, all green)' })]);
    upsertPr(owned(3, 'Show it in tend'));
    sync();
    expect(readyNotices()).toEqual([expect.objectContaining({ text: 'Stack updated · #3 added — stack ready to merge: Add the heavy line (#1 → #3, 3 PRs, all green)' })]);
  });
});

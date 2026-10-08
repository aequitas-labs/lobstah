import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { derivePrEvents, enqueue, ensureLayout, executorPath, listNotices, parsePrRef, pendingIds, prRecordFile, readPr, readPrs, readStatusLog, upsertPr } from '@lobstah/core';
import type { GhPrView, PrEvidence } from '@lobstah/core';
import { deriveGlassPrs } from '../src/glass-prs.js';
import { buildTendReport, renderTend } from '../src/tend.js';
import { cancelQueuedRepairs, manEvents, observePr, workEvents } from '../src/pr-watch.js';
import { applyCull, planCull } from '../src/cull.js';
import { prStateHash } from '../src/acks.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-prrec-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), 'readySettleSecs = 0\n');
  fs.writeFileSync(executorPath(), JSON.stringify({ heartbeat: new Date().toISOString() }));
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const url = (n: number) => `https://github.com/acme/lobstah/pull/${n}`;
const green = { total: 2, passed: 2, failed: 0, pending: 0 };
const obs = (n: number, over: Partial<PrEvidence> = {}): PrEvidence => ({
  url: url(n),
  number: n,
  state: 'OPEN',
  draft: false,
  reviewDecision: '',
  mergeStateStatus: 'CLEAN',
  headSha: `sha${n}`,
  baseRefName: 'main',
  headRefName: `branch-${n}`,
  checks: green,
  review: { unresolvedThreads: 0, changesRequested: false },
  observedAt: new Date().toISOString(),
  ...over,
});
/** The real stack's shape: #26 on main, each next PR based on the one below; #36 a draft on top. */
function realStack(): void {
  upsertPr(obs(26));
  upsertPr(obs(27, { baseRefName: 'branch-26' }));
  upsertPr(obs(29, { baseRefName: 'branch-27' }));
  upsertPr(obs(32, { baseRefName: 'branch-29' }));
  upsertPr(obs(33, { baseRefName: 'branch-32' }));
  upsertPr(obs(36, { baseRefName: 'main', draft: true }));
}

describe('PR records (core prs.ts)', () => {
  it('round-trips under a filename-safe key and merges later observations, appending a dispatch id once', () => {
    const first = upsertPr(obs(7, { title: 'the title' }), 'dispatch-a');
    expect(first.before).toBeUndefined();
    expect(path.basename(prRecordFile('pr:acme/lobstah#7'))).toBe('acme__lobstah__7.json');
    expect(readPr('pr:acme/lobstah#7')).toMatchObject({ key: 'pr:acme/lobstah#7', repo: 'acme/lobstah', number: 7, dispatches: ['dispatch-a'] });

    const second = upsertPr(obs(7, { draft: true, headSha: 'newsha' }), 'dispatch-a');
    expect(second.before?.headSha).toBe('sha7');
    expect(readPr('pr:acme/lobstah#7')).toMatchObject({ draft: true, headSha: 'newsha', title: 'the title', dispatches: ['dispatch-a'] });

    upsertPr(obs(7), 'dispatch-b');
    upsertPr(obs(7)); // a man-owned observation adds no id
    expect(readPr('pr:acme/lobstah#7')!.dispatches).toEqual(['dispatch-a', 'dispatch-b']);
    expect(readPrs()).toHaveLength(1);
  });

  it('keeps attention in standing order when observation times swap, then clears and restarts a kind', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), 'readySettleSecs = 0\nattentionKinds = ["pr:ready", "pr:draft", "pr:review"]\n');
    const first = '2026-09-24T10:00:00.000Z';
    const second = '2026-09-24T10:01:00.000Z';
    const third = '2026-09-24T10:02:00.000Z';
    upsertPr(obs(1, { observedAt: first }));
    upsertPr(obs(2, { observedAt: second }));
    const attention = () => buildTendReport().attention.filter((a) => a.kind.startsWith('pr:'));
    expect(attention().map((a) => a.number)).toEqual([1, 2]);
    expect(attention().map((a) => a.standingSince)).toEqual([first, second]);

    // The newest observation belongs to #1, but the older standing item
    // keeps its place. PR views still sort by their observation time.
    upsertPr(obs(1, { observedAt: '2026-09-24T10:04:00.000Z' }));
    upsertPr(obs(2, { observedAt: '2026-09-24T10:03:00.000Z' }));
    expect(attention().map((a) => a.number)).toEqual([1, 2]);
    expect(attention().map((a) => a.standingSince)).toEqual([first, second]);

    upsertPr(obs(3, { observedAt: third, draft: true }));
    expect(attention().map((a) => a.number)).toEqual([1, 2, 3]);
    expect(readPr('pr:acme/lobstah#3')?.standingSince).toEqual({ 'pr:draft': third });
    upsertPr(obs(3, { observedAt: '2026-09-24T10:05:00.000Z', draft: false, checks: { total: 0, passed: 0, failed: 0, pending: 0 } }));
    expect(readPr('pr:acme/lobstah#3')?.standingSince).toEqual({});
    upsertPr(obs(3, { observedAt: '2026-09-24T10:06:00.000Z', draft: true }));
    expect(readPr('pr:acme/lobstah#3')?.standingSince).toEqual({ 'pr:draft': '2026-09-24T10:06:00.000Z' });

    // Sparse evidence keeps the previous optional review field; its standing
    // timestamp must follow the merged record, not clear spuriously.
    upsertPr(obs(4, { observedAt: first, review: { unresolvedThreads: 1, changesRequested: false }, checks: { total: 0, passed: 0, failed: 0, pending: 0 } }));
    const sparse = obs(4, { observedAt: second, checks: { total: 0, passed: 0, failed: 0, pending: 0 } });
    delete sparse.review;
    upsertPr(sparse);
    expect(readPr('pr:acme/lobstah#4')?.standingSince).toEqual({ 'pr:review': first });
  });
});

describe('PR titles in records', () => {
  it('keeps a title; a later upsert with a new title replaces it; one without a title keeps it', () => {
    upsertPr(obs(8, { title: 'First title' }));
    expect(readPr('pr:acme/lobstah#8')?.title).toBe('First title');
    upsertPr(obs(8, { title: 'Renamed on GitHub' }));
    expect(readPr('pr:acme/lobstah#8')?.title).toBe('Renamed on GitHub');
    upsertPr(obs(8));
    expect(readPr('pr:acme/lobstah#8')?.title).toBe('Renamed on GitHub');
  });

  it('a title change alone does not change the stateHash, the standing kinds, or the watch events', () => {
    const { after: a } = upsertPr(obs(9, { title: 'Old' }));
    const { after: b } = upsertPr(obs(9, { title: 'New' }));
    expect(b.title).toBe('New');
    expect(prStateHash(b)).toBe(prStateHash(a));
    expect(b.standingSince).toEqual(a.standingSince);
    const ref = parsePrRef(url(9))!;
    const view: GhPrView = { title: 'Old', state: 'OPEN', isDraft: false, headRefOid: 'sha9', mergeStateStatus: 'CLEAN', reviewDecision: '', statusCheckRollup: [] };
    const first = derivePrEvents(ref, view, '0');
    const second = derivePrEvents(ref, { ...view, title: 'New' }, first.cursor);
    expect(second.events).toEqual([]);
    expect(second.cursor).toBe(first.cursor);
  });

  it('the observation stores the title the check fetched', () => {
    const ref = parsePrRef(url(10))!;
    const view: GhPrView = { title: 'From GitHub', state: 'OPEN', isDraft: false, headRefOid: 'sha10', mergeStateStatus: 'CLEAN', reviewDecision: '', statusCheckRollup: [] };
    expect(observePr(ref, view).title).toBe('From GitHub');
    expect(readPr(ref.key)?.title).toBe('From GitHub');
    expect(observePr(ref, { ...view, title: 'Edited' }).title).toBe('Edited');
  });
});

describe('stacks and kinds from records alone (no dispatch evidence)', () => {
  it('derives the stack and the next mergeable from records', () => {
    realStack();
    const { stacks, prs } = deriveGlassPrs([], [], readPrs());
    const stack = stacks.find((s) => s.numbers.includes(26))!;
    expect(stack.numbers).toEqual([26, 27, 29, 32, 33]);
    expect(stack.nextNumber).toBe(26);
    expect(prs.find((p) => p.number === 27)).toMatchObject({ blockedBy: 26, dispatchIds: [], repo: 'acme/lobstah' });
  });

  it('tend: the stack line, pr:draft for #36, quiet ready children and one stack item', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), 'readySettleSecs = 0\nattentionKinds = ["pr:ready", "pr:draft"]\n');
    realStack();
    const r = buildTendReport();
    expect(renderTend(r)).toContain('stack #26 → #27 → #29 → #32 → #33: next #26');
    const kinds = r.attention.map((a) => `${a.kind} ${a.number}`);
    expect(kinds).toContain('pr:draft 36');
    expect(kinds).toContain('pr:ready 26');
    for (const n of [26, 27, 29, 32, 33]) expect(r.attention.find((a) => a.number === n)).toMatchObject({ kind: 'pr:ready', quiet: true });
    expect(r.attention.filter((a) => a.kind === 'stack-ready')).toHaveLength(1);
    expect(r.attention.find((a) => a.number === 36)).toMatchObject({ key: 'pr:acme/lobstah#36', id: 'pr:acme/lobstah#36', repo: 'acme/lobstah' });
    expect(r.verdict).not.toBe('needs-attention');
  });

  it('a record wins over older dispatch evidence for the same PR (records first)', () => {
    upsertPr(obs(26, { draft: true }));
    const stale = { id: 'd1', pr: obs(26, { draft: false, observedAt: '2026-01-01T00:00:00Z' }) };
    const { prs } = deriveGlassPrs([stale], [], readPrs());
    expect(prs[0]).toMatchObject({ number: 26, draft: true, dispatchIds: ['d1'] });
  });
});

describe('man-owned PR watches are quiet unless something needs a human', () => {
  const ref = parsePrRef(url(9))!;
  const view = (over: Partial<GhPrView> = {}): GhPrView => ({
    state: 'OPEN',
    isDraft: false,
    headRefOid: 'abc1234',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    ...over,
  });

  it('a green check, a draft toggle, a merge-state change, and an approval deliver nothing', () => {
    const c = derivePrEvents(ref, view(), '0');
    expect(manEvents(c.events)).toEqual([]); // green check
    const flipped = derivePrEvents(ref, view({ isDraft: true, mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED' }), c.cursor);
    expect(flipped.events.map((e) => e.kind).sort()).toEqual(['draft', 'merge-state', 'review-decision']);
    expect(manEvents(flipped.events)).toEqual([]);
  });

  it('a failing check and a changes request are attention', () => {
    const baseline = derivePrEvents(ref, view(), '0');
    const failed = derivePrEvents(ref, view({ reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }] }), baseline.cursor);
    expect(manEvents(failed.events).map((e) => e.kind).sort()).toEqual(['check-completed', 'review-decision']);
    // the dispatch-owned filter beside it is unchanged
    expect(workEvents(ref, failed.events, false).map((e) => e.kind).sort()).toEqual(['check-completed', 'review-decision']);
  });

  it('merged: one notice from the record transition, no watch event — one carrier', () => {
    const open = derivePrEvents(ref, view(), '0');
    observePr(ref, view());
    const mergedView = view({ state: 'MERGED', mergedAt: '2026-09-23T18:00:00Z' });
    const merged = derivePrEvents(ref, mergedView, open.cursor);
    expect(merged.events.map((e) => e.kind)).toEqual(['merged']);
    expect(manEvents(merged.events)).toEqual([]);
    observePr(ref, mergedView);
    observePr(ref, mergedView); // re-observing a merged PR posts nothing more
    const notices = listNotices(50).filter((n) => n.kind === 'pr-merged');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ refId: 'pr:acme/lobstah#9' });
    expect(notices[0]!.text).toContain('no dispatch (watched by the helm)');
    expect(readPr(ref.key)!.state).toBe('MERGED');
  });

  it('first sight of a PR merged more than 24 hours ago records MERGED and posts no notice', () => {
    const now = new Date('2026-09-28T12:00:00Z');
    observePr(ref, view({ state: 'MERGED', mergedAt: '2026-09-20T12:00:00Z' }), { now });
    expect(readPr(ref.key)!.state).toBe('MERGED');
    expect(listNotices(50).filter((n) => n.kind === 'pr-merged')).toHaveLength(0);
  });

  it('first sight of a PR merged or closed within 24 hours posts one notice', () => {
    const now = new Date('2026-09-28T12:00:00Z');
    const mergedView = view({ state: 'MERGED', mergedAt: '2026-09-28T11:00:00Z' });
    observePr(ref, mergedView, { now });
    observePr(ref, mergedView, { now });
    expect(listNotices(50).filter((n) => n.kind === 'pr-merged')).toHaveLength(1);
    const other = parsePrRef('https://github.com/acme/lobstah/pull/10')!;
    observePr(other, view({ state: 'CLOSED', closedAt: '2026-09-28T11:30:00Z' }), { now });
    expect(listNotices(50).filter((n) => n.kind === 'pr-closed')).toHaveLength(1);
    expect(readPr(other.key)!.state).toBe('CLOSED');
  });
});

describe('cull', () => {
  it('removes records merged or closed longer than the window; never open ones', () => {
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    upsertPr(obs(1, { observedAt: old })); // open, old
    upsertPr(obs(2, { state: 'MERGED', observedAt: old }));
    upsertPr(obs(3, { state: 'CLOSED', observedAt: old }));
    upsertPr(obs(4, { state: 'MERGED' })); // merged, recent
    const plan = planCull(14).filter((i) => i.kind === 'pr');
    expect(plan.map((i) => i.id).sort()).toEqual(['pr:acme/lobstah#2', 'pr:acme/lobstah#3']);
    applyCull(plan);
    expect(readPrs().map((r) => r.number).sort()).toEqual([1, 4]);
  });
});

describe('a PR that merges or closes cancels its queued repairs', () => {
  it('only the repairs of that PR, and only those not yet claimed', () => {
    ensureLayout();
    const merged = parsePrRef('https://github.com/acme/web/pull/1854')!;
    const other = 'https://github.com/acme/web/pull/1855';
    enqueue({ id: 'aaaaaaaa-0000-4000-8000-000000001854', repo: 'r', brief: 'repair', systemRepair: {}, pr: { url: merged.url } }, 'chore');
    enqueue({ id: 'bbbbbbbb-0000-4000-8000-000000001855', repo: 'r', brief: 'repair', systemRepair: {}, pr: { url: other } }, 'chore');
    enqueue({ id: 'cccccccc-0000-4000-8000-000000001854', repo: 'r', brief: 'a chore, not a repair', pr: { url: merged.url } }, 'chore');
    const open: GhPrView = { title: 'T', state: 'OPEN', isDraft: false, headRefOid: 'sha1', mergeStateStatus: 'CLEAN', reviewDecision: '', statusCheckRollup: [] };
    observePr(merged, open);
    expect(pendingIds('chore')).toHaveLength(3);
    observePr(merged, { ...open, state: 'MERGED', mergedAt: new Date().toISOString() });
    expect(pendingIds('chore').sort()).toEqual(['bbbbbbbb-0000-4000-8000-000000001855', 'cccccccc-0000-4000-8000-000000001854']);
    expect(readStatusLog('aaaaaaaa-0000-4000-8000-000000001854', 'chore').at(-1)).toMatchObject({ verb: 'failed', note: 'cancelled before claim' });
    expect(cancelQueuedRepairs(parsePrRef(other)!.key)).toEqual(['bbbbbbbb-0000-4000-8000-000000001855']);
  });
});

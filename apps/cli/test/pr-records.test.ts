import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { derivePrEvents, ensureLayout, executorPath, listNotices, parsePrRef, prRecordFile, readPr, readPrs, upsertPr } from '@lobstah/core';
import type { GhPrView, PrEvidence } from '@lobstah/core';
import { deriveGlassPrs } from '../src/glass-prs.js';
import { buildTendReport, renderTend } from '../src/tend.js';
import { manEvents, observePr, workEvents } from '../src/pr-watch.js';
import { applyCull, planCull } from '../src/cull.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-prrec-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(executorPath(), JSON.stringify({ heartbeat: new Date().toISOString() }));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
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

  it('tend: the stack line, pr:draft for #36, pr:ready only for #26, verdict not needs-attention', () => {
    realStack();
    const r = buildTendReport();
    expect(renderTend(r)).toContain('stack #26 → #27 → #29 → #32 → #33: next #26');
    const kinds = r.attention.map((a) => `${a.kind} ${a.number}`);
    expect(kinds).toContain('pr:draft 36');
    expect(kinds).toContain('pr:ready 26');
    for (const n of [27, 29, 32, 33]) expect(kinds).not.toContain(`pr:ready ${n}`);
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
    const failed = derivePrEvents(ref, view({ reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }] }), '0');
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

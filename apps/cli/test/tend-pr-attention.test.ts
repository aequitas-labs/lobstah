import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addWatch,
  appendStatus,
  claimNext,
  complete,
  enqueue,
  ensureLayout,
  executorPath,
  loadConfig,
  markFollowUp,
  mergeEvidence,
} from '@lobstah/core';
import type { PrEvidence } from '@lobstah/core';
import { buildTendReport, onTheHook, prKinds, renderTend } from '../src/tend.js';
import { advanceCursor } from '../src/reported.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-attn-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(executorPath(), JSON.stringify({ heartbeat: new Date().toISOString() }));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

const Q = '11111111-1111-1111-1111-111111111111';
const P = '22222222-2222-2222-2222-222222222222';
const FIX = '33333333-3333-3333-3333-333333333333';
const URL_ = 'https://github.com/acme/web/pull/9';

const pr = (over: Partial<PrEvidence> = {}): PrEvidence => ({
  url: URL_,
  number: 9,
  state: 'OPEN',
  draft: false,
  reviewDecision: '',
  mergeStateStatus: 'BLOCKED',
  headSha: 'abc1234',
  checks: { total: 2, passed: 1, failed: 0, pending: 1 },
  review: { unresolvedThreads: 0, changesRequested: false },
  observedAt: new Date().toISOString(),
  ...over,
});

/** A done dispatch with a PR, whose evidence carries the given observation. */
function prDispatch(over: Partial<PrEvidence>): void {
  enqueue({ id: P, repo: 'web', brief: 'b' }, 'work');
  claimNext('work');
  appendStatus(P, 'work', 'done', 'opened');
  complete(P, 'work');
  mergeEvidence(P, 'work', { prUrl: URL_, pr: pr(over) });
}
const restamp = (over: Partial<PrEvidence>) => mergeEvidence(P, 'work', { pr: pr(over) });
const kinds = () => buildTendReport().attention.map((a) => a.kind);
const config = (toml: string) => fs.writeFileSync(path.join(home, 'config.toml'), toml);

describe('attention kinds — stand and clear', () => {
  it('question stands on needs-decision and clears on any newer status', () => {
    enqueue({ id: Q, repo: 'web', brief: 'b' }, 'work');
    appendStatus(Q, 'work', 'needs-decision', 'which color?');
    const r = buildTendReport();
    expect(r.attention).toEqual([expect.objectContaining({ kind: 'question', id: Q, verb: 'needs-decision', note: 'which color?' })]);
    expect(r.verdict).toBe('needs-attention');
    appendStatus(Q, 'work', 'working', 'answered');
    expect(kinds()).toEqual([]);
  });

  it('pr:draft stands while open and draft; clears on ready for review or merge', () => {
    prDispatch({ draft: true });
    const r = buildTendReport();
    expect(r.attention).toEqual([
      expect.objectContaining({ kind: 'pr:draft', id: P, verb: 'pr:draft', note: '#9 draft', prUrl: URL_, number: 9, draft: true }),
    ]);
    expect(r.verdict).not.toBe('needs-attention'); // things to look at never flip the verdict
    expect(renderTend(r)).toContain(`pr:draft,0,#9 draft ${URL_}`);
    restamp({ draft: false });
    expect(kinds()).toEqual([]);
    restamp({ draft: true, state: 'MERGED' });
    expect(kinds()).toEqual([]);
  });

  it('pr:review stands on unresolved threads or changes requested; clears when both are gone', () => {
    prDispatch({ review: { unresolvedThreads: 1, changesRequested: false } });
    expect(buildTendReport().attention).toEqual([
      expect.objectContaining({ kind: 'pr:review', note: '#9 review: 1 unresolved', review: { unresolvedThreads: 1, changesRequested: false } }),
    ]);
    restamp({ review: { unresolvedThreads: 0, changesRequested: true } });
    expect(kinds()).toEqual(['pr:review']);
    restamp({ review: { changesRequested: true } }); // a failed threads query: stands on changes-requested alone
    expect(kinds()).toEqual(['pr:review']);
    restamp({ review: { unresolvedThreads: 0, changesRequested: false } });
    expect(kinds()).toEqual([]);
  });

  it('pr:ready never stands beside pr:review', () => {
    prDispatch({ checks: { total: 1, passed: 1, failed: 0, pending: 0 }, review: { unresolvedThreads: 1, changesRequested: false } });
    expect(kinds()).toEqual(['pr:review']);
    restamp({ checks: { total: 1, passed: 1, failed: 0, pending: 0 }, review: { unresolvedThreads: 0, changesRequested: false } });
    expect(kinds()).toEqual(['pr:ready']);
  });

  it('pr:checks stands on a failed check at the head; clears on green or merge', () => {
    prDispatch({ checks: { total: 2, passed: 1, failed: 1, pending: 0 } });
    expect(buildTendReport().attention).toEqual([
      expect.objectContaining({ kind: 'pr:checks', note: '#9 checks 1/2 failed', headSha: 'abc1234' }),
    ]);
    restamp({ checks: { total: 2, passed: 2, failed: 0, pending: 0 } });
    expect(kinds()).toEqual(['pr:ready']); // green on the head: checks clears, ready stands
    restamp({ state: 'MERGED', checks: { total: 2, passed: 1, failed: 1, pending: 0 } });
    expect(kinds()).toEqual([]);
  });

  it('pr:ready stands when approved or all green with none pending; clears on merge or close', () => {
    prDispatch({ reviewDecision: 'APPROVED' }); // one check still pending — approval suffices
    expect(kinds()).toEqual(['pr:ready']);
    restamp({ reviewDecision: '', checks: { total: 2, passed: 1, failed: 0, pending: 1 } });
    expect(kinds()).toEqual([]); // not approved, a check pending
    restamp({ checks: { total: 2, passed: 2, failed: 0, pending: 0 } });
    expect(kinds()).toEqual(['pr:ready']);
    restamp({ checks: { total: 2, passed: 2, failed: 0, pending: 0 }, draft: true });
    expect(kinds()).toEqual(['pr:draft']); // a draft is never ready
    restamp({ checks: { total: 2, passed: 2, failed: 0, pending: 0 }, state: 'CLOSED' });
    expect(kinds()).toEqual([]);
  });

  it('landed (opt-in) stands past the grounds cursor and clears when man report moves it', () => {
    config('attentionKinds = ["question", "landed"]\n');
    enqueue({ id: Q, repo: 'web', brief: 'b' }, 'work');
    claimNext('work');
    appendStatus(Q, 'work', 'done', 'shipped');
    complete(Q, 'work');
    expect(buildTendReport().attention).toEqual([expect.objectContaining({ kind: 'landed', id: Q, verb: 'done', note: 'shipped' })]);
    expect(buildTendReport().verdict).not.toBe('needs-attention');
    advanceCursor('fleet', new Date(Date.now() + 1000).toISOString());
    expect(kinds()).toEqual([]);
  });

  it('landed reads the cursor of the grounds that owns the repo', () => {
    config('attentionKinds = ["landed"]\n[grounds.shop]\nrepos = ["web"]\n');
    enqueue({ id: Q, repo: 'web', brief: 'b' }, 'work');
    claimNext('work');
    appendStatus(Q, 'work', 'failed', 'broke');
    complete(Q, 'work');
    advanceCursor('fleet', new Date(Date.now() + 1000).toISOString()); // another cursor: no effect
    expect(kinds()).toEqual(['landed']);
    advanceCursor('shop', new Date(Date.now() + 1000).toISOString());
    expect(kinds()).toEqual([]);
  });
});

describe('the on-the-hook rule', () => {
  it('is pure: only pr:review / pr:checks, only while an owning chain member is queued or active', () => {
    const chain = [
      { id: 'root', bucket: 'done' as const },
      { id: 'fix', bucket: 'active' as const },
    ];
    const owners = { reviewRounds: new Set<string>(), watchFollowUp: 'fix' };
    expect(onTheHook('pr:checks', chain, owners)).toBe('fix');
    expect(onTheHook('pr:review', chain, owners)).toBe('fix');
    for (const k of ['pr:draft', 'pr:ready', 'question', 'landed'] as const) expect(onTheHook(k, chain, owners)).toBeUndefined();
    expect(onTheHook('pr:checks', [chain[0]!, { id: 'fix', bucket: 'done' }], owners)).toBeUndefined();
    expect(onTheHook('pr:review', [chain[0]!, { id: 'round', bucket: 'queued' }], { reviewRounds: new Set(['round']) })).toBe('round');
    // a chain member that is neither a round nor the watch's continuation owns nothing
    expect(onTheHook('pr:checks', [{ id: 'other', bucket: 'active' }], owners)).toBeUndefined();
  });

  it('a watch fix continuation in flight suppresses pr:checks; it reappears when that dispatch finishes unfixed', () => {
    prDispatch({ checks: { total: 2, passed: 1, failed: 1, pending: 0 }, draft: true });
    addWatch('pr:acme/web#9', 'true', { owner: `dispatch:${P}` });
    enqueue({ id: FIX, repo: 'web', brief: 'fix CI', followUp: P }, 'work');
    markFollowUp('pr:acme/web#9', FIX, 0);
    expect(kinds()).toEqual(['pr:draft']); // checks suppressed; draft never is
    claimNext('work');
    expect(kinds()).toEqual(['pr:draft']); // still in flight (active)
    appendStatus(FIX, 'work', 'done', 'pushed a fix');
    complete(FIX, 'work');
    expect(kinds()).toEqual(['pr:draft', 'pr:checks']); // head still red: back on the screen
  });

  it('a pickup feedback round in flight suppresses pr:review', () => {
    prDispatch({ review: { unresolvedThreads: 2, changesRequested: true } });
    enqueue({ id: FIX, repo: 'web', brief: 'address review', followUp: P }, 'work');
    fs.mkdirSync(path.join(home, 'pickup'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'pickup', 'state.json'),
      JSON.stringify({ map: { 'gh:acme/web#9:review:1': { uuid: FIX, kind: 'review', createdAt: new Date().toISOString() } } }),
    );
    expect(kinds()).toEqual([]);
    claimNext('work');
    appendStatus(FIX, 'work', 'done', 'addressed');
    complete(FIX, 'work');
    expect(kinds()).toEqual(['pr:review']);
  });
});

describe('attentionKinds (config.toml)', () => {
  it('defaults to everything but landed', () => {
    expect(loadConfig().attentionKinds).toEqual(['question', 'pr:draft', 'pr:review', 'pr:checks', 'pr:ready']);
  });

  it('filters what tend shows', () => {
    config('attentionKinds = ["pr:ready"]\n');
    prDispatch({ checks: { total: 1, passed: 1, failed: 0, pending: 0 } });
    enqueue({ id: Q, repo: 'web', brief: 'b' }, 'work');
    appendStatus(Q, 'work', 'blocked', 'stuck');
    const r = buildTendReport();
    expect(r.attention.map((a) => a.kind)).toEqual(['pr:ready']);
    expect(r.verdict).not.toBe('needs-attention'); // the hidden question no longer drives it
  });

  it('rejects an unknown kind, naming the valid set', () => {
    config('attentionKinds = ["question", "pr:merged"]\n');
    expect(() => loadConfig()).toThrow(/unknown kind "pr:merged".*question, landed, pr:draft, pr:review, pr:checks, pr:ready/);
  });

  it('prKinds is pure over one observation', () => {
    expect(prKinds(pr({ draft: true, checks: { total: 1, passed: 0, failed: 1, pending: 0 } }))).toEqual(['pr:draft', 'pr:checks']);
    expect(prKinds(pr({ checks: { total: 0, passed: 0, failed: 0, pending: 0 } }))).toEqual([]); // no checks, no approval: not ready
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, listNotices, pendingIds, readPr, stackMergeStep, upsertPr, writePr } from '@lobstah/core';
import type { PrEvidence, PrRecord } from '@lobstah/core';
import { PrMergeRefused, cancelStackMerge, mergeRequestedStacks, requestStackMerge, stackChain } from '../src/pr-merge.js';
import { deriveGlassPrs } from '../src/glass-prs.js';
import type { GithubApi } from '../src/pr-merge.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * "Merge stack when green" on the boat (pr-merge.ts): the request on the
 * stack's bottom PR, then each tick a repair, a link on GitHub for a plain
 * stack, and one merge-async for the whole stack once every PR is green.
 */

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-stackmerge-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    'readySettleSecs = 0\n[repos.web]\npath = "/missing"\norigin = "git@github.com:acme/web.git"\nmergeMethod = "merge"\n',
  );
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const url = (n: number) => `https://github.com/acme/web/pull/${n}`;
const key = (n: number) => `pr:acme/web#${n}`;
const obs = (n: number, over: Partial<PrEvidence> = {}): PrEvidence => ({
  url: url(n),
  number: n,
  title: `PR ${n}`,
  state: 'OPEN',
  draft: false,
  reviewDecision: '',
  mergeStateStatus: 'CLEAN',
  headSha: `sha${n}`,
  baseRefName: n === 41 ? 'main' : `branch-${n - 1}`,
  headRefName: `branch-${n}`,
  checks: { total: 2, passed: 2, failed: 0, pending: 0 },
  review: { unresolvedThreads: 0, changesRequested: false },
  observedAt: new Date().toISOString(),
  author: 'chris',
  ...over,
});
const me = () => 'chris';
/** The stack #41 → #42 → #43, each PR's base the branch of the one below. */
function stack(over: Record<number, Partial<PrEvidence>> = {}): PrRecord[] {
  return [41, 42, 43].map((n) => upsertPr(obs(n, over[n])).after);
}
const log: string[] = [];
const say = (m: string) => void log.push(m);

/** A fake GitHub: answers each call from a table, and records them. */
function github(answers: Partial<Record<string, ReturnType<GithubApi>>>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const api: GithubApi = (method, p, body) => {
    calls.push({ method, path: p, ...(body === undefined ? {} : { body }) });
    return answers[`${method} ${p}`] ?? { ok: false, why: `no answer for ${method} ${p}` };
  };
  return { api, calls };
}

describe('the stack a request names', () => {
  it('follows each PR whose base is the branch of the one below, bottom first', () => {
    const prs = stack();
    expect(stackChain(prs[0]!, prs).map((p) => p.number)).toEqual([41, 42, 43]);
    // A fork in the chain ends it there.
    const fork = upsertPr(obs(44, { baseRefName: 'branch-42', headRefName: 'branch-44' })).after;
    expect(stackChain(prs[0]!, [...prs, fork]).map((p) => p.number)).toEqual([41, 42]);
  });

  it('steps: merge when all are green, wait on any running check, repair a red one, and stop on a closed PR', () => {
    expect(stackMergeStep(stack())).toEqual({ kind: 'merge' });
    expect(stackMergeStep(stack({ 42: { checks: { total: 2, passed: 1, failed: 0, pending: 1 } } }))).toMatchObject({ kind: 'wait' });
    expect(stackMergeStep(stack({ 43: { checks: { total: 2, passed: 1, failed: 1, pending: 0 } } }))).toMatchObject({ kind: 'repair', why: 'checks' });
    expect(stackMergeStep(stack({ 42: { state: 'CLOSED' } }))).toEqual({ kind: 'closed', number: 42 });
    expect(stackMergeStep(stack({ 41: { state: 'MERGED' }, 42: { state: 'MERGED' }, 43: { state: 'MERGED' } }))).toEqual({ kind: 'done' });
  });
});

describe('asking for a stack merge', () => {
  it("stores it on the bottom PR with the repo's method and the stack's numbers, and cancels it", () => {
    stack();
    const request = requestStackMerge(key(41), 'glass', { viewer: me });
    expect(request).toMatchObject({ by: 'glass', method: 'merge', numbers: [41, 42, 43] });
    expect(readPr(key(41))!.stackMergeRequest).toEqual(request);
    expect(cancelStackMerge(key(41))).toBe('cancelled');
    expect(readPr(key(41))!.stackMergeRequest).toBeUndefined();
    expect(cancelStackMerge(key(41))).toBe('none');
  });

  it("refuses a lone PR, a stack with someone else's PR, and one it has no record of", () => {
    stack({ 43: { author: 'dana' } });
    expect(() => requestStackMerge(key(41), 'glass', { viewer: me })).toThrow(PrMergeRefused);
    expect(() => requestStackMerge(key(99), 'glass', { viewer: me })).toThrow(/no record/);
    upsertPr(obs(60, { baseRefName: 'main', headRefName: 'lone' }));
    expect(() => requestStackMerge(key(60), 'glass', { viewer: me })).toThrow(/lone PR/);
  });

  it('cannot be cancelled once GitHub has taken the merge', () => {
    stack();
    requestStackMerge(key(41), 'glass', { viewer: me });
    const root = readPr(key(41))!;
    writePr({ ...root, stackMergeRequest: { ...root.stackMergeRequest!, merging: { id: 'u1', number: 43, headSha: 'sha43', at: 'now' } } });
    expect(cancelStackMerge(key(41))).toBe('merging');
  });
});

describe('the glass snapshot', () => {
  it("names a stack's merge request, whether GitHub took it, and whether every PR is the person's", () => {
    stack();
    requestStackMerge(key(41), 'glass', { viewer: me });
    const records = [41, 42, 43].map((n) => readPr(key(n))!);
    const [s] = deriveGlassPrs([], [], records, {}, me).stacks;
    expect(s).toMatchObject({ id: key(41), mine: true, mergeRequest: { method: 'merge' } });
    expect(s!.mergeRequest!.merging).toBeUndefined();
    const root = records[0]!;
    const merging = { ...root, stackMergeRequest: { ...root.stackMergeRequest!, merging: { id: 'u', number: 43, headSha: 'sha43', at: 'now' } } };
    expect(deriveGlassPrs([], [], [merging, ...records.slice(1)], {}, me).stacks[0]!.mergeRequest).toMatchObject({ merging: true });
    // Someone else's PR in it: not the person's stack.
    expect(deriveGlassPrs([], [], records, {}, () => 'dana').stacks[0]!.mine).toBeUndefined();
  });
});

describe('the boat merging a stack', () => {
  beforeEach(() => void (log.length = 0));

  it('links a plain stack on GitHub, then asks GitHub to merge the top PR with the repo’s method on the head it checked', () => {
    stack();
    requestStackMerge(key(41), 'glass', { viewer: me });
    const gh = github({
      'GET repos/acme/web/pulls/43': { ok: true, json: { number: 43, stack: null } },
      'POST repos/acme/web/stacks': { ok: true, json: { number: 7 } },
      'PUT repos/acme/web/pulls/43/merge-async': { ok: true, json: { status: 'pending', details: { uuid: 'u-1' } } },
    });
    mergeRequestedStacks(say, { api: gh.api, now: Date.parse('2026-11-12T12:00:00Z') });
    expect(gh.calls).toEqual([
      { method: 'GET', path: 'repos/acme/web/pulls/43' },
      { method: 'POST', path: 'repos/acme/web/stacks', body: { pull_requests: [41, 42, 43] } },
      { method: 'PUT', path: 'repos/acme/web/pulls/43/merge-async', body: { merge_method: 'merge', sha: 'sha43', merge_action: 'default' } },
    ]);
    expect(readPr(key(41))!.stackMergeRequest).toMatchObject({
      linked: 7,
      merging: { id: 'u-1', number: 43, headSha: 'sha43', at: '2026-11-12T12:00:00.000Z' },
    });
  });

  it('skips the link for a stack GitHub already links', () => {
    stack();
    requestStackMerge(key(41), 'glass', { viewer: me });
    const gh = github({
      'GET repos/acme/web/pulls/43': { ok: true, json: { number: 43, stack: { number: 3, position: 3, size: 3 } } },
      'PUT repos/acme/web/pulls/43/merge-async': { ok: true, json: { status: 'pending', details: { uuid: 'u-2' } } },
    });
    mergeRequestedStacks(say, { api: gh.api });
    expect(gh.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET repos/acme/web/pulls/43', 'PUT repos/acme/web/pulls/43/merge-async']);
    expect(readPr(key(41))!.stackMergeRequest).toMatchObject({ linked: 3, merging: { id: 'u-2' } });
  });

  it('waits, calling GitHub for nothing, while a PR in the stack is not green', () => {
    stack({ 42: { checks: { total: 2, passed: 1, failed: 0, pending: 1 } } });
    requestStackMerge(key(41), 'glass', { viewer: me });
    const gh = github({});
    mergeRequestedStacks(say, { api: gh.api });
    expect(gh.calls).toEqual([]);
    expect(readPr(key(41))!.stackMergeRequest?.merging).toBeUndefined();
  });

  it('files one repair per head for a red PR no dispatch owns', () => {
    stack({ 43: { checks: { total: 2, passed: 1, failed: 1, pending: 0 } } });
    requestStackMerge(key(41), 'glass', { viewer: me });
    const gh = github({});
    mergeRequestedStacks(say, { api: gh.api });
    mergeRequestedStacks(say, { api: gh.api });
    expect(pendingIds('work')).toHaveLength(1);
    expect(readPr(key(41))!.stackMergeRequest!.repairs).toEqual({ 43: 'sha43' });
    expect(gh.calls).toEqual([]);
  });

  it('reads the merge GitHub took: failed tells the helm and clears it; every PR merged clears it', () => {
    stack();
    requestStackMerge(key(41), 'glass', { viewer: me });
    const root = readPr(key(41))!;
    writePr({ ...root, stackMergeRequest: { ...root.stackMergeRequest!, merging: { id: 'u-3', number: 43, headSha: 'sha43', at: 'now' } } });
    const pending = github({ 'GET repos/acme/web/pulls/43/merge-async/u-3': { ok: true, json: { status: 'pending', details: {} } } });
    mergeRequestedStacks(say, { api: pending.api });
    expect(readPr(key(41))!.stackMergeRequest?.merging?.id).toBe('u-3');
    const failed = github({ 'GET repos/acme/web/pulls/43/merge-async/u-3': { ok: true, json: { status: 'failed', details: { message: 'a required check failed' } } } });
    mergeRequestedStacks(say, { api: failed.api });
    expect(readPr(key(41))!.stackMergeRequest).toBeUndefined();
    expect(listNotices().some((n) => n.kind === 'stack-stopped' && n.text.includes('a required check failed'))).toBe(true);
    // A new request, and every PR merges.
    requestStackMerge(key(41), 'glass', { viewer: me });
    for (const n of [41, 42, 43]) upsertPr(obs(n, { state: 'MERGED' }));
    mergeRequestedStacks(say, { api: github({}).api });
    expect(readPr(key(41))!.stackMergeRequest).toBeUndefined();
    expect(log.at(-1)).toMatch(/^merged the stack through #43/);
  });

  it('stops, telling the helm, when a PR closes unmerged or GitHub won’t link the stack', () => {
    stack();
    requestStackMerge(key(41), 'glass', { viewer: me });
    const refused = github({
      'GET repos/acme/web/pulls/43': { ok: true, json: { number: 43 } },
      'POST repos/acme/web/stacks': { ok: false, why: 'HTTP 422: a PR is from a fork' },
    });
    mergeRequestedStacks(say, { api: refused.api });
    expect(readPr(key(41))!.stackMergeRequest).toBeUndefined();
    expect(listNotices().some((n) => n.text.includes('could not be linked as a stack on GitHub: HTTP 422'))).toBe(true);
    requestStackMerge(key(41), 'glass', { viewer: me });
    upsertPr(obs(42, { state: 'CLOSED' }));
    mergeRequestedStacks(say, { api: github({}).api });
    expect(readPr(key(41))!.stackMergeRequest).toBeUndefined();
    expect(listNotices().some((n) => n.text.includes('#42 closed without merging'))).toBe(true);
  });

  it('keeps the request when GitHub refuses the merge call, to try again next tick', () => {
    stack();
    requestStackMerge(key(41), 'glass', { viewer: me });
    const busy = github({
      'GET repos/acme/web/pulls/43': { ok: true, json: { number: 43, stack: { number: 3 } } },
      'PUT repos/acme/web/pulls/43/merge-async': { ok: false, why: 'HTTP 502' },
    });
    mergeRequestedStacks(say, { api: busy.api });
    expect(readPr(key(41))!.stackMergeRequest).toMatchObject({ linked: 3 });
    expect(readPr(key(41))!.stackMergeRequest!.merging).toBeUndefined();
    expect(log.at(-1)).toMatch(/will try again: HTTP 502/);
  });
});

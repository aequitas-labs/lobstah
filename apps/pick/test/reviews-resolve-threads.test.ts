import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, claimNext, ensureLayout, latestRound, observeReviewRequest, readReview, reviewRoundDir, writeReview } from '@lobstah/core';
import type { ReviewThread } from '@lobstah/core';
import { draftReviews } from '../src/loops/reviews.js';
import type { GhGraphql } from '../src/loops/reviews.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-resolve-threads-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), ['[reviews]', 'enabled = true', 'requestedAfter = "1970-01-01T00:00:00Z"', 'identity = "chris"',
    'mode = "auto-draft"', 'work = "headless"', '[repos.web]', 'path = "/w"'].join('\n'));
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const NOW = Date.parse('2026-11-18T12:00:00Z');
const KEY = 'review:acme/web#7';
const round = () => latestRound(readReview(KEY)!)!;
const thread = (id: string, author: string): ReviewThread => ({
  id, path: 'src/a.ts', line: 4, isOutdated: false, comments: [{ author, body: 'Possible race', url: `https://github.com/acme/web/pull/7#${id}` }],
});

/** A re-review job that judged two of Chris's threads fixed, one partly fixed, and Sam's thread fixed. */
function finishedJob(): void {
  observeReviewRequest({
    pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 't', author: 'dana', headSha: 'bbb', diffId: 'bbb', repoKey: 'web' },
    round: { id: 'RRE_7', requestedAt: '2026-11-18T11:00:00Z', requestedBy: 'dana' },
  }, NOW);
  draftReviews('chris', () => {}, NOW);
  const item = readReview(KEY)!;
  item.rounds[0]!.openThreads = [thread('T_one', 'chris'), thread('T_two', 'Chris'), thread('T_partly', 'chris'), thread('T_sam', 'sam')];
  writeReview(item);
  const id = round().dispatch!;
  claimNext('chore');
  const dir = reviewRoundDir(KEY, 'RRE_7')!;
  fs.writeFileSync(path.join(dir, 'review.md'), 'One more thing.');
  fs.writeFileSync(path.join(dir, 'comments.json'), JSON.stringify([{ path: 'src/b.ts', line: 2, body: 'Name this.' }]));
  fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ verdict: 'comment', blocking: [], threads: [
    { id: 'T_one', status: 'addressed', reason: 'The lock is held now.' },
    { id: 'T_two', status: 'addressed', reason: 'The retry is bounded.' },
    { id: 'T_partly', status: 'partly', reason: 'Only one caller is fixed.', reply: 'b.ts still races.' },
    { id: 'T_sam', status: 'addressed', reason: 'Fixed too.' },
  ] }));
  appendStatus(id, 'chore', 'done', 'drafted', '2026-11-18T12:10:00.000Z');
}

/**
 * A fake GitHub GraphQL: each thread's live author and resolved state, and a
 * resolve mutation that fails for ids in `failing`.
 */
function github(calls: Array<{ query: string; id: string }>, opts: { authors?: Record<string, string>; resolved?: string[]; failing?: string[] } = {}): GhGraphql {
  const authors: Record<string, string> = { T_one: 'chris', T_two: 'chris', T_partly: 'chris', T_sam: 'sam', ...opts.authors };
  return (request) => {
    const id = String(request.variables.id);
    calls.push({ query: request.query.startsWith('mutation') ? 'resolve' : 'check', id });
    if (request.query.startsWith('mutation')) {
      return opts.failing?.includes(id)
        ? { status: 1, stdout: JSON.stringify({ errors: [{ message: 'Resource not accessible by integration' }] }) }
        : { status: 0, stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } }) };
    }
    return { status: 0, stdout: JSON.stringify({ data: { node: { isResolved: opts.resolved?.includes(id) ?? false,
      pullRequest: { number: 7, repository: { nameWithOwner: 'acme/web' } }, comments: { nodes: [{ author: { login: authors[id] } }] } } } }) };
  };
}

const resolved = (calls: Array<{ query: string; id: string }>) => calls.filter(call => call.query === 'resolve').map(call => call.id);

describe('resolving fixed threads when a draft finishes', () => {
  it('resolves the reviewer’s own fully fixed threads at once, and keeps which, why and when', () => {
    finishedJob();
    const calls: Array<{ query: string; id: string }> = [];
    draftReviews('chris', () => {}, NOW + 600_000, undefined, { token: () => 'token', run: github(calls) });
    expect(resolved(calls)).toEqual(['T_one', 'T_two']);
    expect(calls.some(call => call.id === 'T_partly' || call.id === 'T_sam')).toBe(false);
    expect(round().state).toBe('drafted');
    expect(round().threadResolutions).toEqual([
      { id: 'T_one', path: 'src/a.ts', line: 4, url: 'https://github.com/acme/web/pull/7#T_one', reason: 'The lock is held now.', at: '2026-11-18T12:10:00.000Z' },
      { id: 'T_two', path: 'src/a.ts', line: 4, url: 'https://github.com/acme/web/pull/7#T_two', reason: 'The retry is bounded.', at: '2026-11-18T12:10:00.000Z' },
    ]);
  });

  it('checks live that the thread is still the reviewer’s, and records the refusal', () => {
    finishedJob();
    const calls: Array<{ query: string; id: string }> = [];
    draftReviews('chris', () => {}, NOW + 600_000, undefined, { token: () => 'token', run: github(calls, { authors: { T_two: 'sam' } }) });
    expect(resolved(calls)).toEqual(['T_one']);
    expect(round().threadResolutions![1]).toMatchObject({ id: 'T_two', failed: 'someone else opened the thread' });
  });

  it('leaves a thread that is already resolved alone, with no history entry', () => {
    finishedJob();
    const calls: Array<{ query: string; id: string }> = [];
    draftReviews('chris', () => {}, NOW + 600_000, undefined, { token: () => 'token', run: github(calls, { resolved: ['T_one'] }) });
    expect(resolved(calls)).toEqual(['T_two']);
    expect(round().threadResolutions!.map(entry => entry.id)).toEqual(['T_two']);
  });

  it('a failed resolve is reported on the round and the draft is still drafted', () => {
    finishedJob();
    const calls: Array<{ query: string; id: string }> = [];
    const log: string[] = [];
    draftReviews('chris', (line) => log.push(line), NOW + 600_000, undefined, { token: () => 'token', run: github(calls, { failing: ['T_one'] }) });
    expect(round().state).toBe('drafted');
    expect(round().threadResolutions).toMatchObject([{ id: 'T_one', failed: 'Resource not accessible by integration' }, { id: 'T_two' }]);
    expect(round().threadResolutions![1]!.failed).toBeUndefined();
    expect(log).toContain(`${KEY}: could not resolve https://github.com/acme/web/pull/7#T_one: Resource not accessible by integration`);
  });

  it('resolves nothing when the head moved while the job ran', () => {
    finishedJob();
    const item = readReview(KEY)!;
    Object.assign(item.pr, { headSha: 'ccc', diffId: 'ccc' });
    writeReview(item);
    const calls: Array<{ query: string; id: string }> = [];
    draftReviews('chris', () => {}, NOW + 600_000, undefined, { token: () => 'token', run: github(calls) });
    expect(round().state).toBe('stale');
    expect(calls).toEqual([]);
    expect(round().threadResolutions).toBeUndefined();
  });
});

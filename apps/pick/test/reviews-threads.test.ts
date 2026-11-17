import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, observeReviewRequest } from '@lobstah/core';
import { readOpenReviewThreads } from '../src/loops/reviews.js';
import type { GhGraphql } from '../src/loops/reviews.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-review-threads-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

const page = <T>(nodes: T[], endCursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } });
const comment = (author: string, body: string) => ({ author: { login: author }, body, url: `https://github.com/thread/${author}` });
const thread = (id: string, isResolved = false) => ({ id, path: 'a.ts', line: null, isOutdated: true, isResolved, comments: page([comment('reviewer', 'Possible race')]) });
const item = () => observeReviewRequest({
  pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 'Retry', author: 'dana', headSha: 'head' },
  round: { id: 'RRE_1', requestedAt: '2026-11-17T12:00:00Z' },
}).item;

describe('review thread memory', () => {
  it('reads all thread and reply pages, preserves author pushback and outdated anchors, and omits resolved threads', () => {
    const calls: Record<string, unknown>[] = [];
    const run: GhGraphql = request => {
      calls.push(request.variables);
      const data = request.variables.id
        ? { node: { comments: page([comment('dana', 'The caller serializes retries.')]) } }
        : { repository: { pullRequest: { reviewThreads: request.variables.cursor
          ? page([thread('last')])
          : page([{ ...thread('first'), comments: page([comment('reviewer', 'Possible race')], 'reply-page') }, thread('resolved', true)], 'thread-page') } } };
      return { status: 0, stdout: JSON.stringify({ data }) };
    };
    const threads = readOpenReviewThreads(item(), () => 'token', run, Date.now(), () => {});
    expect(threads?.map(value => value.id)).toEqual(['first', 'last']);
    expect(threads?.[0]).toMatchObject({ line: null, isOutdated: true, comments: [
      { author: 'reviewer', body: 'Possible race' }, { author: 'dana', body: 'The caller serializes retries.' },
    ] });
    expect(calls).toEqual([
      { owner: 'acme', repo: 'web', number: 7, cursor: null },
      { id: 'first', cursor: 'reply-page' },
      { owner: 'acme', repo: 'web', number: 7, cursor: 'thread-page' },
    ]);
  });

  it('does not pass off a failed reply page as complete context', () => {
    const run: GhGraphql = request => request.variables.id
      ? { status: 1, stdout: '', stderr: 'unavailable' }
      : { status: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: page([
        { ...thread('first'), comments: page([comment('reviewer', 'Possible race')], 'reply-page') },
      ]) } } } }) };
    expect(readOpenReviewThreads(item(), () => 'token', run, Date.now(), () => {})).toBeUndefined();
  });

  it('stops on repeated cursors instead of looping forever', () => {
    let calls = 0;
    const run: GhGraphql = () => {
      calls++;
      return { status: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: page([], 'same') } } } }) };
    };
    expect(readOpenReviewThreads(item(), () => 'token', run, Date.now(), () => {})).toBeUndefined();
    expect(calls).toBe(2);
  });
});

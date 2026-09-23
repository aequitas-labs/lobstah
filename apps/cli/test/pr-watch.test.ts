import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendStatus, derivePrEvents, enqueue, ensureLayout, listNotices, parsePrRef, readEvidence, readStatusLog, readWatch } from '@lobstah/core';
import type { GhPrView } from '@lobstah/core';
import { pickupOwnsReviewFeedback, stampPrEvidence, workEvents } from '../src/pr-watch.js';

// End to end against the built CLI (`pnpm build` runs before `pnpm test`):
// registration rides the report write path in main.ts.
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-prwatch-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

const lobstah = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, LOBSTAH_HOME: home }, timeout: 10_000 });

const ID = '44444444-4444-4444-4444-444444444444';
const URL_ = 'https://github.com/acme/web/pull/7';

describe('report done --pr registers the PR watch', () => {
  it('registers pr:<owner>/<repo>#<n> owned by the dispatch, with the shipped check and fix brief', () => {
    enqueue({ id: ID, repo: 'web', brief: 'b' }, 'work');
    const res = lobstah('report', ID, 'done', 'opened', '--pr', URL_);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('watch: pr:acme/web#7');
    const w = readWatch('pr:acme/web#7')!;
    expect(w.owner).toBe(`dispatch:${ID}`);
    expect(w.check).toContain(`watch check-pr 'pr:acme/web#7' --for '${ID}' --cursor {cursor}`);
    expect(w.brief).toContain(URL_);
    expect(w.brief).toContain('{summaries}');
  });

  it('is idempotent: an existing watch for the PR is left alone', () => {
    enqueue({ id: ID, repo: 'web', brief: 'b' }, 'work');
    lobstah('watch', 'add', 'pr:acme/web#7', '--check', 'echo custom');
    const res = lobstah('report', ID, 'done', '--pr', URL_);
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain('watch:');
    expect(readWatch('pr:acme/web#7')!.check).toBe('echo custom');
  });

  it('--no-watch opts out and stays out of the note', () => {
    enqueue({ id: ID, repo: 'web', brief: 'b' }, 'work');
    const res = lobstah('report', ID, 'done', 'shipped', '--pr', URL_, '--no-watch');
    expect(res.status).toBe(0);
    expect(readWatch('pr:acme/web#7')).toBeUndefined();
    const note = readStatusLog(ID, 'work').at(-1)?.note;
    expect(note).toBe('shipped');
  });

  it('a non-GitHub PR URL or a non-done verb registers nothing and never fails the report', () => {
    enqueue({ id: ID, repo: 'web', brief: 'b' }, 'work');
    expect(lobstah('report', ID, 'working', '--pr', URL_).status).toBe(0);
    expect(lobstah('report', ID, 'done', '--pr', 'https://gitlab.com/a/b/-/merge_requests/1').status).toBe(0);
    expect(fs.existsSync(path.join(home, 'watches')) ? fs.readdirSync(path.join(home, 'watches')) : []).toEqual([]);
  });

  it('watch add accepts a PR URL as sugar for the preset', () => {
    const res = lobstah('watch', 'add', URL_, '--for', ID);
    expect(res.status).toBe(0);
    expect(readWatch('pr:acme/web#7')!.check).toContain('watch check-pr');
  });
});

describe('evidence and routing', () => {
  const ref = parsePrRef(URL_)!;
  const view = (state: string): GhPrView => ({
    state,
    isDraft: false,
    headRefOid: 'abc1234',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'CHANGES_REQUESTED',
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }],
    mergedAt: state === 'MERGED' ? '2026-09-23T03:00:00Z' : null,
  });

  it('stamps the pr object without clobbering other evidence; open → merged posts one notice', () => {
    enqueue({ id: ID, repo: 'web', brief: 'b' }, 'work');
    appendStatus(ID, 'work', 'done', 'x');
    lobstah('report', ID, 'done', '--pr', URL_, '--no-watch');
    stampPrEvidence(ID, ref, view('OPEN'));
    expect(readEvidence(ID, 'work')).toMatchObject({ prUrl: URL_, pr: { state: 'OPEN', number: 7, checks: { failed: 1 } } });
    expect(listNotices(50).filter((n) => n.kind === 'pr-merged')).toHaveLength(0);
    stampPrEvidence(ID, ref, view('MERGED'));
    stampPrEvidence(ID, ref, view('MERGED')); // already merged: no second notice
    const merged = listNotices(50).filter((n) => n.kind === 'pr-merged');
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ refId: ID, repo: 'web' });
    expect(readEvidence(ID, 'work').prUrl).toBe(URL_);
  });

  it('a dispatch-owned watch emits only work: failed checks, and review decisions unless pickup owns review feedback', () => {
    const { events } = derivePrEvents(ref, view('MERGED'), '0');
    expect(events.map((e) => e.kind).sort()).toEqual(['check-completed', 'merged', 'review-decision']);
    expect(workEvents(ref, events, false).map((e) => e.kind)).toEqual(['check-completed', 'review-decision']);
    expect(workEvents(ref, events, true).map((e) => e.kind)).toEqual(['check-completed']);
  });

  it('pickup owns review feedback only for a repo [pickup.github] covers (docs/pickup.md "Feedback pickup")', () => {
    const cfg = path.join(home, 'config.toml');
    expect(pickupOwnsReviewFeedback('acme/web')).toBe(false); // no config at all
    fs.writeFileSync(cfg, '[pickup.github]\nrepo = "acme/web"\nkey = "web"\nidentity = "bot"\n');
    expect(pickupOwnsReviewFeedback('acme/web')).toBe(true);
    expect(pickupOwnsReviewFeedback('acme/other')).toBe(false);
    fs.writeFileSync(
      cfg,
      '[repos.web]\npath = "/tmp/web"\norigin = "git@github.com:acme/web.git"\npickup = true\n\n[repos.api]\npath = "/tmp/api"\norigin = "git@github.com:acme/api.git"\n\n[pickup.github]\nidentity = "bot"\n',
    );
    expect(pickupOwnsReviewFeedback('acme/web')).toBe(true);
    expect(pickupOwnsReviewFeedback('acme/api')).toBe(false);
  });
});

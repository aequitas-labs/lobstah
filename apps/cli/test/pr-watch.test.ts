import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  appendStatus,
  derivePrEvents,
  enqueue,
  ensureLayout,
  listNotices,
  listWatches,
  parsePrRef,
  readEvidence,
  readPr,
  readStatusLog,
  readWatch,
  runWatchCheck,
} from '@lobstah/core';
import type { GhPrView } from '@lobstah/core';
import { pickupOwnsReviewFeedback, stampPrEvidence, workEvents } from '../src/pr-watch.js';
import { removeTempDir } from '../../../test/temp-dir.js';

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
  removeTempDir(home);
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
    const quote = process.platform === 'win32' ? '"' : "'";
    expect(w.check).toContain(`watch check-pr ${quote}pr:acme/web#7${quote} --for ${quote}${ID}${quote} --cursor {cursor}`);
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

  it('a daemon repair report does not replace or create the PR watch', () => {
    enqueue(
      {
        id: ID,
        repo: 'web',
        brief: 'repair the existing PR',
        pr: { url: URL_, headRefName: 'feature' },
        systemRepair: {},
      },
      'chore',
    );
    const res = lobstah('report', ID, 'done', 'repaired', '--pr', URL_);
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain('watch:');
    expect(readWatch('pr:acme/web#7')).toBeUndefined();
    expect(readEvidence(ID, 'chore').prUrl).toBe(URL_);
  });

  it('a non-GitHub PR URL or a failed report registers nothing and never fails the report', () => {
    enqueue({ id: ID, repo: 'web', brief: 'b' }, 'work');
    expect(lobstah('report', ID, 'done', '--pr', 'https://gitlab.com/a/b/-/merge_requests/1').status).toBe(0);
    expect(lobstah('report', ID, 'failed', '--pr', URL_).status).toBe(0);
    expect(fs.existsSync(path.join(home, 'watches')) ? fs.readdirSync(path.join(home, 'watches')) : []).toEqual([]);
  });

  it('watch add accepts a PR URL as sugar for the preset', () => {
    const res = lobstah('watch', 'add', URL_, '--for', ID);
    expect(res.status).toBe(0);
    expect(readWatch('pr:acme/web#7')!.check).toContain('watch check-pr');
  });
});

describe('report --pr before done records the PR', () => {
  const watchKeys = () => listWatches().map((w) => w.key);

  it('working --pr records the PR and registers one watch; status and catch show it', () => {
    enqueue({ id: ID, repo: 'web', brief: 'b' }, 'work');
    const res = lobstah('report', ID, 'working', 'pushed', '--pr', URL_);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('watch: pr:acme/web#7');
    expect(readEvidence(ID, 'work').prUrl).toBe(URL_);
    expect(readWatch('pr:acme/web#7')!.owner).toBe(`dispatch:${ID}`);
    expect(lobstah('status', ID).stdout).toContain(`draftPr: ${URL_}`);
    expect(lobstah('catch', ID).stdout).toContain(`prUrl: ${URL_}`);
  });

  it('a second working --pr with the same URL registers nothing new', () => {
    enqueue({ id: ID, repo: 'web', brief: 'b' }, 'work');
    lobstah('report', ID, 'working', '--pr', URL_);
    const before = readWatch('pr:acme/web#7')!;
    const res = lobstah('report', ID, 'working', 'still going', '--pr', URL_);
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain('watch:');
    expect(watchKeys()).toEqual(['pr:acme/web#7']);
    expect(readWatch('pr:acme/web#7')).toEqual(before);
  });

  it('--no-watch records the PR without a watch', () => {
    enqueue({ id: ID, repo: 'web', brief: 'b' }, 'work');
    expect(lobstah('report', ID, 'working', '--pr', URL_, '--no-watch').status).toBe(0);
    expect(readEvidence(ID, 'work').prUrl).toBe(URL_);
    expect(watchKeys()).toEqual([]);
  });

  it('needs-decision, blocked, and paused --pr register the watch too', () => {
    enqueue({ id: ID, repo: 'web', brief: 'b' }, 'work');
    ['needs-decision', 'blocked', 'paused'].forEach((verb, i) => {
      expect(lobstah('report', ID, verb, 'waiting', '--pr', `https://github.com/acme/web/pull/${20 + i}`).status).toBe(0);
    });
    expect(watchKeys().sort()).toEqual(['pr:acme/web#20', 'pr:acme/web#21', 'pr:acme/web#22']);
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
    const baseline = derivePrEvents(ref, { ...view('OPEN'), reviewDecision: '', statusCheckRollup: [] }, '0');
    const { events } = derivePrEvents(ref, view('OPEN'), baseline.cursor);
    expect(events.map((e) => e.kind).sort()).toEqual(['check-completed', 'review-decision']);
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

// A `#!/bin/sh` gh stub on PATH: POSIX only.
describe.skipIf(process.platform === 'win32')('a PR watch without permission to read checks (stubbed gh)', () => {
  const VIEW = {
    state: 'OPEN',
    isDraft: false,
    headRefOid: 'abc1234def',
    baseRefName: 'main',
    headRefName: 'feat',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    reviews: [],
  };
  function stubGh(mode: 'checks-forbidden' | 'all-forbidden'): NodeJS.ProcessEnv {
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'gh'),
      `#!/bin/sh
case "$*" in *"api graphql"*) echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}'; exit 0 ;; esac
case "$*" in *statusCheckRollup*) echo 'GraphQL: Resource not accessible by integration (repository.pullRequest.statusCheckRollup)' >&2; exit 1 ;; esac
${mode === 'all-forbidden' ? `echo 'GraphQL: Resource not accessible by integration (repository.pullRequest)' >&2; exit 1` : `echo '${JSON.stringify(VIEW)}'`}
`,
    );
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
    return { ...process.env, LOBSTAH_HOME: home, PATH: `${bin}:${process.env.PATH}` };
  }
  const run = (env: NodeJS.ProcessEnv, ...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 10_000 });

  it('check-pr degrades: records the PR state with checks unknown, advances the cursor, and reports the error', () => {
    const env = stubGh('checks-forbidden');
    const res = run(env, 'watch', 'check-pr', 'pr:acme/web#12', '--cursor', '0');
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as { cursor: string; error?: string };
    expect(out.cursor).not.toBe('0');
    expect(out.error).toMatch(/^Resource not accessible by integration .*checks unknown, PR state recorded/);
    const rec = readPr('pr:acme/web#12')!;
    expect(rec.state).toBe('OPEN');
    expect(rec.reviewDecision).toBe('APPROVED');
    expect(rec.checks.unknown).toBe('no permission');
  });

  it("a failing check's reason reaches the watch's error field and tend's watches table", () => {
    const env = stubGh('all-forbidden');
    run(env, 'watch', 'add', 'pr:acme/web#12');
    const saved = process.env.PATH;
    process.env.PATH = env.PATH;
    try {
      const t0 = Date.parse('2026-09-28T00:00:00Z');
      for (let i = 0; i < 3; i++) runWatchCheck(readWatch('pr:acme/web#12')!, new Date(t0 + i * 3_600_000));
    } finally {
      process.env.PATH = saved;
    }
    const w = readWatch('pr:acme/web#12')!;
    expect(w.lastError).toBe('Resource not accessible by integration (repository.pullRequest) (fails even without check results)');
    expect(w.lastExit).toBe(1);
    expect(w.failures).toBe(3);
    expect(w.errorKind).toBe('permission');
    expect(listNotices(100).filter((n) => n.kind === 'watch-failing')).toHaveLength(1);
    const tend = run(env, 'man', 'tend');
    expect(tend.stdout).toContain('pr:acme/web#12');
    expect(tend.stdout).toContain('Resource not accessible by integration');
    expect(tend.stdout).toContain('failing since 2026-09-28T00:00:00.000Z');
  });
});

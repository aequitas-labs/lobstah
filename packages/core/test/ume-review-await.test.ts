import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendStatus, claimNext, enqueue, ensureLayout, isUmeAwaitFor, laneDirs, reviewStillOpenRefusal, reviewsStillOpen,
  umeArtifactsLinked, unwatchedReview, unwatchedReviewReason,
} from '../src/index.js';
import type { RunningCommand, StatusEntry, TrapRegistration, UmeApprovalReader } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const PLAN = 'dbbd03aa-434';
const OTHER = '64e82b46-3d2';
const HARNESS = 400;
let home: string;
let turnHome: string;
let trap: TrapRegistration;

/** A process table: the trap's harness, its shell, and whatever runs under them. */
function table(...extra: RunningCommand[]): () => RunningCommand[] {
  return () => [
    { pid: HARNESS, parent: 1, args: 'claude' },
    { pid: 401, parent: HARNESS, args: '/bin/zsh -c lobstah hook stop' },
    ...extra,
  ];
}
const nodeAwait = (pid: number, parent: number, artifact: string): RunningCommand =>
  ({ pid, parent, args: `node /Users/me/.ume-next/cli/bin/ume.js await --watch ${artifact}` });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-ume-review-'));
  turnHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-ume-turn-'));
  process.env.LOBSTAH_HOME = home;
  process.env.AGENT_TURN_HOME = turnHome;
  ensureLayout();
  trap = { trapId: 'seat', name: 'kind-crab', sessionId: 'session', harness: 'claude', worktree: home, cwd: home,
    claimed: 'job', repo: 'r', signedOnAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() };
  fs.writeFileSync(path.join(home, 'soaking', 'seat.json'), JSON.stringify(trap));
  enqueue({ id: 'job', repo: 'r', brief: 'b' }); claimNext('work');
  fs.writeFileSync(path.join(laneDirs('work').active, 'job', 'claim.json'), JSON.stringify({ by: 'wt:seat', sessionId: trap.sessionId, at: new Date().toISOString() }));
});
afterEach(() => { delete process.env.LOBSTAH_HOME; delete process.env.AGENT_TURN_HOME; removeTempDir(home); removeTempDir(turnHome); });

describe('umeArtifactsLinked', () => {
  it('reads hosted and local artifact links, each once, and nothing else', () => {
    expect(umeArtifactsLinked(`plan https://app.ume.so/a/${PLAN}.`, `http://127.0.0.1:8787/a/${OTHER} and https://app.ume.so/a/${PLAN}`))
      .toEqual([PLAN, OTHER]);
    expect(umeArtifactsLinked('https://github.com/o/r/pull/1', undefined)).toEqual([]);
  });
});

describe('isUmeAwaitFor', () => {
  it('matches the node process and the shell that runs it, for this artifact only', () => {
    expect(isUmeAwaitFor(nodeAwait(1, 1, PLAN).args, PLAN)).toBe(true);
    expect(isUmeAwaitFor(`/bin/zsh -c eval 'UME_PROJECT=p ume await --watch ${PLAN} --timeout 7000' < /dev/null`, PLAN)).toBe(true);
    expect(isUmeAwaitFor(`ume-next await ${PLAN} --turn-line --since 7`, PLAN)).toBe(true);
    expect(isUmeAwaitFor(`ume await --watch ${PLAN}0`, PLAN)).toBe(false);
    expect(isUmeAwaitFor(`ume await --park ${PLAN}`, PLAN)).toBe(false);
    expect(isUmeAwaitFor(`ume feedback ${PLAN}`, PLAN)).toBe(false);
  });
});

describe('unwatchedReview at the Stop hook', () => {
  const paused = (artifact = PLAN) =>
    appendStatus('job', 'work', 'paused', 'waiting on Chris', undefined, { waitingOn: 'review', link: `https://app.ume.so/a/${artifact}` }, true);

  it('passes when the trap session runs an await for the artifact', () => {
    paused();
    expect(unwatchedReview(trap, table(nodeAwait(402, 401, PLAN)), () => HARNESS)).toBeUndefined();
  });

  it('blocks with the command to arm when no await runs, then passes the next Stop for the same report', () => {
    paused();
    const review = unwatchedReview(trap, table(), () => HARNESS);
    expect(review).toEqual({ dispatchId: 'job', artifact: PLAN });
    expect(unwatchedReviewReason(review!)).toBe(
      `No await is listening for your review of ${PLAN}. Run \`ume await --watch ${PLAN}\` in the background (run_in_background), then end your turn.`,
    );
    expect(unwatchedReview(trap, table(), () => HARNESS)).toBeUndefined();
  });

  it('blocks when the only await is for a different artifact', () => {
    paused();
    expect(unwatchedReview(trap, table(nodeAwait(402, 401, OTHER)), () => HARNESS)?.artifact).toBe(PLAN);
  });

  it("does not count another session's await for the same artifact", () => {
    paused();
    expect(unwatchedReview(trap, table({ pid: 900, parent: 1, args: 'claude' }, nodeAwait(901, 900, PLAN)), () => HARNESS)?.artifact).toBe(PLAN);
  });

  it('corrects again once an await that was running has stopped', () => {
    paused();
    expect(unwatchedReview(trap, table(nodeAwait(402, 401, PLAN)), () => HARNESS)).toBeUndefined();
    expect(unwatchedReview(trap, table(), () => HARNESS)?.artifact).toBe(PLAN);
    expect(unwatchedReview(trap, table(), () => HARNESS)).toBeUndefined();
  });

  it("counts the daemon's running turn wait the ume Stop hook registered for this session", () => {
    paused();
    const waits = path.join(turnHome, trap.sessionId, 'waits');
    fs.mkdirSync(waits, { recursive: true });
    fs.writeFileSync(path.join(waits, `ume-${PLAN}.json`), JSON.stringify({ from: 'ume', wait: `ume await ${PLAN} --turn-line --since {cursor}`, read: `ume feedback ${PLAN}` }));
    const daemonWait: RunningCommand = { pid: 700, parent: 1, args: `/bin/sh -c ume await ${PLAN} --turn-line --since 7` };
    expect(unwatchedReview(trap, table(daemonWait), () => HARNESS)).toBeUndefined();
    expect(unwatchedReview(trap, table(), () => HARNESS)?.artifact).toBe(PLAN);
  });

  it("does not count the daemon's turn wait while it keeps failing", () => {
    paused();
    const waits = path.join(turnHome, trap.sessionId, 'waits');
    fs.mkdirSync(waits, { recursive: true });
    fs.writeFileSync(path.join(waits, `ume-${PLAN}.json`), JSON.stringify({ from: 'ume', wait: `ume await ${PLAN} --turn-line --since {cursor}`, read: `ume feedback ${PLAN}` }));
    const daemonWait: RunningCommand = { pid: 700, parent: 1, args: `/bin/sh -c ume await ${PLAN} --turn-line --since 7` };
    expect(unwatchedReview(trap, table(daemonWait), () => HARNESS, () => true)?.artifact).toBe(PLAN);
  });

  it('checks needs-decision too, and ignores a working report or a paused one with no ume link', () => {
    appendStatus('job', 'work', 'needs-decision', `pick one in https://app.ume.so/a/${PLAN}`, undefined, undefined, true);
    expect(unwatchedReview(trap, table(), () => HARNESS)?.artifact).toBe(PLAN);
    appendStatus('job', 'work', 'working', `revising https://app.ume.so/a/${PLAN}`, undefined, undefined, true);
    expect(unwatchedReview(trap, table(), () => HARNESS)).toBeUndefined();
    appendStatus('job', 'work', 'paused', 'deploy', undefined, { waitingOn: 'deploy', link: 'https://example.com/deploy/1' }, true);
    expect(unwatchedReview(trap, table(), () => HARNESS)).toBeUndefined();
  });
});

describe('reviewsStillOpen for report done', () => {
  const approvals = (known: Record<string, string>): UmeApprovalReader => () => new Map(Object.entries(known));
  const lastPaused: StatusEntry = { at: '2026-11-20T12:00:00Z', verb: 'paused', waitingOn: 'review', link: `https://app.ume.so/a/${PLAN}`, reported: true };

  it("names an artifact the done note or the last report links that isn't approved", () => {
    expect(reviewsStillOpen(`published https://app.ume.so/a/${OTHER}`, undefined, approvals({ [OTHER]: 'requested' }))).toEqual([OTHER]);
    expect(reviewsStillOpen('PR is up', lastPaused, approvals({}))).toEqual([PLAN]);
  });

  it('lets an approved or No review artifact through, and asks ume nothing without a link', () => {
    expect(reviewsStillOpen('done', lastPaused, approvals({ [PLAN]: 'approved' }))).toEqual([]);
    expect(reviewsStillOpen(`https://app.ume.so/a/${OTHER}`, undefined, approvals({ [OTHER]: 'not-required' }))).toEqual([]);
    expect(reviewsStillOpen('done', undefined, () => { throw new Error('ume was asked'); })).toEqual([]);
  });

  it('refuses with the paused report and the await to arm', () => {
    expect(reviewStillOpenRefusal('job', [PLAN])).toBe(
      `not reported done: ume artifact ${PLAN} is still in review. ` +
        `Report \`lobstah report job paused "<note>" --waiting-on review --link <its URL>\` and run \`ume await --watch ${PLAN}\` in the background. ` +
        'If the review is finished, report done again with --review-done.',
    );
  });
});

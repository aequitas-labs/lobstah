import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendStatus,
  claimBait,
  enqueue,
  ensureLayout,
  listNotices,
  pendingIds,
  readStatusLog,
  readTrap,
  recordClaimWake,
  releaseUnacknowledgedClaim,
  requestCancel,
  signOnTrap,
  unacknowledgedCodexClaims,
  type TrapRegistration,
} from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const ID = '33333333-3333-4333-8333-333333333333';
const WAKE = 120_000;
const RELEASE = 600_000;
const opts = { wakeAfterMs: WAKE, releaseAfterMs: RELEASE };
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-codex-claim-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

/** A trap of `harness` that has just claimed ID, and the claim's time. */
function claimed(harness: string): { trap: TrapRegistration; at: number } {
  const worktree = path.join(home, `wt-${harness}`);
  fs.mkdirSync(worktree);
  const signed = signOnTrap({ worktree, cwd: worktree, repo: 'web', harness, sessionId: `${harness}-session`, ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('unexpected hold');
  enqueue({ id: ID, repo: 'web', for: `wt:${signed.ok.trapId}`, brief: 'fix the build' });
  expect(claimBait(readTrap(signed.ok.trapId)!)?.id).toBe(ID);
  const trap = readTrap(signed.ok.trapId)!;
  return { trap, at: Date.parse(readStatusLog(ID, 'work').at(-1)!.at) };
}
const kinds = (now: number) => unacknowledgedCodexClaims(now, opts).map((s) => `${s.kind}:${s.dispatchId}`);

describe("a Codex trap's unacknowledged claim", () => {
  it('is woken once after the grace, then released to the queue, and the helm hears once', () => {
    const { trap, at } = claimed('codex');
    expect(kinds(at + WAKE - 1)).toEqual([]);
    expect(kinds(at + WAKE)).toEqual([`wake:${ID}`]);
    recordClaimWake(trap, ID, readStatusLog(ID, 'work').at(-1)!.at, at + WAKE);
    // Woken: no second wake, and no release before its own grace.
    expect(kinds(at + WAKE + RELEASE - 1)).toEqual([]);
    const [release] = unacknowledgedCodexClaims(at + WAKE + RELEASE, opts);
    expect(release).toMatchObject({ kind: 'release', dispatchId: ID });
    expect(releaseUnacknowledgedClaim(release as Parameters<typeof releaseUnacknowledgedClaim>[0])).toEqual({ requeued: ID });
    expect(pendingIds('work')).toContain(ID);
    expect(listNotices(50).filter((n) => n.kind === 'trap-claim-released' && n.refId === ID)).toHaveLength(1);
    expect(kinds(at + WAKE + RELEASE + 1)).toEqual([]);
  });

  it('needs nothing once the worker reports for it', () => {
    const { at } = claimed('codex');
    appendStatus(ID, 'work', 'working', 'on it', undefined, undefined, true);
    expect(kinds(at + WAKE + RELEASE * 2)).toEqual([]);
  });

  it('finalizes at once when a cancel arrives that nobody is reading', () => {
    const { at } = claimed('codex');
    requestCancel(ID, 'work');
    const [cancel] = unacknowledgedCodexClaims(at + 1, opts);
    expect(cancel).toMatchObject({ kind: 'cancel', dispatchId: ID });
    expect(releaseUnacknowledgedClaim(cancel as Parameters<typeof releaseUnacknowledgedClaim>[0])).toEqual({ finalized: ID });
    expect(readStatusLog(ID, 'work').at(-1)).toMatchObject({ verb: 'failed' });
    expect(listNotices(50).some((n) => n.kind === 'trap-claim-released')).toBe(false);
  });

  it('is left alone on a Claude trap, whose background listener starts a turn when it ends', () => {
    const { at } = claimed('claude');
    expect(kinds(at + WAKE + RELEASE * 2)).toEqual([]);
  });

  it('starts over for a new claim after a wake for an older one', () => {
    const { trap, at } = claimed('codex');
    recordClaimWake(trap, ID, '2020-01-01T00:00:00.000Z', at);
    expect(kinds(at + WAKE)).toEqual([`wake:${ID}`]);
  });
});

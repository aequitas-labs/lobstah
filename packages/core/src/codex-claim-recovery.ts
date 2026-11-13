import fs from 'node:fs';
import { trapUsageLimit } from './usage-limits.js';
import path from 'node:path';
import { atomicRenameSync, lobstahHome, uniqueTempPath } from './paths.js';
import { cancelRequested } from './queue.js';
import { listTraps, needsFreshTrapSession, releaseCatch, trapRepoLabel, unreportedTrapBait, type TrapRegistration } from './soak.js';
import { postNotice } from './notices.js';

/**
 * A Codex trap can claim work and never read it. Its `soak --wait` claims
 * the dispatch and prints the brief, but when the model ran that listener as
 * a background command and ended its turn, Codex drops the output into the
 * finished turn and starts no new one: the session sits idle with a claim it
 * never saw. Claude starts a turn when a background task ends, so this is
 * Codex's alone.
 *
 * The daemon watches each Codex trap's claim until its worker reports for
 * it. After `wakeAfterMs` it wakes the session once (see the CLI's
 * codex-claim-watch); `releaseAfterMs` after that wake it gives the claim
 * back to the queue and tells the helm. A cancel that arrives before the
 * first report finalizes at once: nobody is reading it.
 */
export type UnacknowledgedClaimStep =
  | { kind: 'wake'; trap: TrapRegistration; dispatchId: string }
  | { kind: 'release'; trap: TrapRegistration; dispatchId: string }
  | { kind: 'cancel'; trap: TrapRegistration; dispatchId: string };

/** When the daemon woke a trap for one claim. A new claim starts over. */
interface ClaimWake {
  dispatchId: string;
  claimAt: string;
  wokeAt: string;
}

const wakeFile = (trapId: string) => path.join(lobstahHome(), 'codex-claim-wakes', `${encodeURIComponent(trapId)}.json`);

function readWake(trapId: string): ClaimWake | undefined {
  try {
    return JSON.parse(fs.readFileSync(wakeFile(trapId), 'utf8')) as ClaimWake;
  } catch {
    return undefined;
  }
}

/** Record that the daemon woke `trap` for its current claim, so it wakes once and releases later. */
export function recordClaimWake(trap: TrapRegistration, dispatchId: string, claimAt: string, now = Date.now()): void {
  const file = wakeFile(trap.trapId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, JSON.stringify({ dispatchId, claimAt, wokeAt: new Date(now).toISOString() } satisfies ClaimWake));
  atomicRenameSync(tmp, file);
}

/** The step each Codex trap's unacknowledged claim needs now, if any. */
export function unacknowledgedCodexClaims(now: number, opts: { wakeAfterMs: number; releaseAfterMs: number }): UnacknowledgedClaimStep[] {
  const steps: UnacknowledgedClaimStep[] = [];
  for (const trap of listTraps()) {
    if (trap.harness !== 'codex') continue;
    const bait = unreportedTrapBait(trap);
    if (!bait) continue;
    if (cancelRequested(bait.id, bait.lane)) {
      steps.push({ kind: 'cancel', trap, dispatchId: bait.id });
      continue;
    }
    if (needsFreshTrapSession(bait.descriptor) || trapUsageLimit(trap)) continue; // Keep limited claims sticky until reset or an explicit swap.
    const claimedAt = Date.parse(bait.claim.at);
    if (!Number.isFinite(claimedAt)) continue;
    const wake = readWake(trap.trapId);
    const woke = wake?.dispatchId === bait.id && wake.claimAt === bait.claim.at ? Date.parse(wake.wokeAt) : undefined;
    if (woke === undefined) {
      if (now - claimedAt >= opts.wakeAfterMs) steps.push({ kind: 'wake', trap, dispatchId: bait.id });
    } else if (now - woke >= opts.releaseAfterMs) {
      steps.push({ kind: 'release', trap, dispatchId: bait.id });
    }
  }
  return steps;
}

/**
 * Give an unacknowledged claim back to the queue (or finalize it when a
 * cancel stands) and tell the helm once. The trap stays signed on: it may
 * only have missed this one brief.
 */
export function releaseUnacknowledgedClaim(step: Extract<UnacknowledgedClaimStep, { kind: 'release' | 'cancel' }>): { requeued?: string; finalized?: string } {
  const result = releaseCatch(step.trap);
  fs.rmSync(wakeFile(step.trap.trapId), { force: true });
  if (step.kind === 'release' && result.requeued) {
    postNotice({
      kind: 'trap-claim-released',
      refId: step.dispatchId,
      repo: step.trap.repo,
      text:
        `${trapRepoLabel(step.trap)} claimed ${step.dispatchId} but never reported, even after lobstah woke it. ` +
        `The dispatch is back in the queue; check the trap's session, or stow it and address the work elsewhere.`,
      dedupeKey: `trap-claim-released-${step.dispatchId}`,
    });
  }
  return result;
}

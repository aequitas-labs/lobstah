import fs from 'node:fs';
import path from 'node:path';
import {
  endHarnessProcess,
  handoffNote,
  laneDirs,
  originProgress,
  pinTrapCatch,
  queuedDescriptor,
  readRoster,
  readSessionClaim,
  readTrap,
  releaseCatch,
  rewriteQueued,
  sessionHolders,
  setRosterProfile,
  stowTrap,
  worktreeProgress,
} from '@lobstah/core';
import type { Config, Descriptor, Lane } from '@lobstah/core';
import { stopCodexThread } from './codex-server.js';
import { throwTrap, type ThrowOptions, type ThrowResult } from './throw.js';

/** Dependencies for one trap-owned handover; no headless runner state is involved. */
export interface TrapSwapOptions {
  cfg: Config;
  harness: string;
  model?: string;
  effort?: string;
  by?: string;
  /** Claim-time handovers have not started the task branch yet. */
  newDispatch?: boolean;
  endProcess?: typeof endHarnessProcess;
  launch?: (options: ThrowOptions & { address: string }) => Promise<ThrowResult>;
}

/** Stop the verified writer, preserve the catch and its inbox, and launch the requested harness in the same checkout. */
export async function swapTrapCatch(id: string, lane: Lane, options: TrapSwapOptions): Promise<ThrowResult> {
  const queued = queuedDescriptor(id, lane);
  const claimed = readSessionClaim(id, lane);
  const address = claimed?.by ?? queued?.for;
  if (!address?.startsWith('wt:')) throw new Error(`${id} has no trap claimant or sticky target`);
  const trapId = address.slice(3),
    reg = readTrap(trapId),
    roster = readRoster(trapId);
  if (!roster?.repo || roster.configured)
    throw new Error('This swap needs a repo trap; open the configured app session to change its harness');
  const claim = claimed ?? { by: address, sessionId: roster.sessionId, harness: roster.harness };
  if (!['claude', 'codex'].includes(options.harness)) throw new Error('--harness takes claude or codex');
  const dir = path.join(laneDirs(lane).active, id);
  const earlier = originProgress(id, lane);
  const process = reg?.harnessProcess ?? roster.harnessProcess;
  // Ending the process signs the trap off (SessionEnd), which requeues its
  // catch. Pin the catch to this trap first, or an unaddressed catch is open
  // to any parked trap until the handover below lands.
  if (claimed?.by === address) pinTrapCatch(id, lane, trapId);
  if (reg?.codexServer) {
    if ((await stopCodexThread(reg.sessionId)) === 'unreachable')
      throw new Error(`Stop Codex thread ${reg.sessionId} for ${roster.name}, then retry lobstah swap ${id} --harness ${options.harness}`);
  } else if (process) {
    const ending = await (options.endProcess ?? endHarnessProcess)(process);
    if (ending === 'survived')
      throw new Error(
        `Stop ${claim.harness} process ${process.pid} for ${roster.name}, then retry lobstah swap ${id} --harness ${options.harness}`,
      );
  } else if (
    reg ||
    sessionHolders(claim.sessionId, { codexThread: claim.harness === 'codex' }).some((holder) => holder.pid !== undefined)
  ) {
    throw new Error(
      `Close ${claim.harness} session ${claim.sessionId} for ${roster.name}${roster.window?.tmuxPane ? ` in pane ${roster.window.tmuxPane}` : ''}, then retry lobstah swap ${id} --harness ${options.harness}; its process cannot be verified automatically`,
    );
  }
  /** The handover: the requested harness, sticky to this trap, with the earlier session's progress. */
  const handover = (current: Descriptor): Descriptor => {
    const next: Descriptor = {
      ...current,
      harness: options.harness,
      harnessExplicit: true,
      for: `wt:${trapId}`,
      handoffFreshBranch: options.newDispatch === true && !current.followUp && !current.pr,
      handoff: handoffNote(claim.harness, `${earlier}\n\n${worktreeProgress(roster.worktree)}`),
    };
    if (options.model) {
      next.model = options.model;
      next.modelExplicit = true;
    } else {
      delete next.model;
      delete next.modelExplicit;
    }
    if (options.effort) next.effort = options.effort;
    return next;
  };
  // SessionEnd may already have signed off and requeued the catch while its process ended.
  if (readTrap(trapId)) stowTrap(trapId, `swapping to ${options.harness}`, options.by);
  // The handover lands before the catch is claimable again: a catch requeued
  // under its old (often unaddressed) descriptor could go to another trap.
  const handedOver = fs.existsSync(path.join(dir, 'claim.json'))
    ? releaseCatch({ claimed: id }, handover).requeued === id
    : rewriteQueued(id, lane, handover);
  if (!handedOver || !queuedDescriptor(id, lane)) throw new Error(`${id} ended or was claimed while its session stopped; it was not relaunched`);
  setRosterProfile(trapId, {
    harness: options.harness,
    model: options.model ?? null,
    ...(options.effort ? { config: { effort: options.effort } } : {}),
  });
  return (options.launch ?? throwTrap)({ cfg: options.cfg, address: `wt:${trapId}`, fresh: true, harness: options.harness, by: options.by });
}

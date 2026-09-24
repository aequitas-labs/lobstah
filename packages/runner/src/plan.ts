import {
  CODEX_DESKTOP_THREAD,
  codexDesktopThread,
  harnessFromSessionId,
  readEvidence,
  resolveSessionHarness,
  storedDescriptor,
} from '@lobstah/core';
import type { Config, Descriptor, Lane } from '@lobstah/core';

/**
 * How a runner starts its session: which harness, whether it resumes one,
 * and — when it starts cold in place of a resume — what the replacement
 * session is told about the work so far.
 */
export interface StartPlan {
  /** The harness this run uses. */
  harness: string;
  /** Session to resume, and whose it is (this dispatch's own, or the follow-up origin's). */
  resume?: { sessionId: string; own: boolean; origin?: { id: string; lane: Lane } };
  /** Cold start standing in for a session that could not come along. */
  cold?: { why: string; fromHarness?: string; origin?: { id: string; lane: Lane } };
  /** What happened, for the dispatch's first status note. */
  note?: string;
}

export interface PlanInput {
  id: string;
  lane: Lane;
  descriptor: Descriptor;
  cfg: Config;
  /** The harness the descriptor resolves to through config defaults. */
  resolvedHarness: string;
  /** LOBSTAH_RESUME: the daemon restarting this dispatch's own session. */
  envResume?: string;
}

const short = (s: string) => s.slice(0, 8);

/** What the origin's dispatch was asked to run on — descriptor, then config defaults. */
function askedHarness(id: string, lane: Lane, cfg: Config): string {
  const d = storedDescriptor(id, lane);
  return d?.harness ?? (d ? cfg.repos[d.repo]?.harness?.default : undefined) ?? cfg.harness.default ?? 'claude';
}

export function planStart(input: PlanInput): StartPlan {
  const { id, lane, descriptor, cfg, resolvedHarness, envResume } = input;

  // Daemon restart (dead or wedged runner): resume this dispatch's own
  // session under the harness that wrote it.
  if (envResume) {
    const own = resolveSessionHarness(id, cfg, lane);
    const harness = (own.sessionId === envResume ? own.harness : harnessFromSessionId(envResume)) ?? resolvedHarness;
    if (harness === 'codex' && codexDesktopThread(envResume)) {
      return {
        harness: resolvedHarness,
        cold: { why: CODEX_DESKTOP_THREAD, fromHarness: harness },
        note: `restart: ${CODEX_DESKTOP_THREAD} (${short(envResume)}), starting cold on ${resolvedHarness}`,
      };
    }
    return {
      harness,
      resume: { sessionId: envResume, own: true },
      note: harness !== resolvedHarness ? `resuming own ${harness} session ${short(envResume)}` : undefined,
    };
  }

  // Already ran once (a swap respawn, or a catch a trap released back to the
  // queue): never re-resume the origin over this dispatch's own work.
  const prior = readEvidence(id, lane).sessionId;
  if (prior) {
    const from = resolveSessionHarness(id, cfg, lane).harness;
    return {
      harness: resolvedHarness,
      cold: { why: `session ${short(prior)} is not resumed on a respawn`, fromHarness: from },
      note: `respawn: starting cold on ${resolvedHarness}${from ? ` (previous session: ${from})` : ''}`,
    };
  }

  if (!descriptor.followUp) return { harness: resolvedHarness };

  const originId = descriptor.followUp;
  const origin = resolveSessionHarness(originId, cfg);
  const originLane = origin.lane ?? lane;
  const originRef = { id: originId, lane: originLane };
  if (!origin.sessionId) {
    return {
      harness: resolvedHarness,
      cold: { why: `follow-up origin ${short(originId)} has no recorded session`, origin: originRef },
      note: `follow-up of ${short(originId)}: no session recorded — starting cold on ${resolvedHarness} with a progress note`,
    };
  }
  if (!origin.harness) {
    return {
      harness: resolvedHarness,
      resume: { sessionId: origin.sessionId, own: false, origin: originRef },
      note: `follow-up of ${short(originId)}: resuming session ${short(origin.sessionId)} on ${resolvedHarness} (origin harness unknown)`,
    };
  }

  // An explicit --harness (recorded as harnessExplicit) that differs from
  // the origin session's is a swap. Without the record — a descriptor
  // written before it existed — a --harness naming what the chain already
  // asked for is inherited habit, not a request, and only one naming
  // something the chain never asked for is a swap. An unspecified harness
  // follows the origin.
  const requested = descriptor.harness;
  const swap =
    requested !== undefined &&
    requested !== origin.harness &&
    (descriptor.harnessExplicit === true ||
      (descriptor.harnessExplicit === undefined && requested !== askedHarness(originId, originLane, cfg)));
  if (swap) {
    return {
      harness: requested,
      cold: { why: `swap from ${origin.harness} to ${requested}`, fromHarness: origin.harness, origin: originRef },
      note:
        `follow-up of ${short(originId)}: swap — origin session is ${origin.harness}, ${requested} requested; ` +
        `starting cold on ${requested} with a progress note`,
    };
  }

  // A Codex desktop thread is not a CLI rollout: `codex exec resume` refuses
  // it, so don't try — start cold on the harness this dispatch asked for.
  if (origin.harness === 'codex' && codexDesktopThread(origin.sessionId)) {
    return {
      harness: resolvedHarness,
      cold: { why: CODEX_DESKTOP_THREAD, fromHarness: origin.harness, origin: originRef },
      note:
        `follow-up of ${short(originId)}: ${CODEX_DESKTOP_THREAD} (${short(origin.sessionId)}), ` +
        `starting cold on ${resolvedHarness} with a progress note`,
    };
  }

  const ignored = requested !== undefined && requested !== origin.harness ? ` (--harness ${requested} ignored for the resume)` : '';
  return {
    harness: origin.harness,
    resume: { sessionId: origin.sessionId, own: false, origin: originRef },
    note:
      `follow-up of ${short(originId)}: resuming ${origin.harness} session ${short(origin.sessionId)} ` +
      `(harness from ${origin.source})${ignored}`,
  };
}

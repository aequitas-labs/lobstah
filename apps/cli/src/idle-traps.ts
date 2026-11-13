import {
  endHarnessProcess, hasOpenCatch, listTraps, pendingIds, queuedDescriptor,
  releaseCatch, stowIdleTrap, trapAvailability, trapLabel, unhandledTrapMessages,
  type Config, type TrapRegistration,
} from '@lobstah/core';
import { stopCodexThread } from './codex-server.js';

/** An empty park stays idle across liveness heartbeats, but work and messages always take priority. */
export function idleTrapDue(trap: TrapRegistration, minutes: number, now = Date.now()): boolean {
  if (!minutes || !trap.idleSince || hasOpenCatch(trap) || trap.hostedCatch || unhandledTrapMessages(trap.trapId).length) return false;
  const since = Date.parse(trap.idleSince);
  if (!Number.isFinite(since) || now - since < minutes * 60_000 || trapAvailability(trap, now).state === 'busy') return false;
  return !(['chore', 'work'] as const).some(lane => pendingIds(lane).some(id => {
    const descriptor = queuedDescriptor(id, lane);
    return descriptor && !descriptor.for && !descriptor.pool && !descriptor.target && trap.repo &&
      descriptor.repo === trap.repo && (!descriptor.harness || descriptor.harness === trap.harness);
  }));
}

/** Shutdown runs in the daemon, outside the harness that must end. */
export interface IdleTrapOptions {
  endProcess?: typeof endHarnessProcess;
  stopThread?: typeof stopCodexThread;
}

/** Stow empty traps normally and stop only their recorded writer; never remove their checkout. */
export function createIdleTrapWatch(options: IdleTrapOptions = {}): (cfg: Config, now: number, log: (message: string) => void) => void {
  const stopping = new Set<string>();
  return (cfg, now, log) => {
    for (const seen of listTraps()) {
      if (stopping.has(seen.trapId) || !idleTrapDue(seen, cfg.soak.idleStowMins, now)) continue;
      const trap = seen;
      const reason = `auto-stowed after ${cfg.soak.idleStowMins} minutes idle`;
      const stowed = stowIdleTrap(trap.trapId, trap.sessionId, current => idleTrapDue(current, cfg.soak.idleStowMins, now), reason);
      if (!stowed) continue;
      releaseCatch(stowed);
      log(`trap ${trapLabel(stowed)} ${reason}; worktree kept`);
      stopping.add(trap.trapId);
      void (async () => {
        if (stowed.codexServer) {
          const result = await (options.stopThread ?? stopCodexThread)(stowed.sessionId);
          log(`auto-stowed trap ${trapLabel(stowed)}: Codex thread ${result}`);
        } else if (stowed.harnessProcess) {
          const result = await (options.endProcess ?? endHarnessProcess)(stowed.harnessProcess);
          log(`auto-stowed trap ${trapLabel(stowed)}: ${stowed.harness} process ${result}`);
        } else {
          log(`auto-stowed trap ${trapLabel(stowed)}: no verified harness process; session signed off`);
        }
      })().catch(error => log(`auto-stowed trap ${trapLabel(stowed)}: could not end session (${error instanceof Error ? error.message : String(error)})`))
        .finally(() => stopping.delete(trap.trapId));
    }
  };
}

import { loadConfig, readSessionClaim, readTrap, type Lane, type TrapRegistration } from '@lobstah/core';
import { compactCodexThread } from './codex-server.js';
import { sendSessionPrompt } from './usage-limit-watch.js';
import { swapTrapCatch } from './trap-swap.js';

/** How a compact request reaches the worker's harness. */
export type TrapCompactMethod = '/compact' | 'thread/compact/start' | 'fresh-session swap';

/** Harness operations are replaceable so tests never type into or stop a live session. */
export interface TrapCompactOptions {
  compactThread?: typeof compactCodexThread;
  sendPrompt?: typeof sendSessionPrompt;
  swap?: typeof swapTrapCatch;
}

/** Compact a trap in place; a Codex session without an input route gets the existing cold handover. */
export async function compactTrapSession(trap: TrapRegistration, dispatch?: { id: string; lane: Lane }, options: TrapCompactOptions = {}): Promise<TrapCompactMethod> {
  if (trap.harness === 'codex' && trap.codexServer) {
    await (options.compactThread ?? compactCodexThread)(trap.sessionId);
    return 'thread/compact/start';
  }
  const sent = await (options.sendPrompt ?? sendSessionPrompt)(trap, '/compact', { allowBusy: true });
  if (sent === 'started') return '/compact';
  if (trap.harness === 'codex' && dispatch && typeof sent === 'object' && sent.unavailable) {
    await (options.swap ?? swapTrapCatch)(dispatch.id, dispatch.lane, {
      cfg: loadConfig(), harness: trap.harness, model: trap.model ?? undefined,
    });
    return 'fresh-session swap';
  }
  throw new Error(`Could not compact ${trap.name ?? trap.trapId}: ${typeof sent === 'object' ? sent.blocked : 'session is busy'}`);
}

/** A compact send targets the dispatch's current trap, never an unrelated saved session. */
export async function compactDispatchSession(id: string, lane: Lane): Promise<TrapCompactMethod> {
  const claim = readSessionClaim(id, lane);
  const trap = claim?.by.startsWith('wt:') ? readTrap(claim.by.slice(3)) : undefined;
  if (!trap || trap.claimed !== id || trap.sessionId !== claim?.sessionId)
    throw new Error('--compact needs a dispatch claimed by a live trap');
  return compactTrapSession(trap, { id, lane });
}

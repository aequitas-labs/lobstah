import { appendStatus, dispatchWasCancelled, laneOf, readStatusLog, trapBySession } from '@lobstah/core';

/** Stop further tools for a cancelled trap catch, including after the daemon finalizes its record. */
export function cancelledTrapTool(session: string | undefined): string | undefined {
  const trap = session ? trapBySession(session) : undefined;
  const id = trap?.claimed;
  const lane = id ? laneOf(id) : undefined;
  if (!id || !lane || !dispatchWasCancelled(id, lane)) return undefined;
  const last = readStatusLog(id, lane).at(-1);
  if (last?.verb !== 'done' && last?.verb !== 'failed') appendStatus(id, lane, 'failed', 'cancelled by request; work preserved');
  return `Dispatch ${id} was cancelled. Stop working on it and leave the worktree as it is.`;
}

/** A literal park can receive the next catch after cancellation; shell chains cannot bypass the stop. */
export function isTrapWaitCommand(command: string): boolean {
  return /^lobstah[ \t]+soak[ \t]+--wait(?:[ \t]+--(?:timeout|session)[ \t]+[A-Za-z0-9.-]+)*[ \t]*$/.test(command);
}

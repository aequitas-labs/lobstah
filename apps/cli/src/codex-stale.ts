import { codexThreadHolders, endHarnessProcess, harnessProcessAlive, listTraps, processStartedAt } from '@lobstah/core';

/** One stale Codex writer `man throw --stop-stale` dealt with. */
export interface StaleWriterStop {
  pid: number;
  ending: Awaited<ReturnType<typeof endHarnessProcess>>;
}

/**
 * Stop the Codex processes still holding a thread's writer lock, so a
 * re-thrown trap can resume it. Only lock holders are touched, so only
 * processes verified to be on this very thread; and never one a signed-on
 * trap runs in, which is live work, not a leftover. Throws when such a trap
 * holds it.
 */
export async function stopStaleCodexWriters(threadId: string): Promise<StaleWriterStop[]> {
  const live = listTraps().filter((trap) => trap.sessionId === threadId && trap.harnessProcess && harnessProcessAlive(trap.harnessProcess));
  const stops: StaleWriterStop[] = [];
  for (const pid of codexThreadHolders(threadId)) {
    const owner = live.find((trap) => trap.harnessProcess!.pid === pid);
    if (owner) throw new Error(`Codex process ${pid} is trap ${owner.name ?? `wt:${owner.trapId}`}'s own, which is signed on: stow it first`);
    const startedAt = processStartedAt(pid);
    stops.push({ pid, ending: startedAt ? await endHarnessProcess({ pid, startedAt }) : 'gone' });
  }
  return stops;
}

import { reapDeadTrapPanes } from '@lobstah/core';

/** Reap departures each tick and scan for orphaned dead panes at startup and every five minutes. */
export function createTrapPaneWatch(reap: typeof reapDeadTrapPanes = reapDeadTrapPanes): (now: number, log: (message: string) => void) => void {
  let lastSweep: number | undefined;
  return (now, log) => {
    const includeOrphans = lastSweep === undefined || now - lastSweep >= 300_000;
    for (const pane of reap(includeOrphans)) log(`dead trap pane ${pane}: tail saved and pane closed`);
    if (includeOrphans) lastSweep = now;
  };
}

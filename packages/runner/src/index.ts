import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendStatus, laneDirs } from '@lobstah/core';
import type { Lane } from '@lobstah/core';
import { main } from './run.js';

export { main } from './run.js';
export type { RunnerDeps } from './run.js';
export { planStart } from './plan.js';
export type { StartPlan } from './plan.js';

/**
 * Entry shared by the script build (dist/runner.js under node) and the
 * compiled binary (`lobstah __runner <dir> <lane>` re-execs itself).
 */
export function runRunner(activeDirArg: string, laneArg?: string): void {
  const lane = (laneArg === 'chore' ? 'chore' : 'work') as Lane;
  main(activeDirArg, lane).catch((err) => {
    const id = path.basename(activeDirArg);
    try {
      appendStatus(id, lane, 'failed', String(err instanceof Error ? err.message : err).slice(0, 500));
      fs.renameSync(activeDirArg, path.join(laneDirs(lane).done, id));
    } catch {
      // the daemon's reconcile owns whatever is left
    }
    process.exitCode = 1;
  });
}

const [activeDirArg, laneArg] = process.argv.slice(2);
// Self-run as a script; when the compiled CLI imports this module its own
// argv starts with __runner, and the CLI case calls runRunner explicitly.
if (activeDirArg && activeDirArg !== '__runner') runRunner(activeDirArg, laneArg);

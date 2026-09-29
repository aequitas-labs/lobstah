import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendStatus, isFinished, laneDirs } from '@lobstah/core';
import type { Lane } from '@lobstah/core';
import { main } from './run.js';
import { reapStarted } from './reap.js';

export { main } from './run.js';
export type { RunnerDeps } from './run.js';
export { planStart } from './plan.js';
export { reapStarted, startedBy, listProcesses, stopPids } from './reap.js';
export type { ProcRow } from './reap.js';
export type { StartPlan } from './plan.js';

/** How long the runner process may linger once `main` has finished. */
const EXIT_LINGER_MS = 5000;

/**
 * Entry shared by the script build (dist/runner.js under node) and the
 * compiled binary (`lobstah __runner <dir> <lane>` re-execs itself). The
 * runner is its own process here, so it stops what it started on the way
 * out, and exits even when an abandoned harness handle is still open.
 */
export function runRunner(activeDirArg: string, laneArg?: string): void {
  const lane = (laneArg === 'chore' ? 'chore' : 'work') as Lane;
  const id = path.basename(activeDirArg);
  main(activeDirArg, lane, { reap: () => reapStarted(process.pid) })
    .catch((err) => {
      try {
        // The worker's own `done` or `failed` stands over a runner error.
        if (!isFinished(id, lane)) {
          appendStatus(id, lane, 'failed', String(err instanceof Error ? err.message : err).slice(0, 500));
        }
        fs.renameSync(activeDirArg, path.join(laneDirs(lane).done, id));
      } catch {
        // the daemon's reconcile owns whatever is left
      }
      process.exitCode = 1;
    })
    .finally(() => {
      setTimeout(() => process.exit(), EXIT_LINGER_MS).unref();
    });
}

const [activeDirArg, laneArg] = process.argv.slice(2);
// Self-run as a script; when the compiled CLI imports this module its own
// argv starts with __runner, and the CLI case calls runRunner explicitly.
if (activeDirArg && activeDirArg !== '__runner') runRunner(activeDirArg, laneArg);

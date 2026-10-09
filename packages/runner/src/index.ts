import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendStatus, isFinished, laneDirs } from '@lobstah/core';
import type { Lane } from '@lobstah/core';
import { main } from './run.js';
import { reapStarted } from './reap.js';
import { warmPool } from '@lobstah/worktree';

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

/**
 * Entry for one pool warm-up pass (`--pool-warm <name>` under node, or
 * `lobstah __pool-warm <name>` in the compiled binary). The daemon spawns
 * it detached, so a long install never holds up its tick.
 */
export function runPoolWarm(name: string): void {
  const log = (m: string) => console.log(`[pool-warm] ${new Date().toISOString()} ${m}`);
  warmPool(name, { log })
    .then((ran) => {
      if (!ran) log(`pool ${name}: another warm-up is running`);
    })
    .catch((err) => {
      log(`pool ${name}: warm-up failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    })
    .finally(() => {
      setTimeout(() => process.exit(), EXIT_LINGER_MS).unref();
    });
}

const [activeDirArg, laneArg] = process.argv.slice(2);
// Self-run as a script; when the compiled CLI imports this module its own
// argv starts with __runner, and the CLI case calls runRunner explicitly.
if (activeDirArg === '--pool-warm') {
  if (laneArg) runPoolWarm(laneArg);
} else if (activeDirArg && activeDirArg !== '__runner' && activeDirArg !== '__pool-warm') runRunner(activeDirArg, laneArg);

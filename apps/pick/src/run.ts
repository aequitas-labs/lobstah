import { spawn } from 'node:child_process';
import { ensureLayout } from '@lobstah/core';
import { loadPickupConfig } from './config.js';
import { PickupState } from './state.js';
import { GithubSource } from './sources/github.js';
import { LinearSource } from './sources/linear.js';
import { dispatchLoop } from './loops/dispatch.js';
import { reportLoop } from './loops/report.js';
import type { ReportNotification } from './loops/report.js';
import { reconcileLoop } from './loops/reconcile.js';
import { mergeLoop } from './loops/merge.js';
import type { MergePolicy, MergeSource, Source } from './types.js';

export { readMergeView, readPickupMap } from './merge-view.js';
export type { MergeView, MergeViewPr } from './merge-view.js';
export { githubRepoFromOrigin, loadPickupConfig } from './config.js';
export type { PickupConfig } from './config.js';

/**
 * Generic notification hook: exec the configured command with LOBSTAH_* env
 * vars on every verb transition. Fire-and-forget — a failing notifier never
 * blocks the loop, and lobstah stays free of any messaging vendor.
 */
function makeNotifier(command: string | undefined, log: (m: string) => void): (n: ReportNotification) => void {
  if (!command) return () => {};
  return (n) => {
    const child = spawn(command, {
      shell: true,
      env: {
        ...process.env,
        LOBSTAH_KEY: n.key,
        LOBSTAH_UUID: n.uuid,
        LOBSTAH_VERB: n.verb,
        LOBSTAH_NOTE: n.note ?? '',
        LOBSTAH_PR_URL: n.prUrl ?? '',
      },
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', (err) => log(`notify: ${err.message}`));
    child.unref();
  };
}

async function cycle(
  sources: Source[],
  merges: Array<{ source: MergeSource; policy: MergePolicy }>,
  state: PickupState,
  log: (m: string) => void,
  notify: (n: ReportNotification) => void,
): Promise<void> {
  for (const source of sources) {
    try {
      await dispatchLoop(source, state, log);
      await reportLoop(source, state, log, notify);
      await reconcileLoop(source, state, log);
    } catch (err) {
      log(`${source.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const { source, policy } of merges) {
    try {
      await mergeLoop(source, policy, state, log);
    } catch (err) {
      log(`${source.name} merge: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function runPickup(mode: 'once' | 'daemon' = 'daemon'): Promise<void> {
  ensureLayout();
  const cfg = loadPickupConfig();
  const state = new PickupState();
  const log = (m: string) => console.log(`[pickup] ${m}`);

  const sources: Source[] = [];
  const merges: Array<{ source: MergeSource; policy: MergePolicy }> = [];
  for (const ghCfg of cfg.github) {
    const gh = new GithubSource(ghCfg);
    sources.push(gh);
    merges.push({ source: gh, policy: ghCfg.merge });
  }
  if (cfg.linear) sources.push(new LinearSource(cfg.linear));
  if (sources.length === 0) {
    throw new Error('no [pickup.github] or [pickup.linear] configured — nothing to poll');
  }

  const notify = makeNotifier(cfg.notifyCommand, log);
  if (mode === 'once') {
    await cycle(sources, merges, state, log, notify);
    return;
  }
  log(`polling every ${cfg.pollSecs}s — no webhooks, no inbound surface`);
  while (true) {
    await cycle(sources, merges, state, log, notify);
    await new Promise((r) => setTimeout(r, cfg.pollSecs * 1000));
  }
}

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { ensureLayout, listWatches, readWatch } from '@lobstah/core';
import { loadPickupConfig } from './config.js';
import { PickupState } from './state.js';
import { GithubSource } from './sources/github.js';
import { LinearSource } from './sources/linear.js';
import { dispatchLoop } from './loops/dispatch.js';
import { reportLoop } from './loops/report.js';
import type { ReportNotification } from './loops/report.js';
import { reconcileLoop } from './loops/reconcile.js';
import { mergeLoop } from './loops/merge.js';
import { handleStreamLine, watchLoop } from './loops/watch.js';
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

/**
 * Serialize work from two feeders — the cadence timer and held streams — so
 * pick's state stays single-writer without locks. Jobs run one at a time in
 * arrival order; a failed job never breaks the chain.
 */
export class SingleFlight {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(job: () => T | Promise<T>): Promise<T> {
    const next = this.chain.then(job, job);
    this.chain = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}

/**
 * Held streams: one long-lived child per watch that declares a stream
 * command, emitting NDJSON event lines that deliver the moment they arrive.
 * A latency optimization over the cadence check — the cursor poll remains
 * the guarantee, so a dead stream just means cadence-only until the next
 * sync respawns it (the poll interval doubles as the reconnect backoff).
 */
function syncStreams(
  children: Map<string, ChildProcess>,
  flight: SingleFlight,
  log: (m: string) => void,
  notify: (n: ReportNotification) => void,
): void {
  for (const w of listWatches()) {
    if (!w.stream || children.has(w.key)) continue;
    const cmd = w.stream.replaceAll('{cursor}', w.cursor);
    const child = spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'ignore'] });
    children.set(w.key, child);
    log(`watch ${w.key}: stream attached`);
    let buffer = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        void flight.run(() => handleStreamLine(w.key, line, log, notify));
      }
    });
    child.on('exit', () => {
      children.delete(w.key);
      log(`watch ${w.key}: stream ended — cadence covers until resync`);
    });
    child.on('error', () => children.delete(w.key));
  }
  for (const [key, child] of children) {
    if (!readWatch(key)?.stream) {
      child.kill();
      children.delete(key);
    }
  }
}

async function cycle(
  sources: Source[],
  merges: Array<{ source: MergeSource; policy: MergePolicy }>,
  state: PickupState,
  pollSecs: number,
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
  try {
    await watchLoop(pollSecs, log, notify);
  } catch (err) {
    log(`watches: ${err instanceof Error ? err.message : String(err)}`);
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
    // Registered watches are also a reason to run — watch-only mode.
    if (listWatches().length === 0) {
      throw new Error('no [pickup.github], [pickup.linear], or registered watches — nothing to poll');
    }
    log('no tracker sources configured — watch-only mode');
  }

  const notify = makeNotifier(cfg.notifyCommand, log);
  if (mode === 'once') {
    await cycle(sources, merges, state, cfg.pollSecs, log, notify);
    return;
  }
  log(`polling every ${cfg.pollSecs}s — no webhooks, no inbound surface`);
  // Streams and the cadence feed one serialized executor: stream events
  // deliver in milliseconds, the full cycle stays the reconciling guarantee.
  const flight = new SingleFlight();
  const streamChildren = new Map<string, ChildProcess>();
  while (true) {
    await flight.run(() => cycle(sources, merges, state, cfg.pollSecs, log, notify));
    syncStreams(streamChildren, flight, log, notify);
    await new Promise((r) => setTimeout(r, cfg.pollSecs * 1000));
  }
}

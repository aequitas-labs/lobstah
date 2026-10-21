import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { ensureLayout, listWatches, loadConfig, lobstahHome, readWatch } from '@lobstah/core';
import { loadPickupConfig } from './config.js';
import { PickupState } from './state.js';
import { GithubSource } from './sources/github.js';
import { LinearSource } from './sources/linear.js';
import { dispatchLoop } from './loops/dispatch.js';
import { reportLoop } from './loops/report.js';
import type { ReportNotification } from './loops/report.js';
import { reconcileLoop } from './loops/reconcile.js';
import { mergeLoop } from './loops/merge.js';
import { reviewsLoop } from './loops/reviews.js';
import type { GhGraphql } from './loops/reviews.js';
import { handleStreamLine, watchLoop } from './loops/watch.js';
import type { MergePolicy, MergeSource, Source } from './types.js';

export { readMergeView, readPickupMap } from './merge-view.js';
export type { MergeView, MergeViewPr } from './merge-view.js';
export { githubRepoFromOrigin, loadPickupConfig, pickupPlan } from './config.js';
export { dismissReviewRound, postReview, redraftReviewRound, stageReview } from './reviews-post.js';
export { draftReviewOnDemand } from './loops/reviews.js';
export type { PostBy, PostResult } from './reviews-post.js';
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

export async function cycle(
  sources: Source[],
  merges: Array<{ source: MergeSource; policy: MergePolicy }>,
  state: PickupState,
  pollSecs: number,
  log: (m: string) => void,
  notify: (n: ReportNotification) => void,
  liveComment = true,
  pools: string[] = [],
  /** The review-request search (`[reviews]`), when [pickup.github] gives it an identity. */
  reviews?: () => Promise<void>,
  watches = true,
): Promise<void> {
  for (const source of sources) {
    // A guard per loop: reconcile is the safety net for a report that never
    // lands, so a throw in one loop must not skip the loops after it.
    for (const loop of [
      () => dispatchLoop(source, state, log, pools),
      () => reportLoop(source, state, log, notify, liveComment),
      () => reconcileLoop(source, state, log),
    ]) {
      try {
        await loop();
      } catch (err) {
        log(`${source.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  for (const { source, policy } of merges) {
    try {
      await mergeLoop(source, policy, state, log);
    } catch (err) {
      log(`${source.name} merge: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (reviews) {
    try {
      await reviews();
    } catch (err) {
      log(`reviews: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    if (watches) await watchLoop(pollSecs, log, notify);
  } catch (err) {
    log(`watches: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function runPickup(mode: 'once' | 'daemon' = 'daemon', opts: { reviewRun?: GhGraphql } = {}): Promise<void> {
  ensureLayout();
  const cfg = loadPickupConfig();
  const state = new PickupState();
  const log = (m: string) => console.log(`[pickup] ${m}`);

  const sources: Source[] = [];
  const merges: Array<{ source: MergeSource; policy: MergePolicy }> = [];
  for (const ghCfg of cfg.github) {
    const gh = new GithubSource(ghCfg);
    if (ghCfg.issues !== false || ghCfg.prFeedback !== false) sources.push(gh);
    if (ghCfg.merge.enabled) merges.push({ source: gh, policy: ghCfg.merge });
  }
  if (cfg.linear) sources.push(new LinearSource(cfg.linear));
  if (sources.length === 0) {
    // Registered watches are also a reason to run — watch-only mode.
    if ((!cfg.watches || listWatches().length === 0) && !cfg.reviews && merges.length === 0) {
      throw new Error('no [pickup.github], [pickup.linear], or registered watches — nothing to poll');
    }
    log(`no tracker sources configured — review requests${cfg.watches ? ' and registered watches' : ''} only`);
  }

  const notify = makeNotifier(cfg.notifyCommand, log);
  // Review requests search as [pickup.github]'s identity, with its token.
  const gh = cfg.reviews;
  const reviews = gh ? () => reviewsLoop(gh.identity, gh.token, log, { run: opts.reviewRun }) : undefined;
  if (mode === 'once') {
    await cycle(sources, merges, state, cfg.pollSecs, log, notify, cfg.liveComment, cfg.pools, reviews, cfg.watches);
    return;
  }
  log(`polling every ${cfg.pollSecs}s — no webhooks, no inbound surface`);
  // Streams and the cadence feed one serialized executor: stream events
  // deliver in milliseconds, the full cycle stays the reconciling guarantee.
  const flight = new SingleFlight();
  const streamChildren = new Map<string, ChildProcess>();
  while (true) {
    fs.writeFileSync(path.join(lobstahHome(), 'pick.json'), JSON.stringify({ pid: process.pid, heartbeat: new Date().toISOString(), pollSecs: cfg.pollSecs }));
    await flight.run(() => cycle(sources, merges, state, cfg.pollSecs, log, notify, cfg.liveComment, cfg.pools, reviews, cfg.watches));
    if (cfg.watches) syncStreams(streamChildren, flight, log, notify);
    await new Promise((r) => setTimeout(r, cfg.pollSecs * 1000));
  }
}

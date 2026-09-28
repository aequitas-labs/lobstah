import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  appendStatus,
  cancelRequested,
  claimNext,
  clearHold,
  formatGB,
  GB,
  lastCullPassAt,
  pendingIds,
  postNotice,
  queuedDescriptor,
  readHold,
  stampCullPass,
  statfsFreeBytes,
  worktreesDir,
  writeHold,
  COMPILED_BINARY,
  detectHarnesses,
  ensureLayout,
  executorPath,
  laneDirs,
  lastEventAt,
  loadConfig,
  lobstahHome,
  lobstahVersion,
  listTraps,
  noticeOrphanedBait,
  readSessionClaim,
  readStatusLog,
  releaseDispatchLock,
  daemonSkip,
  sweepGhostTraps,
} from '@lobstah/core';
import type { Config, Descriptor, FreeBytesReader, Lane, RunnerInfo } from '@lobstah/core';
import { classify, killGroup, pidAlive, processStartTime } from './liveness.js';
import { DEFAULT_NOTIFY_VERBS, execNotify, notifiableIds, pendingNotifications } from './notify.js';

const require_ = createRequire(import.meta.url);

function runnerEntry(): string {
  // Workspace layout resolves the package; the published bundle ships
  // runner.js next to this file instead.
  try {
    return require_.resolve('@lobstah/runner');
  } catch {
    return fileURLToPath(new URL('./runner.js', import.meta.url));
  }
}

export interface ActiveState {
  id: string;
  lane: Lane;
  dir: string;
  runner?: RunnerInfo;
}

function readRunnerInfo(dir: string): RunnerInfo | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'runner.json'), 'utf8')) as RunnerInfo;
  } catch {
    return undefined;
  }
}

function listActive(lane: Lane): ActiveState[] {
  const dir = laneDirs(lane).active;
  return fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .map((id) => {
      const d = path.join(dir, id);
      return { id, lane, dir: d, runner: readRunnerInfo(d) };
    });
}

function finalize(st: ActiveState): void {
  // A finished dispatch releases its worktree's lock, so a follow-up can
  // reuse the checkout. (A lock whose dispatch is finished is stale anyway.)
  try {
    releaseDispatchLock(st.dir, st.id);
  } catch {
    // no record, or the worktree is gone
  }
  try {
    fs.renameSync(st.dir, path.join(laneDirs(st.lane).done, st.id));
  } catch {
    // runner may have moved it already
  }
}

export function spawnRunner(st: ActiveState, opts: { attempts: number; resume?: string; nudge?: string }): void {
  // A handoff note (written by `lobstah swap`) becomes the nudge for the next
  // incarnation — consumed exactly once.
  let nudge = opts.nudge;
  const handoffFile = path.join(st.dir, 'handoff');
  if (!nudge && fs.existsSync(handoffFile)) {
    nudge = fs.readFileSync(handoffFile, 'utf8');
    fs.unlinkSync(handoffFile);
  }
  const logPath = path.join(laneDirs(st.lane).state, `${st.id}.runner.log`);
  const log = fs.openSync(logPath, 'a');
  // A compiled binary carries the runner inside itself: re-exec with the
  // hidden __runner verb instead of pointing node at a runner.js on disk.
  const runnerArgv = COMPILED_BINARY ? ['__runner', st.dir, st.lane] : [runnerEntry(), st.dir, st.lane];
  const child = spawn(process.execPath, runnerArgv, {
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      LOBSTAH_ATTEMPTS: String(opts.attempts),
      ...(opts.resume ? { LOBSTAH_RESUME: opts.resume } : {}),
      ...(nudge ? { LOBSTAH_NUDGE: nudge } : {}),
    },
  });
  fs.closeSync(log);
  child.unref();
  const info: RunnerInfo = {
    pid: child.pid ?? -1,
    startedAt: new Date().toISOString(),
    processStartTime: child.pid ? processStartTime(child.pid) : undefined,
    attempts: opts.attempts,
  };
  fs.writeFileSync(path.join(st.dir, 'runner.json'), JSON.stringify(info, null, 2));
}

function sessionOf(st: ActiveState): string | undefined {
  try {
    const ev = JSON.parse(
      fs.readFileSync(path.join(laneDirs(st.lane).state, `${st.id}.evidence`), 'utf8'),
    ) as { sessionId?: string };
    return ev.sessionId;
  } catch {
    return undefined;
  }
}

export function reconcileOne(st: ActiveState, cfg: Config, log: (m: string) => void): void {
  const hasDescriptor = fs.existsSync(path.join(st.dir, 'descriptor.json'));
  if (!hasDescriptor) {
    // a crashed claim: mkdir happened, rename didn't. Sweep once it is stale.
    const age = Date.now() - fs.statSync(st.dir).mtimeMs;
    if (age > 5 * 60_000) fs.rmSync(st.dir, { recursive: true, force: true });
    return;
  }

  const statusLog = readStatusLog(st.id, st.lane);
  const lastVerb = statusLog.at(-1)?.verb;
  const alive = st.runner ? pidAlive(st.runner.pid, st.runner.processStartTime) : undefined;

  // A session-claimed catch has no runner to supervise: an interactive
  // soaking session works it and proves liveness through its reports. The
  // ghost-trap sweep owns staleness; this pass only finalizes and cancels.
  const sessionClaim = readSessionClaim(st.id, st.lane);
  if (sessionClaim) {
    if (lastVerb === 'done' || lastVerb === 'failed') {
      finalize(st);
      log(`${st.id}: ${lastVerb} (claimed by ${sessionClaim.by}), finalized`);
    }
    // A pending cancel reaches the session through its park notice; if the
    // session never answers, the ghost sweep finalizes the cancelled catch.
    return;
  }

  if (cancelRequested(st.id, st.lane)) {
    if (st.runner && alive) {
      log(`${st.id}: cancel requested, killing group ${st.runner.pid}`);
      killGroup(st.runner.pid);
      return; // next tick finds the runner dead and finalizes below
    }
    // Dead or never spawned: finalize here — a cancelled dispatch must not
    // enter the restart ladder or the unclaimed spawn path.
    if (lastVerb !== 'done' && lastVerb !== 'failed') {
      appendStatus(st.id, st.lane, 'failed', 'cancelled by request; work preserved');
    }
    finalize(st);
    log(`${st.id}: cancelled, finalized`);
    return;
  }

  const cls = classify({
    hasRunner: st.runner !== undefined,
    alive,
    lastVerb,
    lastEventAt: lastEventAt(st.id, st.lane),
    startedAt: st.runner ? Date.parse(st.runner.startedAt) : undefined,
    now: Date.now(),
    wedgeThresholdMs: cfg.limits.wedgeThresholdSecs * 1000,
  });

  switch (cls) {
    case 'unclaimed':
      spawnRunner(st, { attempts: 1 });
      log(`${st.id}: spawned runner`);
      break;
    case 'terminal':
      if (!alive) finalize(st);
      break;
    case 'busy':
      break;
    case 'dead': {
      // Positively agent-free (pid verified dead). Auto-restart within bounds.
      const attempts = (st.runner?.attempts ?? 0) + 1;
      if (attempts <= cfg.limits.maxRestartAttempts + 1) {
        log(`${st.id}: runner died, respawning (attempt ${attempts})`);
        spawnRunner(st, { attempts, resume: sessionOf(st) });
      } else {
        appendStatus(st.id, st.lane, 'failed', 'runner died repeatedly; work preserved');
        finalize(st);
        log(`${st.id}: failed after ${attempts - 1} restarts`);
      }
      break;
    }
    case 'wedged': {
      // Never restart a wedge blindly: bound it, then ladder.
      const attempts = (st.runner?.attempts ?? 0) + 1;
      if (st.runner) killGroup(st.runner.pid, 'SIGKILL');
      if (attempts <= cfg.limits.maxRestartAttempts + 1) {
        log(`${st.id}: wedged (no activity), forking session with a nudge (attempt ${attempts})`);
        spawnRunner(st, {
          attempts,
          resume: sessionOf(st),
          nudge:
            'The previous attempt stalled with no tool activity. Review git log and git status in this worktree, then continue the brief from where it stopped.',
        });
      } else {
        appendStatus(st.id, st.lane, 'failed', 'wedged repeatedly; work preserved');
        finalize(st);
        log(`${st.id}: failed after repeated wedges`);
      }
      break;
    }
    case 'unknown':
      log(`${st.id}: state unknown — leaving untouched`);
      break;
  }
}

function writeHeartbeat(cfg: Config): void {
  const payload = {
    machineId: os.hostname(),
    repos: Object.keys(cfg.repos),
    harnesses: detectHarnesses(),
    maxConcurrent: cfg.limits.maxConcurrent,
    version: lobstahVersion(),
    pid: process.pid,
    heartbeat: new Date().toISOString(),
  };
  const tmp = `${executorPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, executorPath());
}

function pruneChores(cfg: Config): void {
  const dir = laneDirs('chore').done;
  const cutoff = Date.now() - cfg.limits.choreRetentionDays * 86_400_000;
  for (const id of fs.readdirSync(dir)) {
    const p = path.join(dir, id);
    if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
  }
}

/**
 * Culling lives in the CLI (it shares code with `lobstah cull`), so the CLI
 * hands the daemon a culler. Without one the daemon never deletes anything.
 */
export interface DaemonCuller {
  /**
   * Cull finished dispatches older than `days`: done entries, worktrees,
   * state, stale PR records and acks. Keeps branches, open-PR dispatches,
   * and all queued and active work. At most `batch` dispatches per call.
   * Returns how many dispatches it culled.
   */
  retention(days: number, now: number, batch: number, log: (m: string) => void): number;
  /**
   * `[limits].releaseOnMerge`: remove the worktrees of finished dispatch
   * chains whose PR merged, when clean and pushed, at most `batch` per call.
   * Returns the released worktree ids.
   */
  release?(now: number, batch: number, log: (m: string) => void): string[];
  /**
   * Remove finished worktrees oldest first until `enough()` is true or none
   * are left, at most `batch` per call. Returns how many it removed.
   */
  pressure(enough: () => boolean, now: number, batch: number, log: (m: string) => void): number;
}

export interface DaemonHooks {
  culler?: DaemonCuller;
  /** Free-space reader; tests inject a fake so they never read the real disk. */
  freeBytes?: FreeBytesReader;
  now?: () => number;
}

/** The retention cull runs at most once per this interval. */
export const CULL_INTERVAL_MS = 3_600_000;
/** At most this many dispatches (or worktrees) per cull pass, so one pass cannot stall the claim loop. */
export const CULL_BATCH = 10;

/**
 * The retention cull, throttled to once per CULL_INTERVAL_MS. The stamp is
 * written before the pass, so a pass that throws is not retried every tick.
 * With `[limits].releaseOnMerge` the pass first releases merged PRs'
 * worktrees (one `worktree-released` notice lists them), then culls with
 * whatever is left of the batch. Returns true when a pass ran.
 */
export function retentionPass(cfg: Config, hooks: DaemonHooks, log: (m: string) => void): boolean {
  const days = cfg.limits.retentionDays;
  const release = cfg.limits.releaseOnMerge === true && hooks.culler?.release !== undefined;
  if (!hooks.culler || (!(days > 0) && !release)) return false;
  const now = hooks.now?.() ?? Date.now();
  const last = lastCullPassAt();
  if (last !== undefined && now - last < CULL_INTERVAL_MS) return false;
  stampCullPass(now);
  // Merge releases and the retention cull share one pass and one batch.
  let budget = CULL_BATCH;
  if (release) {
    try {
      const ids = hooks.culler.release!(now, budget, log);
      budget -= ids.length;
      if (ids.length > 0) {
        const text = `released on merge: ${ids.length} worktree(s) of merged PRs removed (${ids.map((id) => id.slice(0, 8)).join(', ')}); branches kept`;
        postNotice({ kind: 'worktree-released', text });
        log(text);
      }
    } catch (err) {
      log(`release on merge error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (days > 0 && budget > 0) {
    try {
      const n = hooks.culler.retention(days, now, budget, log);
      if (n > 0) log(`retention cull: ${n} finished dispatch(es) older than ${days}d removed`);
    } catch (err) {
      log(`retention cull error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return true;
}

function liftHold(log: (m: string) => void, text: string): void {
  if (!readHold()) return;
  clearHold();
  postNotice({ kind: 'disk-cleared', text });
  log(text);
}

/**
 * The free-space guard, run before the daemon claims work that creates a
 * worktree. Below `[limits].minFreeGB` it first removes finished worktrees
 * (oldest first); if space is still short it records a hold and returns
 * false, and the work stays queued. One notice when a hold starts, one when
 * it clears. A failed read never blocks claiming.
 */
export function spaceGuard(cfg: Config, hooks: DaemonHooks, log: (m: string) => void): boolean {
  const need = (cfg.limits.minFreeGB ?? 0) * GB;
  if (!(need > 0)) {
    liftHold(log, 'free-space hold cleared: [limits].minFreeGB is off');
    return true;
  }
  const dir = worktreesDir();
  const read = hooks.freeBytes ?? statfsFreeBytes;
  const now = hooks.now?.() ?? Date.now();
  let free: number;
  try {
    free = read(dir);
  } catch (err) {
    log(`free-space check failed (${err instanceof Error ? err.message : String(err)}); claiming anyway`);
    return true;
  }
  if (free < need && hooks.culler) {
    try {
      const n = hooks.culler.pressure(() => (free = read(dir)) >= need, now, CULL_BATCH, log);
      if (n > 0) free = read(dir);
      if (n > 0) log(`free-space cull: ${n} finished worktree(s) removed, ${formatGB(free)} free`);
    } catch (err) {
      log(`free-space cull error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (free >= need) {
    liftHold(log, `free-space hold cleared: ${formatGB(free)} free, needs ${formatGB(need)} — claiming resumes`);
    return true;
  }
  const prior = readHold();
  const at = new Date(now).toISOString();
  writeHold({ since: prior?.since ?? at, checkedAt: at, freeBytes: free, needBytes: need, dir });
  if (!prior) {
    const text = `dispatches held: ${formatGB(free)} free on ${dir}, needs ${formatGB(need)} ([limits].minFreeGB) — queued work waits`;
    postNotice({ kind: 'disk-held', text });
    log(text);
  }
  return false;
}

/** Whether the daemon would claim anything from this lane right now. */
function claimable(lane: Lane, skip?: (d: Descriptor) => boolean): boolean {
  return pendingIds(lane).some((id) => {
    const d = queuedDescriptor(id, lane);
    return d !== undefined && !skip?.(d);
  });
}

const daemonStartedAt = Date.now();

export function tick(log: (m: string) => void = () => {}, hooks: DaemonHooks = {}): void {
  const cfg = loadConfig();
  ensureLayout();
  writeHeartbeat(cfg);

  for (const action of sweepGhostTraps(cfg.soak.ttlSecs * 1000)) {
    log(
      action.defective
        ? `trap wt:${action.trapId} never parked — defective enlistment noticed to the helm`
        : `ghost trap wt:${action.trapId} swept` +
            (action.requeued ? ` — work ${action.requeued} back in the queue` : ''),
    );
  }
  // Addressed bait is sticky — never the daemon's; orphans surface as helm
  // notices instead of headless spawns. Unaddressed bait defers briefly to a
  // trap that is parked right now. Work lane only — traps never take chores.
  noticeOrphanedBait();
  const workSkip = daemonSkip(listTraps(), cfg.soak.deferSecs * 1000);

  retentionPass(cfg, hooks, log);
  // Every claim creates a worktree, so the free-space guard gates claiming
  // in both lanes. With nothing to claim there is nothing to hold.
  const skipFor = (lane: Lane) => (lane === 'work' ? workSkip : undefined);
  const roomy = (['chore', 'work'] as Lane[]).some((lane) => claimable(lane, skipFor(lane)))
    ? spaceGuard(cfg, hooks, log)
    : (liftHold(log, 'free-space hold cleared: nothing left to claim'), true);

  for (const lane of ['chore', 'work'] as Lane[]) {
    const active = listActive(lane);
    for (const st of active) reconcileOne(st, cfg, log);
    if (!roomy) continue;

    const ceiling = lane === 'work' ? cfg.limits.maxConcurrent : cfg.limits.choreConcurrent;
    let inFlight = listActive(lane).length;
    while (inFlight < ceiling) {
      const id = claimNext(lane, skipFor(lane));
      if (!id) break;
      log(`${id}: claimed (${lane})`);
      inFlight++;
      // next reconcile pass spawns it; spawn now to avoid a tick of latency
      const st = listActive(lane).find((s) => s.id === id);
      if (st) reconcileOne(st, cfg, log);
    }
  }

  if (cfg.notifyCommand) {
    const verbs = cfg.notifyVerbs ?? DEFAULT_NOTIFY_VERBS;
    for (const lane of ['work', 'chore'] as Lane[]) {
      for (const id of notifiableIds(lane)) {
        for (const ev of pendingNotifications(id, lane, verbs, daemonStartedAt)) {
          execNotify(cfg.notifyCommand, ev, log);
          log(`${id}: notified ${ev.entry.verb}`);
        }
      }
    }
  }

  pruneChores(loadConfig());
}

/**
 * One daemon per home: claiming is atomic under contention, but reconcile is
 * not — two supervisors would both observe a dead runner and both respawn it.
 */
function acquireDaemonLock(): void {
  const lockPath = path.join(lobstahHome(), 'daemon.lock');
  try {
    const prior = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number; processStartTime?: string };
    if (pidAlive(prior.pid, prior.processStartTime)) {
      throw new Error(
        `another daemon (pid ${prior.pid}) already supervises ${lobstahHome()} — ` +
          `run a second instance against its own LOBSTAH_HOME instead`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('already supervises')) throw err;
    // no lock, stale lock, or unreadable lock — take over
  }
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, processStartTime: processStartTime(process.pid), startedAt: new Date().toISOString() }, null, 2),
  );
  const release = () => {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already gone
    }
  };
  process.on('exit', release);
  // Node skips exit hooks on unhandled signals; a stale lock is recoverable
  // (the pid check takes over), but release cleanly when we can.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      release();
      process.exit(0);
    });
  }
}

/**
 * fs.watch on the queue directories, so an enqueue triggers a tick in
 * milliseconds instead of waiting out the interval. Watch as an optimization,
 * poll as the guarantee: fs.watch is unreliable across platforms, so the
 * interval tick stays, and a failed watcher just means cadence-only.
 */
export function watchQueues(onChange: () => void): () => void {
  const watchers: fs.FSWatcher[] = [];
  for (const lane of ['work', 'chore'] as Lane[]) {
    try {
      watchers.push(fs.watch(laneDirs(lane).queue, onChange));
    } catch {
      // cadence covers it
    }
  }
  return () => {
    for (const w of watchers) w.close();
  };
}

export async function daemon(
  intervalMs = 5000,
  log: (m: string) => void = console.log,
  hooks: DaemonHooks = {},
): Promise<never> {
  ensureLayout();
  acquireDaemonLock();
  log(`lobstah daemon: watching ${laneDirs('work').queue} every ${intervalMs}ms`);
  let wake: (() => void) | undefined;
  watchQueues(() => wake?.());
  while (true) {
    try {
      tick(log, hooks);
    } catch (err) {
      log(`tick error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, intervalMs);
      // One nudge per sleep: the first queue event ends the wait (after a
      // short settle so a burst of writes lands in one tick); the rest of the
      // burst is picked up by that tick.
      wake = () => {
        wake = undefined;
        clearTimeout(timer);
        setTimeout(resolve, 50);
      };
    });
  }
}

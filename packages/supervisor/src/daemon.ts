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
  detectHarnesses,
  ensureLayout,
  executorPath,
  laneDirs,
  lastEventAt,
  loadConfig,
  lobstahHome,
  lobstahVersion,
  readStatusLog,
} from '@lobstah/core';
import type { Config, Lane, RunnerInfo } from '@lobstah/core';
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
  const child = spawn(process.execPath, [runnerEntry(), st.dir, st.lane], {
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

const daemonStartedAt = Date.now();

export function tick(log: (m: string) => void = () => {}): void {
  const cfg = loadConfig();
  ensureLayout();
  writeHeartbeat(cfg);

  for (const lane of ['chore', 'work'] as Lane[]) {
    const active = listActive(lane);
    for (const st of active) reconcileOne(st, cfg, log);

    const ceiling = lane === 'work' ? cfg.limits.maxConcurrent : cfg.limits.choreConcurrent;
    let inFlight = listActive(lane).length;
    while (inFlight < ceiling) {
      const id = claimNext(lane);
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

export async function daemon(intervalMs = 5000, log: (m: string) => void = console.log): Promise<never> {
  ensureLayout();
  acquireDaemonLock();
  log(`lobstah daemon: watching ${laneDirs('work').queue} every ${intervalMs}ms`);
  // Watch as an optimization, poll as the guarantee.
  while (true) {
    try {
      tick(log);
    } catch (err) {
      log(`tick error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

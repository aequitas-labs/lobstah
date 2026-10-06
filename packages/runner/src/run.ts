import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ghPrView,
  parsePrRef,
  readPr,
  acknowledge,
  appendEvent,
  appendStatus,
  complete,
  droppedModelNote,
  handoffNote,
  isUnresumable,
  isTrapCatch,
  loadConfig,
  lobstahHome,
  mergeEvidence,
  modelForHarness,
  originProgress,
  pausedWaiting,
  isFinished,
  readActivity,
  readEvidence,
  chainPr,
  readStatusLog,
  releaseWorktreeLock,
  acquireWorktreeLock,
  resolveDispatch,
  unhandled,
  worktreeProgress,
} from '@lobstah/core';
import type { ChainPr, Descriptor, Lane, RepoConfig, RunnerInfo, Verb } from '@lobstah/core';
import { loadAdapter } from '@lobstah/adapters';
import type { Adapter, AdapterRun } from '@lobstah/adapters';
import { allocate, chooseWorktree, collectEvidence, prepareReuse, recoverWorktree, worktreePath } from '@lobstah/worktree';
import type { ChooseInput, WorktreeChoice } from '@lobstah/worktree';
import { buildPrompt } from './contract.js';
import { drive, settle } from './drive.js';
import { planStart } from './plan.js';
import { startWallClock } from './wallclock.js';
import { keepRemote } from './remote.js';
import type { StartPlan } from './plan.js';

/** Seams for tests: the harness, the git work around it, and process cleanup. */
export interface RunnerDeps {
  loadAdapter: (name: string) => Adapter;
  allocate: (repo: RepoConfig, id: string, fromRemoteBranch?: string) => Promise<string>;
  /** Whether a follow-up reuses its chain's worktree (takes the lock on reuse). */
  chooseWorktree: (input: ChooseInput) => Promise<WorktreeChoice>;
  /** Fetch trunk in a reused worktree; re-run setup if a lockfile changed. */
  prepareReuse: (repo: RepoConfig, dir: string) => Promise<{ setupRan: boolean }>;
  collectEvidence: (repo: RepoConfig, dir: string) => Promise<{ branch: string; commits: string[] }>;
  /**
   * Stop every process this runner started (the harness, and what the
   * harness left running) and return how many. The default stops nothing:
   * only the runner entry, a process of its own, passes the real one.
   */
  reap: () => Promise<number>;
  /** A PR's live state (`OPEN`, `MERGED`, `CLOSED`), or undefined when it cannot be read. */
  prState: (url: string) => string | undefined;
}

/** A PR's state from the forge, or undefined when gh cannot say. */
function livePrState(url: string): string | undefined {
  const ref = parsePrRef(url);
  if (!ref) return undefined;
  try {
    return ghPrView(ref).state;
  } catch {
    return undefined;
  }
}

const defaultDeps: RunnerDeps = {
  loadAdapter,
  allocate,
  chooseWorktree,
  prepareReuse,
  collectEvidence,
  reap: async () => 0,
  prState: livePrState,
};

/** How long a run that ended on a final report waits for the adapter to settle. */
const DONE_WAIT_MS = 2000;

/** `p`, or `fallback` when `p` has not settled within `ms`. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

const short = (s: string) => s.slice(0, 8);

/**
 * The existing PR a dispatch works on: the one its descriptor names (a
 * repair or a rebase), else its origin chain's PR. The runner pushes no
 * branch and opens no PR for such a dispatch.
 */
export function boundPr(descriptor: Descriptor, lane: Lane): ChainPr | undefined {
  if (descriptor.pr?.url) {
    const chain = descriptor.followUp ? chainPr(descriptor.followUp, lane) : undefined;
    return { url: descriptor.pr.url, headRefName: descriptor.pr.headRefName ?? (chain?.url === descriptor.pr.url ? chain.headRefName : undefined) };
  }
  return descriptor.followUp ? chainPr(descriptor.followUp, lane) : undefined;
}

/** The note a cold replacement session reads in place of the conversation. */
function coldNote(cold: NonNullable<StartPlan['cold']>, cwd: string, trunk: string): string {
  const parts = [worktreeProgress(cwd, trunk)];
  if (cold.origin) parts.push(originProgress(cold.origin.id, cold.origin.lane));
  return handoffNote(cold.fromHarness ?? 'unknown', parts.join('\n\n'), cold.why);
}

export async function main(activeDir: string, lane: Lane, seams: Partial<RunnerDeps> = {}): Promise<void> {
  const deps: RunnerDeps = { ...defaultDeps, ...seams };
  const id = path.basename(activeDir);
  // The daemon excludes trap catches from headless slots. A directly invoked
  // runner must apply the same rule before starting a clock or touching work.
  if (isTrapCatch(id, lane)) throw new Error(`refusing headless runner for trap catch ${id}`);
  const status = (verb: Verb, note?: string) => appendStatus(id, lane, verb, note);

  const cfg = loadConfig();
  const descriptor = JSON.parse(fs.readFileSync(path.join(activeDir, 'descriptor.json'), 'utf8')) as Descriptor;
  const resolved = resolveDispatch(descriptor, cfg);
  const repo = cfg.repos[descriptor.repo]!;

  const briefFile = path.join(activeDir, 'brief.md');
  if (!fs.existsSync(briefFile)) fs.writeFileSync(briefFile, descriptor.brief);
  const brief = fs.readFileSync(briefFile, 'utf8');

  const attempts = Number(process.env.LOBSTAH_ATTEMPTS ?? '1');
  // The daemon resumes a parked dispatch when its wait ends: why it woke.
  const wake = process.env.LOBSTAH_WAKE;
  const runnerInfo: RunnerInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    attempts,
  };
  fs.writeFileSync(path.join(activeDir, 'runner.json'), JSON.stringify(runnerInfo, null, 2));

  // A repair re-checks its PR before it starts: a PR that merged or closed
  // while the repair waited in the queue has nothing to repair, and its
  // branch may be gone.
  if (descriptor.systemRepair && descriptor.pr?.url) {
    const state = deps.prState(descriptor.pr.url) ?? readPr(parsePrRef(descriptor.pr.url)?.key ?? '')?.state;
    if (state === 'MERGED' || state === 'CLOSED') {
      status('failed', `cancelled: ${descriptor.pr.url} is ${state.toLowerCase()}; nothing to repair`);
      complete(id, lane);
      return;
    }
  }

  // Which harness, and whether to resume: the session's own harness wins
  // (see planStart). The first status note says which way it went.
  const plan = planStart({
    id,
    lane,
    descriptor,
    cfg,
    resolvedHarness: resolved.harness,
    envResume: process.env.LOBSTAH_RESUME,
  });
  // Which worktree: the one recorded on a restart; for a follow-up, its
  // chain's worktree when that is clean and free; else a fresh one. The
  // decision (and the lock on reuse) comes before the first status note, so
  // the note can say which it was. Allocation itself runs after the note.
  const wtFile = path.join(activeDir, 'worktree.json');
  let recorded: string | undefined;
  let recovered = false;
  let choice: WorktreeChoice | undefined;
  if (fs.existsSync(wtFile)) {
    recorded = (JSON.parse(fs.readFileSync(wtFile, 'utf8')) as { path: string }).path;
    if (!fs.existsSync(recorded)) throw new Error(`recorded worktree ${recorded} is gone`);
  } else if (fs.existsSync(worktreePath(id))) {
    recorded = await recoverWorktree(repo, id);
    recovered = true;
  } else if (descriptor.followUp && cfg.limits.reuseWorktree !== false) {
    choice = await deps.chooseWorktree({ id, lane, repoKey: descriptor.repo, repo, followUp: descriptor.followUp });
  }
  const worktreeNote = choice
    ? choice.reuse
      ? `reusing worktree of ${short(choice.from)}`
      : `fresh worktree (${choice.reason})`
    : recovered ? 'recovered own unrecorded worktree' : undefined;

  // A model never crosses harnesses: one that belongs to another harness is
  // dropped for the adapter's default rather than failing the dispatch.
  const firstModel = modelForHarness(plan.harness, resolved.model);
  const firstNote = [
    wake ? `woke from pause: ${wake}` : attempts > 1 ? `attempt ${attempts}` : undefined,
    plan.note,
    firstModel.dropped ? droppedModelNote(plan.harness, firstModel.dropped) : undefined,
    worktreeNote,
  ]
    .filter(Boolean)
    .join('; ');
  status('working', firstNote || undefined);
  appendEvent(id, lane, {
    at: new Date().toISOString(),
    type: 'runner',
    data: { pid: process.pid, attempts, harness: plan.harness, ...(plan.resume ? { resume: plan.resume.sessionId } : {}) },
  });
  // Evidence names the harness from the first run; a session id that is not
  // being resumed as this dispatch's own belongs to someone else — drop it
  // until this run's session announces itself.
  const own = readEvidence(id, lane).sessionId;
  mergeEvidence(id, lane, { harness: plan.harness, sessionId: plan.resume?.own ? own : undefined });

  // Reuse the recorded worktree on restart; allocate exactly once otherwise.
  let cwd: string;
  if (recorded) {
    cwd = recorded;
    const held = acquireWorktreeLock(cwd, id, lane);
    if (held) throw new Error(`worktree at ${cwd} is in use by ${held.id} — wait for that dispatch to release it before retrying`);
    if (recovered) {
      // Allocation may have died during setup as well as before the record.
      // Retry only unfinished/changed setup, without touching branch or HEAD.
      await deps.prepareReuse(repo, cwd);
      fs.writeFileSync(wtFile, JSON.stringify({ path: cwd }, null, 2));
    }
  } else if (choice?.reuse) {
    // The follow-up continues where the origin stopped: same branch, same
    // HEAD. Only trunk is fetched, and setup runs only for a changed lockfile.
    cwd = choice.path;
    const { setupRan } = await deps.prepareReuse(repo, cwd);
    if (setupRan) console.log(`[runner] lockfile changed since setup last ran in ${cwd}: setup re-run`);
    appendEvent(id, lane, {
      at: new Date().toISOString(),
      type: 'runner',
      data: { worktree: cwd, worktreeOf: choice.owner, setupRan },
    });
    fs.writeFileSync(wtFile, JSON.stringify({ path: cwd, of: choice.owner }, null, 2));
  } else {
    // A repair that cannot reuse its origin (notably a trap-owned checkout)
    // starts in its own worktree at the PR head, never in the trap's worktree.
    cwd = await deps.allocate(repo, id, descriptor.systemRepair ? descriptor.pr?.headRefName : undefined);
    acquireWorktreeLock(cwd, id, lane);
    fs.writeFileSync(wtFile, JSON.stringify({ path: cwd }, null, 2));
  }
  // Evidence names the checkout, so catch, tend, the glass, and the cull
  // resolve a reused follow-up to the directory it really ran in.
  const worktreeOf = (JSON.parse(fs.readFileSync(wtFile, 'utf8')) as { of?: string }).of;
  mergeEvidence(id, lane, { worktree: cwd, worktreeOf });

  // A follow-up belongs to the origin chain's PR even when its checkout has
  // a different local branch name. Seed evidence before remote polling starts.
  const existingPr = boundPr(descriptor, lane);
  if (existingPr) mergeEvidence(id, lane, { prUrl: existingPr.url });

  const remotePolicy = {
    pushEarly: repo.pushEarly ?? cfg.limits.pushEarly,
    draftPr: repo.draftPr ?? cfg.limits.draftPr,
    checkpointOnStop: repo.checkpointOnStop ?? cfg.limits.checkpointOnStop,
  };
  const remoteEnabled = Object.values(remotePolicy).some(Boolean);
  const remote = keepRemote({
    id, lane, cwd, trunk: repo.trunk,
    title: descriptor.brief.split('\n')[0]?.trim() || `Lobstah dispatch ${short(id)}`,
    policy: remotePolicy,
    existingPrUrl: existingPr?.url,
  });

  // A wake hands the waiting worker what ended its wait: the reason, and the
  // operator messages that arrived while it was parked.
  const wakeNote = (): string | undefined => {
    if (!wake) return undefined;
    const msgs = unhandled(id, lane);
    for (const m of msgs) acknowledge(id, lane, m.file);
    return [
      `You were paused and this dispatch was parked. The wait ended: ${wake}. Continue the work, and report as before.`,
      ...msgs.map((m) => m.text),
    ].join('\n\n');
  };
  const envNudge = [process.env.LOBSTAH_NUDGE, wakeNote()].filter(Boolean).join('\n\n') || undefined;
  // A swap's handoff (arriving as the nudge) already carries the progress note.
  const planNudge = plan.cold && !envNudge ? coldNote(plan.cold, cwd, repo.trunk) : undefined;
  const promptWith = (nudge: string | undefined) =>
    buildPrompt(brief, { id, nudge, attachments: descriptor.attachments, existingPr });

  // Workers report through the CLI; guarantee it resolves. In the repo layout
  // bin/ sits three levels above the runner's dist — when absent (bundled
  // installs), `lobstah` is expected on PATH already.
  const binDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bin');
  const workerPath = fs.existsSync(path.join(binDir, 'lobstah'))
    ? `${binDir}${path.delimiter}${process.env.PATH ?? ''}`
    : undefined;

  let wallClockHit = false;
  let current: AdapterRun | undefined;
  const wallFile = path.join(activeDir, 'wallclock.json');
  const wallState = (() => {
    try {
      return JSON.parse(fs.readFileSync(wallFile, 'utf8')) as {
        elapsedMs: number; windowMs: number; lastProgressAt?: string; lastHead?: string;
      };
    } catch { return { elapsedMs: 0, windowMs: resolved.limits.wallClockSecs! * 1000 }; }
  })();
  const head = () => {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return undefined; }
  };
  wallState.lastHead ??= head();
  const maxWallMs = Math.max(resolved.limits.wallClockSecs ?? 0,
    cfg.limits.maxWallClockSecs ?? (resolved.limits.wallClockSecs ?? 0) * 4) * 1000;
  const persistWall = (elapsedMs: number, windowMs: number) => {
    const tmp = `${wallFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ ...wallState, elapsedMs, windowMs }));
    fs.renameSync(tmp, wallFile);
  };
  const madeProgress = () => {
    const activity = readActivity(id, lane);
    const recent = activity && Date.now() - Date.parse(activity.at) <= cfg.limits.wedgeThresholdSecs * 1000;
    if (recent && activity.at !== wallState.lastProgressAt) {
      wallState.lastProgressAt = activity.at;
      wallState.lastHead = head();
      return true;
    }
    const currentHead = head();
    if (currentHead && currentHead !== wallState.lastHead) {
      wallState.lastHead = currentHead;
      return true;
    }
    return false;
  };
  // The wall clock does not run while the worker is paused on something
  // external (`report paused --waiting-on`): waiting on a review is not work.
  const wallTimer = resolved.limits.wallClockSecs
    ? startWallClock({
        limitMs: resolved.limits.wallClockSecs * 1000,
        maxMs: maxWallMs,
        initialElapsedMs: wallState.elapsedMs,
        initialWindowMs: wallState.windowMs,
        // A finished dispatch spends no time: the worker's final report
        // stops the clock, even before the turn ends.
        paused: () => {
          const last = readStatusLog(id, lane).at(-1);
          return pausedWaiting(last) || isFinished(id, lane);
        },
        progress: madeProgress,
        onTick: persistWall,
        onExpire: () => {
          if (isFinished(id, lane)) return;
          wallClockHit = true;
          current?.kill();
        },
      })
    : undefined;

  if (wallTimer && wallState.elapsedMs >= maxWallMs) {
    wallTimer.stop();
    const saved = remoteEnabled ? await remote.saveBeforeStop() : undefined;
    settle(id, lane, { cancelled: false, wallClockHit: true, budgetNote: saved });
    releaseWorktreeLock(cwd, id);
    complete(id, lane);
    return;
  }

  const runOnce = async (harness: string, prompt: string, resumeSession: string | undefined) => {
    const run = await deps.loadAdapter(harness).start({
      id,
      cwd,
      prompt,
      model: modelForHarness(harness, resolved.model).model,
      effort: resolved.effort,
      limits: resolved.limits,
      env: {
        ...resolved.env,
        LOBSTAH_HOME: lobstahHome(),
        ...(workerPath ? { PATH: workerPath } : {}),
      },
      flags: resolved.flags,
      resumeSession,
    });
    current = run;
    const driven = await drive(run, {
      id,
      lane,
      cwd,
      stopped: () => wallClockHit,
      backgroundWaitMs: cfg.limits.backgroundWaitSecs * 1000,
      exitGraceMs: (cfg.limits.exitGraceSecs ?? 30) * 1000,
      onFinal: () => wallTimer?.stop(),
      onPark: () => wallTimer?.stop(),
    });
    const { cancelled, activity, parked } = driven;
    if (driven.stopped) {
      // The harness was killed; now its process group, so nothing it
      // started outlives it.
      const reaped = await deps.reap();
      console.log(`[runner] harness stopped (${driven.stopped.reason}) ${Math.round(driven.stopped.afterMs / 1000)}s after the final report; ${reaped} process(es) stopped`);
      mergeEvidence(id, lane, {
        harnessStopped: {
          reason: driven.stopped.reason,
          afterSecs: Math.round(driven.stopped.afterMs / 1000),
          at: new Date().toISOString(),
        },
      });
    }
    // After a final report, a harness that never settles cannot hold the run.
    const result = driven.final || parked ? await within(run.done, DONE_WAIT_MS, {}) : await run.done;
    return { cancelled, activity, parked: parked === true, result };
  };

  // Every exit path releases the worktree lock and completes the active
  // record, including a run whose harness had to be killed.
  let finalReport = false;
  // Parked: the dispatch stays active with its worktree lock, for the wake.
  let parkedExit = false;
  try {
    let outcome = await runOnce(plan.harness, promptWith(envNudge ?? planNudge), plan.resume?.sessionId);

    // A resume the harness refused (not found, culled, foreign) before doing
    // any work falls back to a cold session — it never fails the dispatch.
    // With no session to preserve, the cold run goes on the harness this
    // dispatch asked for (explicit, else the configured default), not the
    // origin's.
    if (
      plan.resume &&
      !outcome.cancelled &&
      !wallClockHit &&
      outcome.activity === 0 &&
      isUnresumable(outcome.result.error)
    ) {
      const reason = outcome.result.error!.replace(/\s+/g, ' ').slice(0, 200).trim();
      const coldHarness = resolved.harness;
      const coldModel = modelForHarness(coldHarness, resolved.model);
      status(
        'working',
        `resume-fallback: ${reason} — starting cold on ${coldHarness}` +
          (coldModel.dropped ? `; ${droppedModelNote(coldHarness, coldModel.dropped)}` : ''),
      );
      appendEvent(id, lane, {
        at: new Date().toISOString(),
        type: 'runner',
        data: { resumeFallback: reason, harness: coldHarness },
      });
      mergeEvidence(id, lane, { resumeFallback: reason, sessionId: undefined, harness: coldHarness });
      const note = coldNote(
        {
          why: `resume of session ${plan.resume.sessionId} failed`,
          fromHarness: plan.harness,
          ...(plan.resume.origin ? { origin: plan.resume.origin } : {}),
        },
        cwd,
        repo.trunk,
      );
      outcome = await runOnce(coldHarness, promptWith([envNudge, note].filter(Boolean).join('\n\n')), undefined);
    }

    wallTimer?.stop();
    const { cancelled, result } = outcome;

    // The worker paused: the session has ended, and the dispatch parks. No
    // verb is added, the worktree stays locked to it, and it stays active.
    // The daemon resumes the session when a message, the --until time, or
    // the end of its PR ends the wait.
    if (outcome.parked && !cancelled && !wallClockHit && readStatusLog(id, lane).at(-1)?.verb === 'paused') {
      parkedExit = true;
      await remote.stop();
      const gitEvidence = await deps.collectEvidence(repo, cwd).catch(() => ({}));
      mergeEvidence(id, lane, { ...gitEvidence, sessionId: result.sessionId ?? readEvidence(id, lane).sessionId });
      console.log('[runner] worker paused: session ended, dispatch parked');
      return;
    }

    // The worker's own `done` or `failed` is final: its work is not saved as
    // an interrupted run, and nothing after it adds a verb.
    const terminal = isFinished(id, lane);
    finalReport = terminal;
    let savedNote: string | undefined;
    if (remoteEnabled && !terminal) {
      savedNote = await remote.saveBeforeStop();
      status('working', `work saved before stop: ${savedNote}`);
    } else {
      await remote.stop();
    }

    try {
      const gitEvidence = await deps.collectEvidence(repo, cwd);
      console.log(`[runner] git evidence: ${JSON.stringify(gitEvidence)}`);
      mergeEvidence(id, lane, { ...gitEvidence, sessionId: result.sessionId ?? readEvidence(id, lane).sessionId });
      console.log(`[runner] evidence after merge: ${JSON.stringify(readEvidence(id, lane))}`);
    } catch (err) {
      // a dispatch that never touched git still completes — but say so
      mergeEvidence(id, lane, {
        note: `evidence collection failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
      });
    }

    settle(id, lane, { cancelled, wallClockHit, error: result.error, budgetNote: savedNote });
  } finally {
    wallTimer?.stop();
    // After a final report or a park, nothing the harness started outlives the run.
    if (finalReport || parkedExit) {
      const reaped = await deps.reap().catch(() => 0);
      if (reaped > 0) console.log(`[runner] ${reaped} leftover process(es) stopped`);
    }
    if (!parkedExit) {
      releaseWorktreeLock(cwd, id);
      complete(id, lane);
    }
  }
}

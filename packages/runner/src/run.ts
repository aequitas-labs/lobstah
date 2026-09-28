import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
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
  readActivity,
  readEvidence,
  readStatusLog,
  releaseWorktreeLock,
  acquireWorktreeLock,
  resolveDispatch,
  worktreeProgress,
} from '@lobstah/core';
import type { Descriptor, Lane, RepoConfig, RunnerInfo, Verb } from '@lobstah/core';
import { loadAdapter } from '@lobstah/adapters';
import type { Adapter, AdapterRun } from '@lobstah/adapters';
import { allocate, chooseWorktree, collectEvidence, prepareReuse, worktreePath } from '@lobstah/worktree';
import type { ChooseInput, WorktreeChoice } from '@lobstah/worktree';
import { buildPrompt } from './contract.js';
import { drive, settle } from './drive.js';
import { planStart } from './plan.js';
import { startWallClock } from './wallclock.js';
import { keepRemote } from './remote.js';
import type { StartPlan } from './plan.js';

/** Seams for tests: the harness, and the git work around it. */
export interface RunnerDeps {
  loadAdapter: (name: string) => Adapter;
  allocate: (repo: RepoConfig, id: string) => Promise<string>;
  /** Whether a follow-up reuses its chain's worktree (takes the lock on reuse). */
  chooseWorktree: (input: ChooseInput) => Promise<WorktreeChoice>;
  /** Fetch trunk in a reused worktree; re-run setup if a lockfile changed. */
  prepareReuse: (repo: RepoConfig, dir: string) => Promise<{ setupRan: boolean }>;
  collectEvidence: (repo: RepoConfig, dir: string) => Promise<{ branch: string; commits: string[] }>;
}

const defaultDeps: RunnerDeps = { loadAdapter, allocate, chooseWorktree, prepareReuse, collectEvidence };

const short = (s: string) => s.slice(0, 8);

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
  const runnerInfo: RunnerInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    attempts,
  };
  fs.writeFileSync(path.join(activeDir, 'runner.json'), JSON.stringify(runnerInfo, null, 2));

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
  let choice: WorktreeChoice | undefined;
  if (fs.existsSync(wtFile)) {
    recorded = (JSON.parse(fs.readFileSync(wtFile, 'utf8')) as { path: string }).path;
    if (!fs.existsSync(recorded)) throw new Error(`recorded worktree ${recorded} is gone`);
  } else if (fs.existsSync(worktreePath(id))) {
    throw new Error(`unrecorded worktree already exists for ${id} — refusing to proceed`);
  } else if (descriptor.followUp && cfg.limits.reuseWorktree !== false) {
    choice = await deps.chooseWorktree({ id, lane, repoKey: descriptor.repo, repo, followUp: descriptor.followUp });
  }
  const worktreeNote = choice
    ? choice.reuse
      ? `reusing worktree of ${short(choice.from)}`
      : `fresh worktree (${choice.reason})`
    : undefined;

  // A model never crosses harnesses: one that belongs to another harness is
  // dropped for the adapter's default rather than failing the dispatch.
  const firstModel = modelForHarness(plan.harness, resolved.model);
  const firstNote = [
    attempts > 1 ? `attempt ${attempts}` : undefined,
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
    acquireWorktreeLock(cwd, id, lane);
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
    cwd = await deps.allocate(repo, id);
    acquireWorktreeLock(cwd, id, lane);
    fs.writeFileSync(wtFile, JSON.stringify({ path: cwd }, null, 2));
  }
  // Evidence names the checkout, so catch, tend, the glass, and the cull
  // resolve a reused follow-up to the directory it really ran in.
  const worktreeOf = (JSON.parse(fs.readFileSync(wtFile, 'utf8')) as { of?: string }).of;
  mergeEvidence(id, lane, { worktree: cwd, worktreeOf });

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
  });

  const envNudge = process.env.LOBSTAH_NUDGE;
  // A swap's handoff (arriving as the nudge) already carries the progress note.
  const planNudge = plan.cold && !envNudge ? coldNote(plan.cold, cwd, repo.trunk) : undefined;
  const promptWith = (nudge: string | undefined) =>
    buildPrompt(brief, { id, nudge, attachments: descriptor.attachments });

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
        paused: () => pausedWaiting(readStatusLog(id, lane).at(-1)),
        progress: madeProgress,
        onTick: persistWall,
        onExpire: () => {
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
    const { cancelled, activity } = await drive(run, {
      id,
      lane,
      cwd,
      stopped: () => wallClockHit,
      backgroundWaitMs: cfg.limits.backgroundWaitSecs * 1000,
    });
    const result = await run.done;
    return { cancelled, activity, result };
  };

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

  const terminal = ['done', 'failed'].includes(readStatusLog(id, lane).at(-1)?.verb ?? '');
  let savedNote: string | undefined;
  if (remoteEnabled && (wallClockHit || cancelled || !!result.error || !terminal)) {
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

  releaseWorktreeLock(cwd, id);
  complete(id, lane);
}

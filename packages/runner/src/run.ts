import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendEvent,
  appendStatus,
  complete,
  droppedModelNote,
  handoffNote,
  isUnresumable,
  loadConfig,
  lobstahHome,
  mergeEvidence,
  modelForHarness,
  originProgress,
  readEvidence,
  resolveDispatch,
  worktreeProgress,
} from '@lobstah/core';
import type { Descriptor, Lane, RepoConfig, RunnerInfo, Verb } from '@lobstah/core';
import { loadAdapter } from '@lobstah/adapters';
import type { Adapter, AdapterRun } from '@lobstah/adapters';
import { allocate, collectEvidence, worktreePath } from '@lobstah/worktree';
import { buildPrompt } from './contract.js';
import { drive, settle } from './drive.js';
import { planStart } from './plan.js';
import type { StartPlan } from './plan.js';

/** Seams for tests: the harness, and the git work around it. */
export interface RunnerDeps {
  loadAdapter: (name: string) => Adapter;
  allocate: (repo: RepoConfig, id: string) => Promise<string>;
  collectEvidence: (repo: RepoConfig, id: string) => Promise<{ branch: string; commits: string[] }>;
}

const defaultDeps: RunnerDeps = { loadAdapter, allocate, collectEvidence };

/** The note a cold replacement session reads in place of the conversation. */
function coldNote(cold: NonNullable<StartPlan['cold']>, cwd: string, trunk: string): string {
  const parts = [worktreeProgress(cwd, trunk)];
  if (cold.origin) parts.push(originProgress(cold.origin.id, cold.origin.lane));
  return handoffNote(cold.fromHarness ?? 'unknown', parts.join('\n\n'), cold.why);
}

export async function main(activeDir: string, lane: Lane, deps: RunnerDeps = defaultDeps): Promise<void> {
  const id = path.basename(activeDir);
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
  // A model never crosses harnesses: one that belongs to another harness is
  // dropped for the adapter's default rather than failing the dispatch.
  const firstModel = modelForHarness(plan.harness, resolved.model);
  const firstNote = [
    attempts > 1 ? `attempt ${attempts}` : undefined,
    plan.note,
    firstModel.dropped ? droppedModelNote(plan.harness, firstModel.dropped) : undefined,
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
  const wtFile = path.join(activeDir, 'worktree.json');
  let cwd: string;
  if (fs.existsSync(wtFile)) {
    cwd = (JSON.parse(fs.readFileSync(wtFile, 'utf8')) as { path: string }).path;
    if (!fs.existsSync(cwd)) throw new Error(`recorded worktree ${cwd} is gone`);
  } else if (fs.existsSync(worktreePath(id))) {
    throw new Error(`unrecorded worktree already exists for ${id} — refusing to proceed`);
  } else {
    cwd = await deps.allocate(repo, id);
    fs.writeFileSync(wtFile, JSON.stringify({ path: cwd }, null, 2));
  }

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
  const wallTimer = resolved.limits.wallClockSecs
    ? setTimeout(() => {
        wallClockHit = true;
        current?.kill();
      }, resolved.limits.wallClockSecs * 1000)
    : undefined;

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
    const { cancelled, activity } = await drive(run, { id, lane, stopped: () => wallClockHit });
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

  if (wallTimer) clearTimeout(wallTimer);
  const { cancelled, result } = outcome;

  try {
    const gitEvidence = await deps.collectEvidence(repo, id);
    console.log(`[runner] git evidence: ${JSON.stringify(gitEvidence)}`);
    mergeEvidence(id, lane, { ...gitEvidence, sessionId: result.sessionId ?? readEvidence(id, lane).sessionId });
    console.log(`[runner] evidence after merge: ${JSON.stringify(readEvidence(id, lane))}`);
  } catch (err) {
    // a dispatch that never touched git still completes — but say so
    mergeEvidence(id, lane, {
      note: `evidence collection failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
    });
  }

  settle(id, lane, { cancelled, wallClockHit, error: result.error });

  complete(id, lane);
}

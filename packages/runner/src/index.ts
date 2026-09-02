import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendEvent,
  appendStatus,
  cancelRequested,
  complete,
  laneDirs,
  loadConfig,
  lobstahHome,
  mergeEvidence,
  readEvidence,
  readStatusLog,
  resolveDispatch,
  TERMINAL_VERBS,
} from '@lobstah/core';
import type { Descriptor, Lane, RunnerInfo, Verb } from '@lobstah/core';
import { loadAdapter } from '@lobstah/adapters';
import { allocate, collectEvidence, worktreePath } from '@lobstah/worktree';
import { buildPrompt } from './contract.js';
import { acknowledge, unhandled } from '@lobstah/core';

/** Look up the harness session of an earlier dispatch, for followUp forking. */
function followUpSession(followUp: string): string | undefined {
  for (const lane of ['work', 'chore'] as Lane[]) {
    const ev = readEvidence(followUp, lane);
    if (ev.sessionId) return ev.sessionId;
  }
  return undefined;
}

export async function main(activeDir: string, lane: Lane): Promise<void> {
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

  status('working', attempts > 1 ? `attempt ${attempts}` : undefined);
  appendEvent(id, lane, { at: new Date().toISOString(), type: 'runner', data: { pid: process.pid, attempts } });

  // Reuse the recorded worktree on restart; allocate exactly once otherwise.
  const wtFile = path.join(activeDir, 'worktree.json');
  let cwd: string;
  if (fs.existsSync(wtFile)) {
    cwd = (JSON.parse(fs.readFileSync(wtFile, 'utf8')) as { path: string }).path;
    if (!fs.existsSync(cwd)) throw new Error(`recorded worktree ${cwd} is gone`);
  } else if (fs.existsSync(worktreePath(id))) {
    throw new Error(`unrecorded worktree already exists for ${id} — refusing to proceed`);
  } else {
    cwd = await allocate(repo, id);
    fs.writeFileSync(wtFile, JSON.stringify({ path: cwd }, null, 2));
  }

  const resumeSession =
    process.env.LOBSTAH_RESUME ?? (descriptor.followUp ? followUpSession(descriptor.followUp) : undefined);

  const adapter = loadAdapter(resolved.harness);
  const prompt = buildPrompt(brief, { id, nudge: process.env.LOBSTAH_NUDGE });

  // Workers report through the CLI; guarantee it resolves. In the repo layout
  // bin/ sits three levels above the runner's dist — when absent (bundled
  // installs), `lobstah` is expected on PATH already.
  const binDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bin');
  const workerPath = fs.existsSync(path.join(binDir, 'lobstah'))
    ? `${binDir}${path.delimiter}${process.env.PATH ?? ''}`
    : undefined;

  const run = await adapter.start({
    id,
    cwd,
    prompt,
    model: resolved.model,
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

  let wallClockHit = false;
  const wallTimer = resolved.limits.wallClockSecs
    ? setTimeout(() => {
        wallClockHit = true;
        run.kill();
      }, resolved.limits.wallClockSecs * 1000)
    : undefined;

  let cancelled = false;
  for await (const ev of run.events) {
    appendEvent(id, lane, ev);
    if (ev.type === 'session' && ev.data?.sessionId) {
      mergeEvidence(id, lane, { sessionId: String(ev.data.sessionId) });
    }
    if (ev.type === 'turn-end') {
      if (cancelRequested(id, lane)) {
        cancelled = true;
        run.kill();
        continue;
      }
      const msgs = unhandled(id, lane);
      if (msgs.length > 0) {
        for (const m of msgs) {
          run.send(m.text);
          acknowledge(id, lane, m.file);
        }
      } else {
        run.end();
      }
    }
  }

  const result = await run.done;
  if (wallTimer) clearTimeout(wallTimer);

  try {
    const gitEvidence = await collectEvidence(repo, id);
    console.log(`[runner] git evidence: ${JSON.stringify(gitEvidence)}`);
    mergeEvidence(id, lane, { ...gitEvidence, sessionId: result.sessionId ?? readEvidence(id, lane).sessionId });
    console.log(`[runner] evidence after merge: ${JSON.stringify(readEvidence(id, lane))}`);
  } catch (err) {
    // a dispatch that never touched git still completes — but say so
    mergeEvidence(id, lane, {
      note: `evidence collection failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
    });
  }

  const lastVerb = readStatusLog(id, lane).at(-1)?.verb;
  if (cancelled) {
    status('failed', 'cancelled by operator');
  } else if (wallClockHit) {
    status('failed', 'wall-clock limit exceeded');
  } else if (result.error) {
    status('failed', result.error.slice(0, 500));
  } else if (!lastVerb || !TERMINAL_VERBS.includes(lastVerb)) {
    status('done');
  }

  complete(id, lane);
}

const [activeDirArg, laneArg] = process.argv.slice(2);
if (activeDirArg) {
  const lane = (laneArg === 'chore' ? 'chore' : 'work') as Lane;
  main(activeDirArg, lane).catch((err) => {
    const id = path.basename(activeDirArg);
    try {
      appendStatus(id, lane, 'failed', String(err instanceof Error ? err.message : err).slice(0, 500));
      fs.renameSync(activeDirArg, path.join(laneDirs(lane).done, id));
    } catch {
      // the daemon's reconcile owns whatever is left
    }
    process.exitCode = 1;
  });
}

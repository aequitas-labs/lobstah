import fs from 'node:fs';
import * as path from 'node:path';
import { archivedDecisionDir, decisionDir, decisionsRoot, listDecisions, readArchivedDecision, readDecision, readDecisionAnswer, runCardSettled, withdrawDecision } from './decisions.js';
import { lobstahHome } from './paths.js';
import { atomicRenameSync, uniqueTempPath } from './paths.js';

/** A run attempt's state. A finished one leaves the active views after RUN_DONE_GRACE_MS (decisions.ts). */
export type RunState = 'running' | 'succeeded' | 'failed' | 'stopped';

/** The result shared with the glass and the helm, without private output. */
export interface RunResult {
  exitCode: number;
  timedOut: boolean;
  stopped?: boolean;
  interrupted?: boolean;
  durationMs: number;
  outputBytes: number;
  scrubbed: number;
}

/** One immutable attempt identity with durable progress and terminal metadata. */
export interface RunAttempt {
  id: string;
  key: string;
  scriptSha256: string;
  state: RunState;
  startedAt: string;
  finishedAt?: string;
  result?: RunResult;
  /** Stream offset retained when the saved output is shorter than the live stream. */
  outputChars?: number;
  /** OS identities keep restart recovery from signalling a reused pid. */
  owner?: import('./harness-process.js').HarnessProcess;
  processes?: import('./harness-process.js').HarnessProcess[];
}

/** Resolve only stored decision directories, including a card withdrawn during execution. */
export function runHistoryDir(key: string): string | undefined {
  const cardDir = readDecision(key) ? decisionDir(key) : archivedDecisionDir(key);
  return cardDir && fs.existsSync(cardDir) ? path.join(cardDir, 'run') : undefined;
}

/** The latest attempt survives page reloads and glass restarts. */
export function readRunAttempt(key: string): RunAttempt | undefined {
  const dir = runHistoryDir(key);
  if (!dir) return undefined;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8')) as RunAttempt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Find retained attempts at glass startup, including cards withdrawn while their command ran. */
export function listRunAttempts(): RunAttempt[] {
  const attempts: RunAttempt[] = [];
  for (const root of [decisionsRoot(), path.join(decisionsRoot(), '.withdrawn')]) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!/^[a-f0-9]{8}$/.test(entry)) continue;
      const attempt = readRunAttempt(`decision:${entry}`);
      if (attempt) attempts.push(attempt);
    }
  }
  return attempts;
}

/** Keep at most 200 lines and 256 KiB of scrubbed output for the local person view. */
export function runOutputTail(output: string): string {
  return output
    .split('\n')
    .slice(-201)
    .join('\n')
    .slice(-256 * 1024);
}

/** Store each attempt and its output before updating the card's latest pointer. */
export function writeRunAttempt(attempt: RunAttempt, output: string): void {
  if (!/^[a-f0-9-]{36}$/.test(attempt.id)) throw new Error('The run card is no longer available.');
  // A withdrawal can move the directory during a write from another process.
  for (let location = 0; location < 2; location++) {
    const dir = runHistoryDir(attempt.key);
    if (!dir) throw new Error('The run card is no longer available.');
    try {
      const attemptDir = path.join(dir, attempt.id);
      fs.mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
      const files: Array<[string, string]> = [
        [path.join(attemptDir, 'output.log'), runOutputTail(output)],
        [path.join(attemptDir, 'state.json'), JSON.stringify(attempt, null, 2)],
        [path.join(dir, 'latest.json'), JSON.stringify(attempt, null, 2)],
      ];
      for (const [file, text] of files) {
        const temporary = uniqueTempPath(file);
        fs.writeFileSync(temporary, text, { mode: 0o600 });
        atomicRenameSync(temporary, file);
      }
    } catch (error) {
      if (dir === runHistoryDir(attempt.key)) throw error;
    }
    if (dir === runHistoryDir(attempt.key)) return;
  }
  throw new Error('The run history moved. Reload the card.');
}

/** Read output through the local run endpoint, separately from snapshots and helm events. */
export function readRunOutput(attempt: RunAttempt): string {
  const dir = runHistoryDir(attempt.key);
  if (!dir || !/^[a-f0-9-]{36}$/.test(attempt.id)) return '';
  try {
    return fs.readFileSync(path.join(dir, attempt.id, 'output.log'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** Recent runs lists finished runs from this many days. */
export const RECENT_RUNS_DAYS = 7;
/** Recent runs lists at most this many. */
export const RECENT_RUNS_MAX = 20;
/** A trap's proposed script the helm never posted is dropped after this long. */
export const RUN_PROPOSAL_TTL_MS = 86_400_000;

/** One finished run as Recent runs shows it. */
export interface RecentRun {
  key: string;
  title: string;
  state: Exclude<RunState, 'running'>;
  exitCode?: number;
  finishedAt: string;
  dispatch?: string;
  repo?: string;
}

/**
 * Withdraw each standing run card whose run ended past the grace period, as
 * Dismiss does: it leaves every active view, and its history stays with the
 * withdrawn card. Returns the keys withdrawn.
 */
export function retireFinishedRuns(now = Date.now()): string[] {
  const retired: string[] = [];
  for (const d of listDecisions()) {
    if (!d.run || readDecisionAnswer(d.key) || !runCardSettled(d, now)) continue;
    try {
      withdrawDecision(d.key);
      retired.push(d.key);
    } catch {
      // Answered or busy in the meantime: the next pass looks again.
    }
  }
  return retired;
}

/** Finished runs from the last RECENT_RUNS_DAYS whose cards no longer stand, newest first. */
export function recentRuns(now = Date.now()): RecentRun[] {
  const since = now - RECENT_RUNS_DAYS * 86_400_000;
  const runs: RecentRun[] = [];
  for (const attempt of listRunAttempts()) {
    if (attempt.state === 'running' || !attempt.finishedAt) continue;
    const ended = Date.parse(attempt.finishedAt);
    if (!Number.isFinite(ended) || ended < since) continue;
    const standing = readDecision(attempt.key);
    if (standing && !readDecisionAnswer(attempt.key) && !runCardSettled(standing, now)) continue;
    const meta = standing ?? readArchivedDecision(attempt.key);
    if (!meta) continue;
    runs.push({
      key: attempt.key,
      title: meta.title,
      state: attempt.state,
      ...(attempt.result ? { exitCode: attempt.result.exitCode } : {}),
      finishedAt: attempt.finishedAt,
      ...(meta.dispatch ? { dispatch: meta.dispatch } : {}),
      ...(meta.repo ? { repo: meta.repo } : {}),
    });
  }
  return runs.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt)).slice(0, RECENT_RUNS_MAX);
}

/** When a stored attempt ended, or started for one that never recorded an end. */
function attemptTime(file: string): number | undefined {
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8')) as RunAttempt;
    if (a.state === 'running') return undefined;
    const at = Date.parse(a.finishedAt ?? a.startedAt);
    return Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remove run history older than `days`: each finished attempt's output and
 * state, a withdrawn run card whose last run ended before then (or that never
 * ran and was asked before then), and proposed scripts the helm never posted
 * within RUN_PROPOSAL_TTL_MS. A running attempt is never removed. Returns how
 * many attempts, cards and proposals went.
 */
export function pruneRunHistory(days: number, now = Date.now()): { attempts: number; cards: number; proposals: number } {
  const removed = { attempts: 0, cards: 0, proposals: 0 };
  const cutoff = now - days * 86_400_000;
  const withdrawn = path.join(decisionsRoot(), '.withdrawn');
  for (const root of [decisionsRoot(), withdrawn]) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/^[a-f0-9]{8}$/.test(entry)) continue;
      const card = path.join(root, entry);
      const runDir = path.join(card, 'run');
      if (!fs.existsSync(runDir)) continue;
      if (days > 0) {
        for (const id of fs.readdirSync(runDir)) {
          if (!/^[a-f0-9-]{36}$/.test(id)) continue;
          const at = attemptTime(path.join(runDir, id, 'state.json'));
          if (at !== undefined && at < cutoff) {
            fs.rmSync(path.join(runDir, id), { recursive: true, force: true });
            removed.attempts += 1;
          }
        }
      }
      if (days > 0 && root === withdrawn) {
        const latest = path.join(runDir, 'latest.json');
        const meta = readArchivedDecision(`decision:${entry}`);
        const at = fs.existsSync(latest) ? attemptTime(latest) : meta ? Date.parse(meta.askedAt) : undefined;
        if (at !== undefined && Number.isFinite(at) && at < cutoff) {
          fs.rmSync(card, { recursive: true, force: true });
          removed.cards += 1;
        }
      }
    }
  }
  const proposals = path.join(lobstahHome(), 'run-proposals');
  let dispatches: string[] = [];
  try {
    dispatches = fs.readdirSync(proposals);
  } catch {
    dispatches = [];
  }
  for (const dispatch of dispatches) {
    const dir = path.join(proposals, dispatch);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files.filter((f) => /^[a-f0-9]{64}\.json$/.test(f))) {
      let at = NaN;
      try {
        at = Date.parse((JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as { at?: string }).at ?? '');
      } catch {
        // An unreadable proposal is as old as its file.
      }
      if (!Number.isFinite(at)) at = fs.statSync(path.join(dir, file)).mtimeMs;
      if (now - at < RUN_PROPOSAL_TTL_MS) continue;
      fs.rmSync(path.join(dir, file), { force: true });
      fs.rmSync(path.join(dir, file.replace(/\.json$/, '.sh')), { force: true });
      removed.proposals += 1;
    }
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      // Gone already.
    }
  }
  return removed;
}

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicRenameSync, lobstahHome, uniqueTempPath } from './paths.js';
import { hasOpenCatch, type TrapRegistration } from './soak.js';
import { laneOf } from './worktrees.js';
import { readStatusLog } from './status.js';
import { readTurnWaits } from './turn-owner.js';
import type { StatusEntry } from './types.js';

/**
 * A trap that puts a ume artifact up for review is only waiting on it while
 * an `ume await` runs. The Stop hook checks a paused or needs-decision report
 * that links an artifact for a running await, and `report done` refuses while
 * a linked artifact is still in review.
 */

/** A ume artifact's id as its link names it, such as `dbbd03aa-434`. */
export type UmeArtifactId = string;

/** A ume artifact link: the hosted app or a local engine. */
const UME_ARTIFACT_LINK = /(?:https:\/\/app\.ume\.so|http:\/\/127\.0\.0\.1:8787)\/a\/([A-Za-z0-9][A-Za-z0-9-]*)/g;

/** The ume artifacts these texts link, in order, each once. */
export function umeArtifactsLinked(...texts: readonly (string | undefined)[]): UmeArtifactId[] {
  const ids = new Set<UmeArtifactId>();
  for (const text of texts) for (const match of (text ?? '').matchAll(UME_ARTIFACT_LINK)) ids.add(match[1]!);
  return [...ids];
}

/** One running process as `ps` lists it: its pid, its parent and its whole command line. */
export interface RunningCommand {
  pid: number;
  parent: number;
  args: string;
}

/** Every running process with its command line; empty where `ps` cannot be read. */
export function runningCommands(): RunningCommand[] {
  if (process.platform === 'win32') return [];
  const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  if (out.status !== 0) return [];
  const rows: RunningCommand[] = [];
  for (const line of out.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), parent: Number(m[2]), args: m[3]! });
  }
  return rows;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a command line is an `ume await` or `ume-next await` waiting on
 * `artifact`: the node process (`…/ume.js await …`) or the shell that runs
 * it. `--park` parks and returns at once, so it waits on nothing.
 */
export function isUmeAwaitFor(args: string, artifact: UmeArtifactId): boolean {
  const verb = /(?:^|[\s/'"])ume(?:-next)?(?:\.m?js)?\s+await\b(.*)$/s.exec(args);
  if (!verb) return false;
  const rest = verb[1]!;
  if (/(?:^|\s)--park\b/.test(rest)) return false;
  return new RegExp(`(?:^|[\\s/'"=])${escapeRegExp(artifact)}(?=$|[\\s'";&|)])`).test(rest);
}

/** Whether `pid` is `ancestor` or runs under it, within a bounded walk of `commands`. */
function runsUnder(commands: readonly RunningCommand[], pid: number, ancestor: number): boolean {
  const parentOf = new Map(commands.map((c) => [c.pid, c.parent]));
  let current: number | undefined = pid;
  for (let hop = 0; hop < 30 && current !== undefined && current > 1; hop++) {
    if (current === ancestor) return true;
    current = parentOf.get(current);
  }
  return false;
}

/**
 * Whether an await for `artifact` runs from the session whose harness process
 * is `sessionRoot`. With no known root, any await on this machine counts: the
 * check never blocks a session it cannot place.
 */
export function umeAwaitRunning(artifact: UmeArtifactId, commands: readonly RunningCommand[], sessionRoot: number | undefined): boolean {
  return commands.some((c) => isUmeAwaitFor(c.args, artifact) && (sessionRoot === undefined || runsUnder(commands, c.pid, sessionRoot)));
}

/**
 * Whether the lobstah daemon runs the review's wait for this session: the ume
 * Stop hook registered it under the turn-end contract (docs/turn-end.md), and
 * its `--turn-line` await is running now.
 */
export function umeTurnWaitRunning(artifact: UmeArtifactId, commands: readonly RunningCommand[], sessionId: string): boolean {
  if (!readTurnWaits(sessionId).some((w) => isUmeAwaitFor(w.wait, artifact))) return false;
  return commands.some((c) => isUmeAwaitFor(c.args, artifact) && /(?:^|\s)--turn-line\b/.test(c.args));
}

/** The command that arms the review's await. */
export const umeAwaitCommand = (artifact: UmeArtifactId): string => `ume await --watch ${artifact}`;

/** A review the trap's last report waits on with no await listening for it. */
export interface UnwatchedReview {
  dispatchId: string;
  artifact: UmeArtifactId;
}

/** Whether the Stop hook already corrected this report, and whether an await was seen for it since. */
interface ReviewAwaitCheck {
  sessionId: string;
  dispatchId: string;
  /** The report checked, as `<log length>:<at>`. */
  report: string;
  /** An await was running at the last check: a later Stop without one corrects again. */
  armed: boolean;
}

const checkFile = (trapId: string): string => path.join(lobstahHome(), 'trap-review-awaits', `${encodeURIComponent(trapId)}.json`);

function readCheck(trapId: string): ReviewAwaitCheck | undefined {
  try { return JSON.parse(fs.readFileSync(checkFile(trapId), 'utf8')) as ReviewAwaitCheck; } catch { return undefined; }
}

function writeCheck(trapId: string, check: ReviewAwaitCheck): void {
  const file = checkFile(trapId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, JSON.stringify(check));
  atomicRenameSync(tmp, file);
}

/** The verbs that leave a trap waiting on a review it asked for. */
const REVIEW_WAIT_VERBS: readonly StatusEntry['verb'][] = ['paused', 'needs-decision'];

/**
 * The review a trap's open catch waits on with no await running from the
 * trap's session, its own or the daemon's turn wait for it: its last report is paused or needs-decision and links a ume
 * artifact. It corrects once per report, and again only after an await was
 * seen and then stopped, so a worker that declines never loops at the Stop.
 * `commands` and `sessionRoot` read processes, so they run only for a linked review.
 */
export function unwatchedReview(
  reg: TrapRegistration,
  commands: () => readonly RunningCommand[] = runningCommands,
  sessionRoot: () => number | undefined = () => reg.harnessProcess?.pid,
): UnwatchedReview | undefined {
  if (!hasOpenCatch(reg)) return undefined;
  const dispatchId = reg.claimed!;
  const log = readStatusLog(dispatchId, laneOf(dispatchId) ?? 'work');
  const last = log.at(-1);
  if (!last?.reported || !REVIEW_WAIT_VERBS.includes(last.verb)) return undefined;
  const artifacts = umeArtifactsLinked(last.note, last.link);
  if (artifacts.length === 0) return undefined;
  const report = `${log.length}:${last.at}`;
  const running = commands();
  const root = sessionRoot();
  const artifact = artifacts.find((id) => !umeAwaitRunning(id, running, root) && !umeTurnWaitRunning(id, running, reg.sessionId));
  const prior = readCheck(reg.trapId);
  const samePrior = prior?.sessionId === reg.sessionId && prior.dispatchId === dispatchId && prior.report === report;
  if (!artifact) {
    if (!samePrior || !prior.armed) writeCheck(reg.trapId, { sessionId: reg.sessionId, dispatchId, report, armed: true });
    return undefined;
  }
  if (samePrior && !prior.armed) return undefined;
  writeCheck(reg.trapId, { sessionId: reg.sessionId, dispatchId, report, armed: false });
  return { dispatchId, artifact };
}

/** The Stop hook's one line for a review nobody is listening to. */
export const unwatchedReviewReason = (review: UnwatchedReview): string =>
  `No await is listening for your review of ${review.artifact}. Run \`${umeAwaitCommand(review.artifact)}\` in the background (run_in_background), then end your turn.`;

/** A ume artifact's approval as `ume artifacts` lists it. `approved` and `not-required` end a review. */
export type UmeApproval = string;

/** Reads approvals for these artifacts; an artifact missing from the map could not be read. */
export type UmeApprovalReader = (artifacts: readonly UmeArtifactId[]) => ReadonlyMap<UmeArtifactId, UmeApproval>;

/** The approvals that close a review: approved, or No review (nobody approves). */
const SETTLED_APPROVALS: readonly UmeApproval[] = ['approved', 'not-required'];

/** Approvals from `ume artifacts --json` run in `cwd`; empty when ume cannot answer. */
export function readUmeApprovals(cwd: string = process.cwd()): UmeApprovalReader {
  return () => {
    const out = spawnSync('ume', ['artifacts', '--json', '--fields', 'id,approval'], { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
    const approvals = new Map<UmeArtifactId, UmeApproval>();
    if (out.status !== 0) return approvals;
    try {
      const listed = JSON.parse(out.stdout) as { artifacts?: { id?: unknown; approval?: unknown }[] };
      for (const a of listed.artifacts ?? []) if (typeof a.id === 'string' && typeof a.approval === 'string') approvals.set(a.id, a.approval);
    } catch { /* unreadable output: every artifact stays unknown */ }
    return approvals;
  };
}

/**
 * The ume artifacts a done report would leave in review: those linked by its
 * note or by the dispatch's last report whose approval is not settled. An
 * artifact ume cannot answer for counts as open; `--review-done` says otherwise.
 */
export function reviewsStillOpen(doneNote: string | undefined, lastReport: StatusEntry | undefined, approvals: UmeApprovalReader): UmeArtifactId[] {
  const artifacts = umeArtifactsLinked(doneNote, lastReport?.note, lastReport?.link);
  if (artifacts.length === 0) return [];
  const known = approvals(artifacts);
  return artifacts.filter((id) => !SETTLED_APPROVALS.includes(known.get(id) ?? ''));
}

/** Why `report done` refused: the review is still open and the trap must keep listening. */
export const reviewStillOpenRefusal = (dispatchId: string, artifacts: readonly UmeArtifactId[]): string =>
  `not reported done: ume ${artifacts.length === 1 ? 'artifact' : 'artifacts'} ${artifacts.join(', ')} ${artifacts.length === 1 ? 'is' : 'are'} still in review. ` +
  `Report \`lobstah report ${dispatchId} paused "<note>" --waiting-on review --link <its URL>\` and run \`${umeAwaitCommand(artifacts[0]!)}\` in the background. ` +
  'If the review is finished, report done again with --review-done.';

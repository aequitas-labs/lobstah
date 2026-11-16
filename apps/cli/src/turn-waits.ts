import fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  atomicRenameSync,
  hasOpenCatch,
  laneOf,
  listTraps,
  loadConfig,
  pinTrapCatch,
  readReservation,
  restoreTrapCatch,
  lobstahHome,
  lobstahTurnSessions,
  postNotice,
  readDirIfPresent,
  readStatusLog,
  readTrap,
  readTurnOwner,
  readSessionClaim,
  readTurnWaits,
  sendMessage,
  sendTrapMessage,
  storedDescriptor,
  TERMINAL_VERBS,
  trapLabel,
  turnWaitCommand,
  uniqueTempPath,
  unhandled,
} from '@lobstah/core';
import type { Lane, StatusEntry, TrapRegistration, TurnWait } from '@lobstah/core';
import { throwTrap } from './throw.js';

/**
 * The owner's half of the turn-end contract (packages/core/src/turn-owner.ts):
 * the daemon runs every wait another tool registered with a lobstah trap.
 *
 * - Each registration becomes a record here, tied to the trap and to the
 *   dispatch it works when it registers. The record outlives the trap, so a
 *   wait for a trap that went away still runs.
 * - Each record's `wait` runs as one child process at a time, with `{cursor}`
 *   filled in. When it prints a line, lobstah wakes the session with a
 *   pointer to `read`, never the content: a live trap through its inbox, a
 *   trap that's gone through a re-throw of its owner, with its recorded park context.
 * - A pointer the trap hasn't read after STALE_MS raises one helm notice:
 *   nobody is listening.
 * - A record ends when its registration file is removed while the trap is
 *   live, or when its dispatch has finished.
 */

/** How long a pointer may sit unread before the helm hears. */
export const STALE_MS = 15 * 60_000;
/**
 * How a wait that printed nothing ended: exit 0 or 2 is a quiet timeout (2 is
 * a common "timed out" code), a signal is the daemon
 * stopping it, and any other exit code is a failure, however long it ran.
 */
const QUIET_EXITS: ReadonlySet<number> = new Set([0, 2]);
/** Backoff after a failed wait: 5 s, doubling, at most 5 minutes. */
const backoffMs = (failures: number): number => Math.min(300_000, 5_000 * 2 ** Math.max(0, failures - 1));

/** Context recorded by the waiting dispatch and tool, replayed as text without interpreting its source. */
export interface DispatchParkContext {
  report?: StatusEntry;
  instructions?: string;
}

export interface TurnWaitRecord {
  key: string;
  session: string;
  trapId: string;
  /** The dispatch the trap worked when the wait registered. */
  dispatch?: string;
  from: string;
  wait: string;
  read: string;
  cwd: string;
  cursor?: string;
  registeredAt: string;
  /** The dispatch report and opaque tool instructions captured while it parked. */
  parkContext?: DispatchParkContext;
  /** Consecutive failed runs, and when the next run may start. */
  failures?: number;
  nextRunAt?: string;
  lastError?: string;
  /** The last pointer delivered to a live trap: the inbox it went to and its file. */
  pointer?: { inbox: string; lane: Lane; file: string; at: string; staleNoticed?: boolean };
  /** Failed owner starts back off independently of the wait process. */
  ownerRestart?: { failures: number; nextAttemptAt: string; lastError: string };
}

export const turnWaitsDir = (): string => path.join(lobstahHome(), 'turn-waits');
const recordPath = (key: string): string => path.join(turnWaitsDir(), `${key.replace(/[^A-Za-z0-9._-]+/g, '-')}.json`);

export function readTurnWaitRecords(): TurnWaitRecord[] {
  return readDirIfPresent(turnWaitsDir())
    .filter((n) => n.endsWith('.json'))
    .flatMap((n) => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(turnWaitsDir(), n), 'utf8')) as TurnWaitRecord];
      } catch {
        return [];
      }
    });
}

function readRecord(key: string): TurnWaitRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(recordPath(key), 'utf8')) as TurnWaitRecord;
  } catch {
    return undefined;
  }
}

function writeRecord(r: TurnWaitRecord): void {
  fs.mkdirSync(turnWaitsDir(), { recursive: true });
  const file = recordPath(r.key);
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
  atomicRenameSync(tmp, file);
}

const removeRecord = (key: string): void => fs.rmSync(recordPath(key), { force: true });

/** The tools that have ever registered a wait with a trap, for doctor: one name per line. */
const seenToolsPath = (): string => path.join(turnWaitsDir(), 'tools.seen');

export function readSeenTurnTools(): Set<string> {
  try {
    return new Set(fs.readFileSync(seenToolsPath(), 'utf8').split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

function noteSeenTool(tool: string): void {
  const seen = readSeenTurnTools();
  if (seen.has(tool)) return;
  seen.add(tool);
  fs.mkdirSync(turnWaitsDir(), { recursive: true });
  fs.writeFileSync(seenToolsPath(), [...seen].sort().join('\n') + '\n');
}

/** A dispatch that has finished, or no longer exists. */
function dispatchEnded(id: string): boolean {
  const lane = laneOf(id);
  if (!lane) return true;
  const last = readStatusLog(id, lane).at(-1)?.verb;
  return last !== undefined && TERMINAL_VERBS.includes(last);
}

/** Resolve the dispatch's current trap claim or sticky address before its original registration. */
export function turnWaitOwnerId(record: TurnWaitRecord): string {
  const lane = record.dispatch ? laneOf(record.dispatch) : undefined;
  const claim = record.dispatch && lane ? readSessionClaim(record.dispatch, lane) : undefined;
  const descriptor = record.dispatch && lane ? storedDescriptor(record.dispatch, lane) : undefined;
  const address = claim?.by ?? descriptor?.for;
  return address?.startsWith('wt:') ? address.slice(3) : record.trapId;
}

/** A live owner must still hold this dispatch; a later catch never receives an earlier catch's wake. */
function liveTrap(record: TurnWaitRecord): TrapRegistration | undefined {
  const trap = readTrap(turnWaitOwnerId(record));
  if (record.dispatch) return trap?.claimed === record.dispatch && hasOpenCatch(trap) ? trap : undefined;
  return trap?.sessionId === record.session ? trap : undefined;
}

/** Capture a dispatch's latest waiting report and any recovery text supplied by the tool. */
function savedParkContext(dispatch: string | undefined, instructions: string | undefined): DispatchParkContext {
  const lane = dispatch ? laneOf(dispatch) : undefined;
  const report = dispatch && lane ? readStatusLog(dispatch, lane).filter(entry =>
    entry.verb === 'paused' || entry.verb === 'needs-decision' || entry.verb === 'blocked').at(-1) : undefined;
  return { ...(report ? { report } : {}), ...(instructions !== undefined ? { instructions } : {}) };
}

/**
 * Bring the records in line with the registrations on disk. A new
 * registration gets a record; one whose file is gone while its trap is live
 * ends; one whose dispatch has finished ends. Returns the keys that ended.
 */
export function syncTurnWaitRecords(now = Date.now()): string[] {
  const ended: string[] = [];
  const traps = new Map(listTraps().map((t) => [t.sessionId, t]));
  const registered = new Map<string, TurnWait>();
  for (const session of lobstahTurnSessions()) for (const w of readTurnWaits(session)) registered.set(w.key, w);
  for (const [key, w] of registered) {
    const trap = traps.get(w.session);
    if (!trap) continue;
    noteSeenTool(w.from);
    const existing = readRecord(key);
    const cwd = w.cwd ?? readTurnOwner(w.session)?.cwd ?? trap.cwd;
    const retargeted = existing && (existing.wait !== w.wait || existing.read !== w.read || existing.cwd !== cwd);
    const dispatch = retargeted ? (hasOpenCatch(trap) ? trap.claimed : existing.dispatch) : existing?.dispatch ?? (hasOpenCatch(trap) ? trap.claimed : undefined);
    const previous = existing ?? readTurnWaitRecords().find(record => record.dispatch === dispatch &&
      record.from === w.from && record.read === w.read && turnWaitOwnerId(record) === trap.trapId);
    const parkContext = savedParkContext(dispatch, w.context ?? (previous?.dispatch === dispatch ? previous?.parkContext?.instructions : undefined));
    if (dispatch) {
      const lane = laneOf(dispatch);
      if (lane && trap.claimed === dispatch) pinTrapCatch(dispatch, lane, trap.trapId, dispatchParkContextText({ dispatch, cwd, read: w.read, parkContext }));
    }
    const changed = !existing || existing.wait !== w.wait || existing.read !== w.read || existing.dispatch !== dispatch ||
      existing.cwd !== cwd || JSON.stringify(existing.parkContext) !== JSON.stringify(parkContext);
    if (!changed) continue;
    writeRecord({
      ...(previous ?? {}),
      key,
      session: w.session,
      trapId: trap.trapId,
      ...(dispatch ? { dispatch } : {}),
      from: w.from,
      wait: w.wait,
      read: w.read,
      cwd,
      ...(previous?.cursor ?? w.cursor ? { cursor: previous?.cursor ?? w.cursor } : {}),
      parkContext,
      registeredAt: existing?.registeredAt ?? new Date(now).toISOString(),
    });
  }
  const records = readTurnWaitRecords();
  for (const r of records) {
    // Once the new session registers the same wait, only its watcher runs.
    const superseded = records.some((next) => next.key !== r.key &&
      next.dispatch === r.dispatch && next.from === r.from && next.read === r.read &&
      next.session === readTrap(next.trapId)?.sessionId && next.session !== r.session);
    const withdrawn = !registered.has(r.key) && readTrap(r.trapId)?.sessionId === r.session;
    const finished = r.dispatch ? dispatchEnded(r.dispatch) : liveTrap(r) === undefined;
    if (superseded || withdrawn || finished) {
      removeRecord(r.key);
      ended.push(r.key);
    }
  }
  return ended;
}

/** The one-line pointer a wake carries. */
export function pointerText(r: Pick<TurnWaitRecord, 'from' | 'read'>, summary: string | undefined): string {
  return `${r.from} has something new${summary ? `: ${summary}` : ''}. Run \`${r.read}\` to see it.`;
}

/**
 * One line a wait printed. Records its cursor, then wakes the session:
 * a live trap gets the pointer in its dispatch's inbox (or its own, between
 * dispatches). A missing owner's pointer stays in that dispatch's inbox for
 * its re-thrown trap, with the saved park context. Never creates a new dispatch.
 */
export function deliverTurnWaitLine(key: string, line: string, now = Date.now()): 'inbox' | 'trap' | 'dropped' {
  const r = readRecord(key);
  if (!r) return 'dropped';
  let parsed: { cursor?: unknown; summary?: unknown };
  try {
    parsed = JSON.parse(line) as typeof parsed;
  } catch {
    parsed = { summary: line.trim().slice(0, 200) };
  }
  const summary = typeof parsed.summary === 'string' ? parsed.summary.slice(0, 200) : undefined;
  const next: TurnWaitRecord = { ...r, ...(typeof parsed.cursor === 'string' || typeof parsed.cursor === 'number' ? { cursor: String(parsed.cursor) } : {}) };
  const text = pointerText(r, summary);
  const from = `wait:${r.from}`;
  const trap = liveTrap(r);
  const lane = r.dispatch ? laneOf(r.dispatch) : undefined;
  let outcome: ReturnType<typeof deliverTurnWaitLine>;
  if (r.dispatch && lane && !dispatchEnded(r.dispatch)) {
    next.pointer = { inbox: r.dispatch, lane, file: sendMessage(r.dispatch, lane, text, from), at: new Date(now).toISOString() };
    outcome = 'inbox';
  } else if (!r.dispatch && trap) {
    sendTrapMessage(trap.trapId, from, text);
    outcome = 'trap';
  } else {
    outcome = 'dropped';
  }
  writeRecord(next);
  return outcome;
}

/**
 * One helm notice per pointer a live trap hasn't read after STALE_MS: the
 * trap has stopped receiving. Returns the keys it noticed.
 */
export function noticeUnreadPointers(now = Date.now()): string[] {
  const noticed: string[] = [];
  for (const r of readTurnWaitRecords()) {
    const p = r.pointer;
    if (!p || p.staleNoticed || now - Date.parse(p.at) < STALE_MS) continue;
    if (!unhandled(p.inbox, p.lane).some((m) => m.file === p.file)) continue;
    const trap = readTrap(r.trapId);
    const name = trap ? trapLabel(trap) : r.trapId;
    postNotice({
      kind: 'trap-not-receiving',
      text: `trap ${name} hasn't read ${r.from}'s news in ${Math.round(STALE_MS / 60_000)} minutes: it has stopped receiving. Check its session, or re-address dispatch ${p.inbox}.`,
      refId: p.inbox,
      ...(storedDescriptor(p.inbox, p.lane)?.repo ? { repo: storedDescriptor(p.inbox, p.lane)!.repo } : {}),
    });
    writeRecord({ ...r, pointer: { ...p, staleNoticed: true } });
    noticed.push(r.key);
  }
  return noticed;
}

/** The saved waiting report and tool context, shown to the replacement trap as recovery instructions. */
export function parkContextText(record: Pick<TurnWaitRecord, 'dispatch' | 'cwd' | 'read' | 'parkContext'>): string {
  const report = record.parkContext?.report;
  return [
    `Saved park context for dispatch ${record.dispatch}:`,
    `Working directory: ${record.cwd}`,
    ...(report?.note ? [report.note] : []),
    ...(report?.waitingOn ? [`Waiting on: ${report.waitingOn}`] : []),
    ...(report?.link ? [`Link: ${report.link}`] : []),
    ...(record.parkContext?.instructions ? [record.parkContext.instructions] : []),
    `Read command: \`${record.read}\``,
    'Restore this context in your own session, then register the wait and park again.',
  ].join('\n');
}

/** Preserve every tool's recorded context when several waits belong to the same dispatch. */
function dispatchParkContextText(record: Pick<TurnWaitRecord, 'dispatch' | 'cwd' | 'read' | 'parkContext'>): string {
  const otherContexts = readTurnWaitRecords().filter(other => other.dispatch === record.dispatch &&
    (other.cwd !== record.cwd || other.read !== record.read)).map(parkContextText);
  return [...new Set([parkContextText(record), ...otherContexts])].sort().join('\n\n');
}

/** What starts a wait: injectable for tests. */
export type SpawnWait = (command: string, cwd: string) => ChildProcess;
const spawnWait: SpawnWait = (command, cwd) => spawn(command, { shell: true, cwd: fs.existsSync(cwd) ? cwd : undefined, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

/** Bring back the existing trap through its normal interactive launch path, never a runner fork. */
export type RethrowTurnWaitTrap = (trapId: string) => Promise<void>;
const rethrowTurnWaitTrap: RethrowTurnWaitTrap = async (trapId) => {
  await throwTrap({ cfg: loadConfig(), address: `wt:${trapId}` });
};

/** Dependencies for restarting a missing owner; wait process injection remains separate. */
export interface TurnWaitOptions {
  rethrow?: RethrowTurnWaitTrap;
}

/**
 * The daemon's turn-waits pass: sync the records, start each due wait that
 * isn't running, stop the ones whose record ended, and notice unread
 * pointers. `children` lives across passes.
 */
export function createTurnWaits(start: SpawnWait = spawnWait, options: TurnWaitOptions = {}): { pass: (now: number, log: (m: string) => void) => void; children: Map<string, ChildProcess> } {
  const children = new Map<string, ChildProcess>();
  const restarting = new Set<string>();
  // A wait outlives no daemon: the next one starts it again.
  process.once('exit', () => {
    for (const child of children.values()) child.kill();
  });
  const pass = (now: number, log: (m: string) => void): void => {
    for (const key of syncTurnWaitRecords(now)) {
      children.get(key)?.kill();
      children.delete(key);
      log(`turn wait ${key}: ended`);
    }
    for (const r of readTurnWaitRecords()) {
      if (children.has(r.key) || (r.nextRunAt && Date.parse(r.nextRunAt) > now)) continue;
      const child = start(turnWaitCommand(r.wait, r.cursor), r.cwd);
      children.set(r.key, child);
      let buffered = '';
      let printed = false;
      let errText = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        let nl: number;
        while ((nl = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (!line) continue;
          printed = true;
          log(`turn wait ${r.key}: ${deliverTurnWaitLine(r.key, line)}`);
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        errText = (errText + chunk.toString('utf8')).slice(-500);
      });
      child.on('close', (code, signal) => {
        children.delete(r.key);
        if (buffered.trim()) {
          printed = true;
          log(`turn wait ${r.key}: ${deliverTurnWaitLine(r.key, buffered.trim())}`);
        }
        const current = readRecord(r.key);
        if (!current) return;
        const failed = !printed && signal === null && code !== null && !QUIET_EXITS.has(code);
        if (failed) {
          const failures = (current.failures ?? 0) + 1;
          const error = errText.trim().split('\n').at(-1) || `exit ${String(code)}`;
          writeRecord({ ...current, failures, lastError: error, nextRunAt: new Date(Date.now() + backoffMs(failures)).toISOString() });
          log(`turn wait ${r.key}: failed (${error}); retry in ${Math.round(backoffMs(failures) / 1000)}s`);
        } else if (current.failures || current.nextRunAt || current.lastError) {
          const { failures: _f, nextRunAt: _n, lastError: _e, ...rest } = current;
          writeRecord(rest);
        }
      });
    }
    for (const record of readTurnWaitRecords()) {
      const pointer = record.pointer;
      if (!record.dispatch || !pointer || !unhandled(pointer.inbox, pointer.lane).some(message => message.file === pointer.file)) continue;
      const ownerId = turnWaitOwnerId(record);
      if (readTrap(ownerId) || readReservation(ownerId) || restarting.has(ownerId) ||
        (record.ownerRestart && Date.parse(record.ownerRestart.nextAttemptAt) > now)) continue;
      restarting.add(ownerId);
      void (async () => {
        if (!restoreTrapCatch(record.dispatch!, pointer.lane, ownerId, dispatchParkContextText(record))) return;
        await (options.rethrow ?? rethrowTurnWaitTrap)(ownerId);
        log(`turn wait ${record.key}: owner wt:${ownerId} re-thrown for ${record.dispatch}`);
      })().catch(error => {
        const current = readRecord(record.key);
        if (!current) return;
        const failures = (current.ownerRestart?.failures ?? 0) + 1;
        const lastError = error instanceof Error ? error.message : String(error);
        writeRecord({ ...current, ownerRestart: { failures, lastError, nextAttemptAt: new Date(Date.now() + backoffMs(failures)).toISOString() } });
        log(`turn wait ${record.key}: owner restart failed (${lastError})`);
      }).finally(() => restarting.delete(ownerId));
    }
    noticeUnreadPointers(now);
  };
  return { pass, children };
}

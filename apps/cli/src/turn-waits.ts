import fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  atomicRenameSync,
  enqueue,
  hasOpenCatch,
  laneOf,
  listTraps,
  lobstahHome,
  lobstahTurnSessions,
  postNotice,
  readDirIfPresent,
  readStatusLog,
  readTrap,
  readTurnOwner,
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
import type { Lane, TrapRegistration, TurnWait } from '@lobstah/core';

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
 *   trap that's gone through a continuation of its dispatch.
 * - A pointer the trap hasn't read after STALE_MS raises one helm notice:
 *   nobody is listening.
 * - A record ends when its registration file is removed while the trap is
 *   live, or when its dispatch has finished.
 */

/** How long a pointer may sit unread before the helm hears. */
export const STALE_MS = 15 * 60_000;
/** A wait that exits non-zero sooner than this failed; a later exit is a quiet timeout. */
const QUICK_EXIT_MS = 10_000;
/** Backoff after a failed wait: 5 s, doubling, at most 5 minutes. */
const backoffMs = (failures: number): number => Math.min(300_000, 5_000 * 2 ** Math.max(0, failures - 1));

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
  /** Consecutive failed runs, and when the next run may start. */
  failures?: number;
  nextRunAt?: string;
  lastError?: string;
  /** The last pointer delivered to a live trap: the inbox it went to and its file. */
  pointer?: { inbox: string; lane: Lane; file: string; at: string; staleNoticed?: boolean };
  /** The continuation queued for a trap that's gone; one at a time. */
  followUp?: string;
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

/** The live trap a record belongs to, when it still runs the same session. */
function liveTrap(r: TurnWaitRecord): TrapRegistration | undefined {
  const t = readTrap(r.trapId);
  return t && t.sessionId === r.session ? t : undefined;
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
    const dispatch = hasOpenCatch(trap) ? trap.claimed : existing?.dispatch;
    const changed = !existing || existing.wait !== w.wait || existing.read !== w.read || existing.dispatch !== dispatch;
    if (!changed) continue;
    writeRecord({
      ...(existing ?? {}),
      key,
      session: w.session,
      trapId: trap.trapId,
      ...(dispatch ? { dispatch } : {}),
      from: w.from,
      wait: w.wait,
      read: w.read,
      cwd: w.cwd ?? readTurnOwner(w.session)?.cwd ?? trap.cwd,
      ...(existing?.cursor ?? w.cursor ? { cursor: existing?.cursor ?? w.cursor } : {}),
      registeredAt: existing?.registeredAt ?? new Date(now).toISOString(),
    });
  }
  for (const r of readTurnWaitRecords()) {
    const withdrawn = !registered.has(r.key) && liveTrap(r) !== undefined;
    const finished = r.dispatch ? dispatchEnded(r.dispatch) : liveTrap(r) === undefined;
    if (withdrawn || finished) {
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
 * dispatches); a trap that's gone gets a continuation of its dispatch, one
 * at a time. Returns where the pointer went.
 */
export function deliverTurnWaitLine(key: string, line: string, now = Date.now()): 'inbox' | 'trap' | 'continuation' | 'held' | 'dropped' {
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
  if (trap && r.dispatch && lane && !dispatchEnded(r.dispatch)) {
    next.pointer = { inbox: r.dispatch, lane, file: sendMessage(r.dispatch, lane, text, from), at: new Date(now).toISOString() };
    outcome = 'inbox';
  } else if (trap) {
    sendTrapMessage(trap.trapId, from, text);
    outcome = 'trap';
  } else if (r.dispatch && lane && !dispatchEnded(r.dispatch)) {
    if (r.followUp && !dispatchEnded(r.followUp)) {
      outcome = 'held';
    } else {
      const descriptor = storedDescriptor(r.dispatch, lane);
      const id = randomUUID();
      enqueue({ id, repo: descriptor?.repo ?? '', brief: text, followUp: r.dispatch }, 'work');
      next.followUp = id;
      outcome = 'continuation';
    }
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

/** What starts a wait: injectable for tests. */
export type SpawnWait = (command: string, cwd: string) => ChildProcess;
const spawnWait: SpawnWait = (command, cwd) => spawn(command, { shell: true, cwd: fs.existsSync(cwd) ? cwd : undefined, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

/**
 * The daemon's turn-waits pass: sync the records, start each due wait that
 * isn't running, stop the ones whose record ended, and notice unread
 * pointers. `children` lives across passes.
 */
export function createTurnWaits(start: SpawnWait = spawnWait): { pass: (now: number, log: (m: string) => void) => void; children: Map<string, ChildProcess> } {
  const children = new Map<string, ChildProcess>();
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
      const startedAt = Date.now();
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
      child.on('close', (code) => {
        children.delete(r.key);
        if (buffered.trim()) {
          printed = true;
          log(`turn wait ${r.key}: ${deliverTurnWaitLine(r.key, buffered.trim())}`);
        }
        const current = readRecord(r.key);
        if (!current) return;
        const failed = !printed && code !== 0 && Date.now() - startedAt < QUICK_EXIT_MS;
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
    noticeUnreadPointers(now);
  };
  return { pass, children };
}

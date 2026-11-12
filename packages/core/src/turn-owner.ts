import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicRenameSync, uniqueTempPath } from './paths.js';

/**
 * The turn-end contract: one tool owns a session's turn end, and every other
 * tool that would wait there registers a wait for the owner to run instead.
 * Neither side names the other. A harness starts every Stop hook together and
 * continues only when all have returned, so two hooks that each wait hold
 * each other up; with one owner, only one hook waits.
 *
 *   ~/.agent-turn/<session>/owner.json     the owner: { owner, since, cwd, waits }
 *   ~/.agent-turn/<session>/waits/<n>.json one registration per waiting tool
 *
 * The session is the harness's session id, which every hook gets in its
 * input. A registration is
 *
 *   { "from": "<tool>", "wait": "<command>", "read": "<command>", "cwd"?, "cursor"? }
 *
 * `wait` blocks until there is something new and prints one JSON line,
 * `{ "cursor": "<next>", "summary": "<one line>" }`, then exits. `{cursor}`
 * in it is replaced by the last cursor it printed, or by the registration's
 * `cursor` the first time. It must not move what `read` shows the agent.
 * `read` is the command the agent runs to see what's new. The owner runs
 * `wait` and wakes the session with a pointer to `read`, never the content.
 *
 * In a lobstah trap, lobstah's park is the owner. This module reads and
 * writes the files; apps/cli's turn-waits runs the waits.
 */

/** The owner name lobstah writes. */
export const LOBSTAH_TURN_OWNER = 'lobstah';

/** One tool's name: lower-case letters, digits, `.`, `_` and `-`. */
const TOOL_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
/** A harness session id, as a path segment. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The longest command a registration may carry. */
const MAX_COMMAND = 2000;

export interface TurnOwner {
  owner: string;
  /** When the owner took the turn end (ISO). */
  since: string;
  /** The session's working folder, for a wait that needs one. */
  cwd: string;
  /** Where registrations go: the absolute path of `waits/`. */
  waits: string;
}

export interface TurnWaitRegistration {
  /** The registering tool. */
  from: string;
  /** Blocks until there is something new, prints one JSON line, exits. */
  wait: string;
  /** What the agent runs to see what's new. */
  read: string;
  /** Where to run `wait`; the owner's cwd when absent. */
  cwd?: string;
  /** The cursor `{cursor}` starts from. */
  cursor?: string;
}

/** A registration as read from disk, with where it came from. */
export interface TurnWait extends TurnWaitRegistration {
  session: string;
  /** `<session>/<file name>`: stable while the file stands. */
  key: string;
  file: string;
}

/** Where the contract's files live: `AGENT_TURN_HOME`, else `~/.agent-turn`. */
export function turnHome(): string {
  return process.env.AGENT_TURN_HOME ?? path.join(os.homedir(), '.agent-turn');
}

const sessionDir = (session: string): string => path.join(turnHome(), session);
const ownerPath = (session: string): string => path.join(sessionDir(session), 'owner.json');

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** The session's turn-end owner, if one is recorded. */
export function readTurnOwner(session: string): TurnOwner | undefined {
  if (!SESSION_ID.test(session)) return undefined;
  const o = readJson(ownerPath(session)) as Partial<TurnOwner> | undefined;
  return o && typeof o.owner === 'string' && typeof o.waits === 'string' ? (o as TurnOwner) : undefined;
}

/**
 * Take a session's turn end for lobstah. A session another tool already owns
 * stays theirs: returns false and writes nothing. Re-taking it refreshes the
 * cwd and keeps `since`. Never throws.
 */
export function claimTurnEnd(session: string, cwd: string, now = Date.now()): boolean {
  try {
    if (!SESSION_ID.test(session)) return false;
    const current = readTurnOwner(session);
    if (current && current.owner !== LOBSTAH_TURN_OWNER) return false;
    const waits = path.join(sessionDir(session), 'waits');
    fs.mkdirSync(waits, { recursive: true, mode: 0o700 });
    const owner: TurnOwner = { owner: LOBSTAH_TURN_OWNER, since: current?.since ?? new Date(now).toISOString(), cwd, waits };
    const file = ownerPath(session);
    const tmp = uniqueTempPath(file);
    fs.writeFileSync(tmp, JSON.stringify(owner, null, 2), { mode: 0o600 });
    atomicRenameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Give a session's turn end back. Only lobstah's own owner file is removed;
 * registrations stay, so a wait for a trap that went away still runs.
 * Never throws.
 */
export function releaseTurnEnd(session: string): void {
  try {
    if (readTurnOwner(session)?.owner === LOBSTAH_TURN_OWNER) fs.rmSync(ownerPath(session), { force: true });
  } catch {
    // Releasing is best effort: a stale owner file only makes a tool register a wait nobody runs.
  }
}

/** Why a registration is refused, or undefined when it is valid. */
export function turnWaitProblem(r: unknown): string | undefined {
  if (!r || typeof r !== 'object') return 'not a JSON object';
  const o = r as Record<string, unknown>;
  if (typeof o.from !== 'string' || !TOOL_NAME.test(o.from)) return '"from" must be a tool name (a-z, 0-9, . _ -)';
  for (const field of ['wait', 'read'] as const) {
    const v = o[field];
    if (typeof v !== 'string' || v.trim() === '' || v.length > MAX_COMMAND) return `"${field}" must be a command of at most ${MAX_COMMAND} characters`;
  }
  if (o.cwd !== undefined && (typeof o.cwd !== 'string' || !path.isAbsolute(o.cwd))) return '"cwd" must be an absolute path';
  if (o.cursor !== undefined && typeof o.cursor !== 'string') return '"cursor" must be a string';
  return undefined;
}

/** The registrations waiting in a session's `waits/`, valid ones only, by file name. */
export function readTurnWaits(session: string): TurnWait[] {
  if (!SESSION_ID.test(session)) return [];
  const dir = path.join(sessionDir(session), 'waits');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: TurnWait[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const r = readJson(file);
    if (turnWaitProblem(r) !== undefined) continue;
    const reg = r as TurnWaitRegistration;
    out.push({
      session,
      key: `${session}/${name}`,
      file,
      from: reg.from,
      wait: reg.wait,
      read: reg.read,
      ...(reg.cwd !== undefined ? { cwd: reg.cwd } : {}),
      ...(reg.cursor !== undefined ? { cursor: reg.cursor } : {}),
    });
  }
  return out;
}

/** The sessions whose turn end lobstah owns. */
export function lobstahTurnSessions(): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(turnHome());
  } catch {
    return [];
  }
  return names.filter((s) => readTurnOwner(s)?.owner === LOBSTAH_TURN_OWNER).sort();
}

/**
 * The `wait` command with `{cursor}` filled in and quoted for the shell it
 * runs in: `sh` on macOS and Linux, `cmd.exe` on Windows.
 */
export function turnWaitCommand(wait: string, cursor: string | undefined, platform: NodeJS.Platform = process.platform): string {
  const value = cursor ?? '';
  const quoted = platform === 'win32' ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", `'\\''`)}'`;
  return wait.replaceAll('{cursor}', quoted);
}

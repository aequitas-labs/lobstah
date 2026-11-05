import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_HEAVY, loadConfig } from './config.js';
import type { Config, HeavyConfig } from './config.js';
import { withDirLock } from './dir-lock.js';
import { processStartedAt } from './harness-process.js';
import { atomicRenameSync, lobstahHome, uniqueTempPath } from './paths.js';
import type { Lane } from './types.js';

/**
 * One line per machine for commands heavy enough to overload it, kept as
 * ticket files. Each process manages its own place; a process checking the
 * line clears what the dead left behind, so nothing depends on the daemon.
 *
 * The line never kills or fails work. A holder past its limit loses its slot
 * and keeps running; a caller that hits a queue error runs without a slot.
 */
export type HeavyState = 'waiting' | 'running' | 'over' | 'cancelled';

export interface HeavyTicket {
  seq: number;
  state: HeavyState;
  /** The process that owns the ticket. */
  pid: number;
  /** Its OS start time, which tells it from a later process given the same pid. */
  startedAt?: string;
  /** The running command's own process group, which can outlive `pid`. */
  group?: number;
  session?: string;
  dispatch?: string;
  lane?: Lane;
  trap?: string;
  label?: string;
  repo?: string;
  command: string;
  joinedAt: string;
  runningAt?: string;
  /** Running time that counts against the limit: sleep does not. */
  activeMs: number;
  /** When `activeMs` was last advanced, or when a waiter was last checked. */
  seenAt: number;
  /** When a waiter's process was first found dead. */
  deadAt?: number;
  /** Why a waiter was removed from the line, or a holder lost its slot early. */
  reason?: string;
}

export type HeavyJoin = Pick<HeavyTicket, 'pid' | 'session' | 'dispatch' | 'lane' | 'trap' | 'label' | 'repo' | 'command'>;

export type HeavyStep =
  | { kind: 'run'; slot: number; slots: number }
  | { kind: 'wait'; position: number; running: HeavyTicket[] }
  | { kind: 'cancelled'; reason: string }
  /** The ticket is gone though nobody cancelled it: the queue itself broke. */
  | { kind: 'lost' };

export interface HeavyView {
  slots: number;
  load: number;
  running: HeavyTicket[];
  over: HeavyTicket[];
  waiting: HeavyTicket[];
}

/** How long a killed waiter keeps its place for a retry from the same session. */
export const HEAVY_WAITER_GRACE_MS = 5 * 60_000;
/** The most one tick adds to a holder's active time, so sleep isn't counted. */
const ACTIVE_TICK_CAP_MS = 30_000;
/** A ticket with no start time, unseen this long, is treated as a reused pid. */
const UNVERIFIED_SEEN_MS = 30 * 60_000;
const START_CACHE_MS = 20_000;
const HISTORY_MAX_BYTES = 1024 * 1024;

export const heavyDir = (): string => path.join(lobstahHome(), 'heavy');
const lineDir = (): string => path.join(heavyDir(), 'line');
const ticketFile = (seq: number): string => path.join(lineDir(), `${String(seq).padStart(10, '0')}.json`);

export function heavyCores(): number {
  return os.availableParallelism();
}

export function heavySlots(cfg: HeavyConfig, cores = heavyCores()): number {
  if (cfg.slots !== 'auto') return cfg.slots;
  return cores < 14 ? 1 : 2;
}

export function heavyWorkers(cfg: HeavyConfig, cores = heavyCores()): number {
  if (cfg.workers !== 'auto') return cfg.workers;
  return Math.max(2, Math.floor(cores / 3));
}

/** Vitest 3 reads the FORKS and THREADS names, vitest 4 the WORKERS one. A limit already set stays. */
export function heavyWorkerEnv(workers: number, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['VITEST_MAX_WORKERS', 'VITEST_MAX_FORKS', 'VITEST_MAX_THREADS']) out[key] = env[key] ?? String(workers);
  return out;
}

function withLine<T>(action: () => T): T {
  fs.mkdirSync(lineDir(), { recursive: true });
  return withDirLock(path.join(heavyDir(), 'lock'), action, {
    staleMs: 30_000,
    waitMs: 15_000,
    pauseMs: 25,
    busy: () => new Error('the heavy line is locked'),
  });
}

function writeTicket(ticket: HeavyTicket): void {
  const file = ticketFile(ticket.seq);
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, JSON.stringify(ticket, null, 2));
  atomicRenameSync(tmp, file);
}

function removeTicket(seq: number): void {
  fs.rmSync(ticketFile(seq), { force: true });
}

function readTicket(seq: number): HeavyTicket | undefined {
  try {
    return JSON.parse(fs.readFileSync(ticketFile(seq), 'utf8')) as HeavyTicket;
  } catch {
    return undefined;
  }
}

/** The line in order. A corrupt ticket is dropped: it must not block anyone. */
function readLine(): HeavyTicket[] {
  let names: string[];
  try {
    names = fs.readdirSync(lineDir());
  } catch {
    return [];
  }
  const out: HeavyTicket[] = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const file = path.join(lineDir(), name);
    try {
      const t = JSON.parse(fs.readFileSync(file, 'utf8')) as HeavyTicket;
      if (!Number.isInteger(t.seq) || !Number.isInteger(t.pid)) throw new Error('not a ticket');
      out.push(t);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') fs.rmSync(file, { force: true });
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

function signalable(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The process's OS start time, 'gone' when it isn't running (an unreaped
 * zombie included), or 'unknown' when it can't be read: Codex's sandbox blocks
 * `ps`, and a sandboxed process then has only the pid to go on.
 */
function osStartTime(pid: number): string {
  if (process.platform === 'win32') return processStartedAt(pid) ?? 'unknown';
  try {
    const out = execFileSync('ps', ['-o', 'stat=,lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' },
    }).trim();
    const match = /^(\S+)\s+(.+)$/.exec(out);
    return match && !match[1]!.startsWith('Z') ? match[2]! : 'gone';
  } catch (err) {
    return (err as { status?: number | null }).status === 1 ? 'gone' : 'unknown';
  }
}

const startCache = new Map<number, { at: number; start: string }>();

function cachedStart(pid: number, now: number): string {
  const hit = startCache.get(pid);
  if (hit && now - hit.at < START_CACHE_MS) return hit.start;
  const start = osStartTime(pid);
  startCache.set(pid, { at: now, start });
  return start;
}

/** This process's start time, when it can be read. */
export function heavyProcessStart(pid: number): string | undefined {
  const start = osStartTime(pid);
  return start === 'gone' || start === 'unknown' ? undefined : start;
}

function ownerAlive(t: HeavyTicket, now: number): boolean {
  if (!signalable(t.pid)) return false;
  if (!t.startedAt) return now - t.seenAt < UNVERIFIED_SEEN_MS;
  const start = cachedStart(t.pid, now);
  return start === 'unknown' || start === t.startedAt;
}

function groupAlive(t: HeavyTicket): boolean {
  return t.group !== undefined && process.platform !== 'win32' && signalable(-t.group);
}

function recordRun(t: HeavyTicket, exit: number | undefined, now: number): void {
  try {
    const file = path.join(heavyDir(), 'history.jsonl');
    const line = JSON.stringify({
      repo: t.repo, command: t.command, trap: t.trap, dispatch: t.dispatch,
      joinedAt: t.joinedAt, runningAt: t.runningAt, endedAt: new Date(now).toISOString(),
      activeMs: t.activeMs, overLimit: t.state === 'over', ...(exit === undefined ? {} : { exit }),
    });
    fs.appendFileSync(file, `${line}\n`);
    if (fs.statSync(file).size > HISTORY_MAX_BYTES) {
      const kept = fs.readFileSync(file, 'utf8').split('\n').slice(-2000).join('\n');
      const tmp = uniqueTempPath(file);
      fs.writeFileSync(tmp, kept);
      atomicRenameSync(tmp, file);
    }
  } catch {
    /* run times inform a default; losing one must not touch the command */
  }
}

/** Clear the dead, count time for an orphaned command, and apply the limit. Holds the lock. */
function settle(limitMs: number, now: number): HeavyTicket[] {
  const kept: HeavyTicket[] = [];
  for (const t of readLine()) {
    const alive = ownerAlive(t, now);
    if (t.state === 'waiting' || t.state === 'cancelled') {
      if (alive) {
        if (t.deadAt !== undefined || now - t.seenAt >= START_CACHE_MS) {
          delete t.deadAt;
          t.seenAt = now;
          writeTicket(t);
        }
      } else {
        // A cancelled waiter that died has nobody left to read the reason.
        if (t.state === 'cancelled' || (t.deadAt !== undefined && now - t.deadAt >= HEAVY_WAITER_GRACE_MS)) {
          removeTicket(t.seq);
          continue;
        }
        if (t.deadAt === undefined) {
          t.deadAt = now;
          writeTicket(t);
        }
      }
      kept.push(t);
      continue;
    }
    if (!alive && !groupAlive(t)) {
      recordRun(t, undefined, now);
      removeTicket(t.seq);
      continue;
    }
    if (!alive) advance(t, limitMs, now);
    kept.push(t);
  }
  return kept;
}

function advance(t: HeavyTicket, limitMs: number, now: number): boolean {
  t.activeMs += Math.max(0, Math.min(now - t.seenAt, ACTIVE_TICK_CAP_MS));
  t.seenAt = now;
  const over = t.state === 'running' && t.activeMs >= limitMs;
  if (over) t.state = 'over';
  writeTicket(t);
  return over;
}

let lastGood: HeavyConfig | undefined;

/** Read on every check, so a change applies with no restart. A config mid-edit keeps the last good one. */
function settings(cfg?: Config): HeavyConfig {
  try {
    lastGood = (cfg ?? loadConfig()).heavy ?? DEFAULT_HEAVY;
  } catch {
    /* lastGood stands */
  }
  return lastGood ?? DEFAULT_HEAVY;
}

/** Join the back of the line. A retry from a session or trap whose waiter was killed takes that place back. */
export function joinHeavyLine(input: HeavyJoin, now = Date.now()): HeavyTicket {
  const startedAt = heavyProcessStart(input.pid);
  return withLine(() => {
    const line = settle(settings().holdLimitMins * 60_000, now);
    const sameOwner = (t: HeavyTicket) => (input.session !== undefined && t.session === input.session) || (input.trap !== undefined && t.trap === input.trap);
    const place = line.find((t) => t.state === 'waiting' && t.deadAt !== undefined && sameOwner(t) && t.repo === input.repo);
    const seqFile = path.join(heavyDir(), 'seq');
    let seq = place?.seq;
    if (seq === undefined) {
      let stored = 0;
      try {
        stored = Number(fs.readFileSync(seqFile, 'utf8')) || 0;
      } catch {
        /* first ticket, or a lost counter: the line itself still orders */
      }
      seq = Math.max(stored, ...line.map((t) => t.seq)) + 1;
      fs.writeFileSync(seqFile, String(seq));
    }
    const ticket: HeavyTicket = {
      ...input, seq, state: 'waiting', activeMs: 0, seenAt: now,
      joinedAt: place?.joinedAt ?? new Date(now).toISOString(),
      ...(startedAt ? { startedAt } : {}),
    };
    writeTicket(ticket);
    return ticket;
  });
}

/** One check of the line: start now if this ticket is next and a slot is free. */
export function checkHeavyLine(seq: number, now = Date.now()): HeavyStep {
  const cfg = settings();
  return withLine(() => {
    const line = settle(cfg.holdLimitMins * 60_000, now);
    const me = line.find((t) => t.seq === seq);
    if (!me) return { kind: 'lost' };
    if (me.state === 'cancelled') {
      removeTicket(seq);
      return { kind: 'cancelled', reason: me.reason ?? 'removed from the line' };
    }
    const running = line.filter((t) => t.state === 'running');
    const slots = heavySlots(cfg);
    const ahead = line.filter((t) => t.state === 'waiting' && t.deadAt === undefined && t.seq < seq);
    if (ahead.length === 0 && running.length < slots) {
      me.state = 'running';
      me.runningAt = new Date(now).toISOString();
      me.seenAt = now;
      me.activeMs = 0;
      writeTicket(me);
      return { kind: 'run', slot: running.length + 1, slots };
    }
    return { kind: 'wait', position: ahead.length + 1, running };
  });
}

/** Record the running command's own process group. */
export function setHeavyGroup(seq: number, group: number): void {
  withLine(() => {
    const t = readTicket(seq);
    if (t) writeTicket({ ...t, group });
  });
}

/** A holder's heartbeat. True on the tick that takes it past its limit. */
export function tickHeavyTicket(seq: number, now = Date.now()): boolean {
  const limitMs = settings().holdLimitMins * 60_000;
  return withLine(() => {
    const t = readTicket(seq);
    return t && t.state !== 'waiting' && t.state !== 'cancelled' ? advance(t, limitMs, now) : false;
  });
}

/** The command ended: free its slot and keep its run time. */
export function releaseHeavyTicket(seq: number, exit?: number, now = Date.now()): void {
  withLine(() => {
    const t = readTicket(seq);
    if (!t) return;
    if (t.state === 'running' || t.state === 'over') recordRun(t, exit, now);
    removeTicket(seq);
  });
}

/**
 * The owner of these tickets stopped answering for them: a stowed or swept
 * trap, or a cancelled dispatch. Waiting commands exit having run nothing;
 * running ones keep going without a slot.
 */
export function dropHeavyTickets(match: { dispatch?: string; trap?: string }, reason: string): number {
  return withLine(() => {
    let dropped = 0;
    for (const t of readLine()) {
      const mine = (match.dispatch !== undefined && t.dispatch === match.dispatch) || (match.trap !== undefined && t.trap === match.trap);
      if (!mine) continue;
      if (t.state === 'waiting') writeTicket({ ...t, state: 'cancelled', reason });
      else if (t.state === 'running') writeTicket({ ...t, state: 'over', reason });
      else continue;
      dropped++;
    }
    return dropped;
  });
}

/** The line as it stands. Read-only: clearing the dead is left to whoever next joins or checks. */
export function heavyView(now = Date.now(), cfg?: Config): HeavyView {
  const line = readLine();
  const live = line.filter((t) => t.state === 'waiting' ? t.deadAt === undefined && ownerAlive(t, now) : t.state === 'cancelled' ? false : ownerAlive(t, now) || groupAlive(t));
  return {
    slots: heavySlots(settings(cfg)),
    load: os.loadavg()[0] ?? 0,
    running: live.filter((t) => t.state === 'running'),
    over: live.filter((t) => t.state === 'over'),
    waiting: live.filter((t) => t.state === 'waiting'),
  };
}

export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

function minutes(fromIso: string | undefined, now: number): string {
  const from = fromIso ? Date.parse(fromIso) : NaN;
  return `${Number.isFinite(from) ? Math.max(0, Math.floor((now - from) / 60_000)) : 0}m`;
}

/** Who a ticket is for, as a person reads it: `homebase · fresh-cove`. */
export function heavyWho(t: HeavyTicket): string {
  const who = t.label ?? (t.dispatch ? `worker ${t.dispatch.slice(0, 8)}` : undefined);
  return [t.repo, who].filter(Boolean).join(' · ') || `pid ${t.pid}`;
}

/** `Running: homebase · fresh-cove (6m), lobstah · amber-gull (1m)`, for a waiter's first line. */
export function heavyRunningText(running: HeavyTicket[], now = Date.now()): string {
  return running.map((t) => `${heavyWho(t)} (${minutes(t.runningAt, now)})`).join(', ');
}

export function formatHeavyView(view: HeavyView, now = Date.now()): string {
  const rows = [
    ...view.running.map((t) => ({ state: 'running', t, since: t.runningAt, after: '' })),
    ...view.over.map((t) => ({ state: 'over limit', t, since: t.runningAt, after: '' })),
    ...view.waiting.map((t, i) => ({ state: 'waiting', t, since: t.joinedAt, after: ordinal(i + 1) })),
  ];
  const head = `heavy: ${view.running.length} of ${view.slots} running · ${view.waiting.length} waiting · load ${Math.round(view.load)}`;
  if (rows.length === 0) return head;
  const width = (pick: (r: (typeof rows)[number]) => string) => Math.max(...rows.map((r) => pick(r).length));
  const stateW = width((r) => r.state);
  const whoW = width((r) => heavyWho(r.t));
  const cmdW = width((r) => r.t.command);
  const body = rows.map((r) =>
    `  ${r.state.padEnd(stateW)}  ${heavyWho(r.t).padEnd(whoW)}  ${r.t.command.padEnd(cmdW)}  ${minutes(r.since, now).padStart(4)}${r.after ? `   ${r.after}` : ''}`);
  return [head, ...body].join('\n');
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { soakingDir } from './paths.js';
import { postNotice } from './notices.js';
import { pendingIds, queuedDescriptor } from './queue.js';
import { newTrapId, readTrap, trapLabel } from './soak.js';
import { reserveTrapName, trapIdForName } from './trap-names.js';

/**
 * A reserved trap: the name and id exist before any session signs on, so
 * work can be addressed to it (`dispatch --for <name>`) at once. The session
 * that starts later redeems the reservation's one-time ticket with
 * `lobstah soak --ticket <t>` (or `LOBSTAH_TRAP_TICKET`) and signs on under
 * the reserved name and id. Kept as `soaking/<trapId>.starting`, beside the
 * registrations, and never read as one.
 */
export interface TrapReservation {
  trapId: string;
  name: string;
  repo: string;
  harness?: string;
  /** sha256 of the ticket. The ticket itself is kept only in `<trapId>.ticket` (mode 0600) for this machine's glass. */
  ticketHash: string;
  reservedAt: string;
  /** Sign-on is due by this time. Past it, the reservation fails. */
  deadline: string;
  /** Set when the deadline passed unredeemed. A failed reservation can still be redeemed. */
  failedAt?: string;
  reason?: string;
  /** The session that reserved it. */
  by?: string;
  /** The `trap-request` request this reservation answers. */
  request?: string;
}

/** `<trapId>-<32 hex>`: the id prefix finds the reservation, the rest proves it. */
export const TRAP_TICKET_RE = /^([0-9a-f]{8})-[0-9a-f]{32}$/;

/** The environment variable a launched session's soak reads its ticket from. */
export const TRAP_TICKET_ENV = 'LOBSTAH_TRAP_TICKET';

export const DEFAULT_TRAP_START_SECS = 180;

function startPath(trapId: string): string {
  return path.join(soakingDir(), `${trapId}.starting`);
}

function ticketPath(trapId: string): string {
  return path.join(soakingDir(), `${trapId}.ticket`);
}

/** A reservation's ticket, for the start command on this machine's glass. Never logged. */
export function readReservationTicket(trapId: string): string | undefined {
  if (!/^[0-9a-f]{8}$/.test(trapId)) return undefined;
  try {
    const ticket = fs.readFileSync(ticketPath(trapId), 'utf8').trim();
    return TRAP_TICKET_RE.exec(ticket)?.[1] === trapId ? ticket : undefined;
  } catch {
    return undefined;
  }
}

/** A value as a POSIX shell word, for a command printed for a person to run. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The commands that start a reserved trap's session in the repo's primary
 * checkout, per harness: all harnesses, or only the reserved one.
 */
export function trapStartCommands(repoPath: string, ticket: string, harness?: string): Array<{ harness: 'claude' | 'codex'; command: string }> {
  const cd = `cd ${shellQuote(repoPath)} && `;
  const all: Array<{ harness: 'claude' | 'codex'; command: string }> = [
    { harness: 'claude', command: `${cd}CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 claude "/lobstah:soak --ticket ${ticket}"` },
    { harness: 'codex', command: `${cd}codex '$lobstah:trap soak --ticket ${ticket}'` },
  ];
  return harness === 'claude' || harness === 'codex' ? all.filter((c) => c.harness === harness) : all;
}

function writeReservation(r: TrapReservation): void {
  fs.mkdirSync(soakingDir(), { recursive: true });
  const file = startPath(r.trapId);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
  fs.renameSync(tmp, file);
}

const hashTicket = (ticket: string): string => createHash('sha256').update(ticket).digest('hex');

export function readReservation(trapId: string): TrapReservation | undefined {
  if (!/^[0-9a-f]{8}$/.test(trapId)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(startPath(trapId), 'utf8')) as TrapReservation;
    return typeof parsed.trapId === 'string' && parsed.trapId === trapId ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function listReservations(): TrapReservation[] {
  let files: string[];
  try {
    files = fs.readdirSync(soakingDir()).filter((f) => f.endsWith('.starting'));
  } catch {
    return [];
  }
  return files
    .map((f) => readReservation(f.slice(0, -'.starting'.length)))
    .filter((r): r is TrapReservation => r !== undefined)
    .sort((a, b) => a.reservedAt.localeCompare(b.reservedAt));
}

/** Resolve a bare name, wt:name, bare id, or wt:id to a reservation. */
export function reservationByAddress(address: string): TrapReservation | undefined {
  const value = address.startsWith('wt:') ? address.slice(3) : address;
  if (!/^[a-z0-9-]+$/.test(value)) return undefined;
  return readReservation(trapIdForName(value) ?? value);
}

/**
 * Reserve a trap: a fresh id, a reserved name, and a one-time ticket. The
 * ticket is returned once and stored only as a hash.
 */
export function reserveTrap(opts: {
  repo: string;
  harness?: string;
  name?: string;
  startSecs?: number;
  by?: string;
  request?: string;
  now?: number;
}): { reservation: TrapReservation; ticket: string } {
  const now = opts.now ?? Date.now();
  let trapId = newTrapId();
  while (readTrap(trapId) || readReservation(trapId)) trapId = newTrapId();
  const name = reserveTrapName(trapId, opts.name);
  const ticket = `${trapId}-${randomBytes(16).toString('hex')}`;
  const reservation: TrapReservation = {
    trapId,
    name,
    repo: opts.repo,
    ...(opts.harness ? { harness: opts.harness } : {}),
    ticketHash: hashTicket(ticket),
    reservedAt: new Date(now).toISOString(),
    deadline: new Date(now + (opts.startSecs ?? DEFAULT_TRAP_START_SECS) * 1000).toISOString(),
    ...(opts.by ? { by: opts.by } : {}),
    ...(opts.request ? { request: opts.request } : {}),
  };
  writeReservation(reservation);
  fs.writeFileSync(ticketPath(trapId), ticket, { mode: 0o600 });
  postNotice({
    kind: 'trap-starting',
    text: `trap ${trapLabel(reservation)} reserved for repo ${opts.repo} — starting, sign-on due by ${reservation.deadline}; address work with \`--for ${name}\``,
    refId: trapId,
    repo: opts.repo,
    by: opts.by,
  });
  return { reservation, ticket };
}

/** The reservation a ticket proves, or undefined for a malformed, unknown, or wrong ticket. */
export function reservationForTicket(ticket: string): TrapReservation | undefined {
  const m = TRAP_TICKET_RE.exec(ticket);
  if (!m) return undefined;
  const r = readReservation(m[1]!);
  if (!r) return undefined;
  const want = Buffer.from(r.ticketHash, 'hex');
  const got = Buffer.from(hashTicket(ticket), 'hex');
  return want.length === got.length && timingSafeEqual(want, got) ? r : undefined;
}

/** Remove a reservation: redeemed by a sign-on, or withdrawn. */
export function dropReservation(trapId: string): TrapReservation | undefined {
  const r = readReservation(trapId);
  if (r) fs.rmSync(startPath(trapId), { force: true });
  fs.rmSync(ticketPath(trapId), { force: true });
  return r;
}

/** Withdraw a reservation (`lobstah stow` on a starting trap). Its addressed work stays queued. */
export function withdrawReservation(trapId: string, by?: string): TrapReservation | undefined {
  const r = dropReservation(trapId);
  if (!r) return undefined;
  postNotice({
    kind: 'trap-stowed',
    text: `trap ${trapLabel(r)} reservation withdrawn before sign-on — work addressed to it stays queued`,
    refId: trapId,
    repo: r.repo,
    by,
  });
  return r;
}

function addressedCount(trapId: string): number {
  return pendingIds('work').filter((id) => queuedDescriptor(id, 'work')?.for === `wt:${trapId}`).length;
}

/**
 * Fail every reservation whose deadline passed unredeemed: mark it failed
 * and post one `trap-start-failed` notice. The reservation stays, so its
 * addressed work stays queued and a late session can still redeem it.
 */
export function expireReservations(now = Date.now()): TrapReservation[] {
  const failed: TrapReservation[] = [];
  for (const r of listReservations()) {
    if (r.failedAt || now <= (Date.parse(r.deadline) || 0)) continue;
    const reason = `no session signed on by ${r.deadline}`;
    const next: TrapReservation = { ...r, failedAt: new Date(now).toISOString(), reason };
    writeReservation(next);
    const waiting = addressedCount(r.trapId);
    postNotice({
      kind: 'trap-start-failed',
      text:
        `trap ${trapLabel(r)} did not start: ${reason}. ` +
        (waiting ? `${waiting} dispatch(es) addressed to it stay queued. ` : '') +
        `A session can still redeem its ticket; \`lobstah stow --wt ${r.name}\` withdraws the reservation.`,
      refId: r.trapId,
      repo: r.repo,
      dedupeKey: `start-failed-${r.trapId}-${r.reservedAt}`,
    });
    failed.push(next);
  }
  return failed;
}

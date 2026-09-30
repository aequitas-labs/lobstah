import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  dropReservation,
  enqueue,
  ensureLayout,
  expireReservations,
  listNotices,
  listReservations,
  listTraps,
  noticeOrphanedBait,
  readReservation,
  readTrapAnchor,
  reservationByAddress,
  reservationForTicket,
  reserveTrap,
  signOnTrap,
  trapIdForName,
  TRAP_TICKET_RE,
  withdrawReservation,
  writeTrapAnchor,
} from '../src/index.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-trapstart-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

const T0 = Date.parse('2026-09-01T00:00:00Z');

describe('trap reservations', () => {
  it('reserves a name and id, stores only the ticket hash, and posts trap-starting', () => {
    const { reservation, ticket } = reserveTrap({ repo: 'r', harness: 'claude', name: 'amber-gull', startSecs: 60, now: T0 });
    expect(ticket).toMatch(TRAP_TICKET_RE);
    expect(ticket.startsWith(`${reservation.trapId}-`)).toBe(true);
    expect(reservation).toMatchObject({ name: 'amber-gull', repo: 'r', harness: 'claude', deadline: new Date(T0 + 60_000).toISOString() });
    expect(trapIdForName('amber-gull')).toBe(reservation.trapId);
    const raw = fs.readFileSync(path.join(home, 'soaking', `${reservation.trapId}.starting`), 'utf8');
    expect(raw).not.toContain(ticket);
    expect(listTraps()).toEqual([]);
    expect(listReservations().map((r) => r.trapId)).toEqual([reservation.trapId]);
    expect(listNotices().map((n) => n.kind)).toEqual(['trap-starting']);
  });

  it('resolves by name, wt:name, id, and wt:id', () => {
    const { reservation } = reserveTrap({ repo: 'r', name: 'amber-gull' });
    for (const address of ['amber-gull', 'wt:amber-gull', reservation.trapId, `wt:${reservation.trapId}`]) {
      expect(reservationByAddress(address)?.trapId).toBe(reservation.trapId);
    }
    expect(reservationByAddress('blue-heron')).toBeUndefined();
  });

  it('a ticket proves only its own reservation', () => {
    const a = reserveTrap({ repo: 'r' });
    const b = reserveTrap({ repo: 'r' });
    expect(reservationForTicket(a.ticket)?.trapId).toBe(a.reservation.trapId);
    expect(reservationForTicket(b.ticket)?.trapId).toBe(b.reservation.trapId);
    // b's secret under a's id, a malformed ticket, and a guessed secret all fail.
    expect(reservationForTicket(`${a.reservation.trapId}-${b.ticket.slice(9)}`)).toBeUndefined();
    expect(reservationForTicket('not-a-ticket')).toBeUndefined();
    expect(reservationForTicket(`${a.reservation.trapId}-${'0'.repeat(32)}`)).toBeUndefined();
    dropReservation(a.reservation.trapId);
    expect(reservationForTicket(a.ticket)).toBeUndefined();
  });

  it('an expired reservation fails once, keeps its addressed work queued, and can still be redeemed', () => {
    const { reservation, ticket } = reserveTrap({ repo: 'r', name: 'amber-gull', startSecs: 180, now: T0 });
    enqueue({ id: 'aaaaaaaa-0000-4000-8000-000000000001', repo: 'r', brief: 'x', for: `wt:${reservation.trapId}` }, 'work');
    expect(expireReservations(T0 + 179_000)).toEqual([]);
    const failed = expireReservations(T0 + 181_000);
    expect(failed.map((r) => r.trapId)).toEqual([reservation.trapId]);
    expect(expireReservations(T0 + 300_000)).toEqual([]); // once
    const notice = listNotices().find((n) => n.kind === 'trap-start-failed');
    expect(notice?.refId).toBe(reservation.trapId);
    expect(notice?.text).toContain('1 dispatch(es) addressed to it stay queued');
    expect(readReservation(reservation.trapId)?.failedAt).toBeDefined();
    // The address still holds: no orphan notice while the reservation exists.
    noticeOrphanedBait();
    expect(listNotices(50).some((n) => n.kind === 'bait-orphaned')).toBe(false);
    expect(reservationForTicket(ticket)?.trapId).toBe(reservation.trapId);
    // Withdrawn, the work is orphaned and the helm hears of it.
    withdrawReservation(reservation.trapId);
    expect(readReservation(reservation.trapId)).toBeUndefined();
    noticeOrphanedBait();
    expect(listNotices(50).some((n) => n.kind === 'bait-orphaned')).toBe(true);
  });

  it('signs on as the reserved id and name, and refuses a worktree anchoring another trap', () => {
    const { reservation } = reserveTrap({ repo: 'r', name: 'amber-gull' });
    const wt = path.join(home, 'wt', 'fresh');
    fs.mkdirSync(wt, { recursive: true });
    const res = signOnTrap({ worktree: wt, cwd: wt, repo: 'r', harness: 'claude', sessionId: 's1', trapId: reservation.trapId, ttlMs: 60_000 });
    expect('ok' in res && res.ok).toMatchObject({ trapId: reservation.trapId, name: 'amber-gull' });
    expect(readTrapAnchor(wt)).toMatchObject({ trapId: reservation.trapId, name: 'amber-gull' });

    const other = path.join(home, 'wt', 'other');
    fs.mkdirSync(other, { recursive: true });
    writeTrapAnchor(other, { trapId: 'deadbeef' });
    const next = reserveTrap({ repo: 'r' });
    expect(() =>
      signOnTrap({ worktree: other, cwd: other, repo: 'r', harness: 'claude', sessionId: 's2', trapId: next.reservation.trapId, ttlMs: 60_000 }),
    ).toThrow(/already anchors trap wt:deadbeef/);
  });
});

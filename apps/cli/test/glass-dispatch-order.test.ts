import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, claimNext, enqueue, ensureLayout, laneDirs, sendMessage, writeActivity } from '@lobstah/core';
import { buildGlassSnapshot } from '../src/glass.js';
import { compareByLastUpdate, lastRealUpdateMs } from '../src/dispatch-order.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * The glass orders dispatches by their last real update. A poll where only
 * live activity or a heartbeat changed keeps the order; a status entry or a
 * send moves its row to the top.
 */

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const T0 = Date.parse('2026-11-01T09:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-dispatch-order-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

/** Three dispatches in flight, each with one status entry: A oldest, C newest. */
function inFlight(times: Record<string, number> = { [A]: 1, [B]: 2, [C]: 3 }): void {
  for (const id of [A, B, C]) enqueue({ id, repo: 'web', brief: `work ${id.slice(0, 1)}` });
  for (let i = 0; i < 3; i++) claimNext('work');
  for (const [id, minutes] of Object.entries(times)) appendStatus(id, 'work', 'working', `started ${id.slice(0, 1)}`, at(minutes));
}

/** The in-flight ids in the order the glass lists them. */
const inFlightOrder = (): string[] => buildGlassSnapshot().dispatches.filter((d) => d.bucket === 'active').map((d) => d.id);

/** What a live worker does between polls without a real update: activity, and file writes that bump its directory's mtime. */
function liveTick(id: string, minutes: number): void {
  writeActivity(id, 'work', { at: at(minutes), kind: 'tool', summary: 'Bash cd' });
  const dir = path.join(laneDirs('work').active, id);
  fs.writeFileSync(path.join(dir, 'heartbeat.tmp'), String(minutes));
  // A write lands now, so the directory becomes the newest on disk.
  const when = new Date(Date.now() + minutes * 1000);
  fs.utimesSync(dir, when, when);
}

describe('the glass dispatch order', () => {
  it('keeps the order across two polls that differ only in activity and heartbeats', () => {
    inFlight();
    const first = inFlightOrder();
    expect(first).toEqual([C, B, A]);
    // The oldest dispatch is the busiest one: its activity and directory are now the newest.
    liveTick(A, 30);
    liveTick(B, 20);
    expect(inFlightOrder()).toEqual(first);
  });

  it('a real update moves its row to the top: a new status entry, then a send', () => {
    inFlight();
    appendStatus(A, 'work', 'working', 'pushed the fix', at(10));
    expect(inFlightOrder()).toEqual([A, C, B]);
    sendMessage(B, 'work', 'use the v2 schema', 'helm');
    expect(inFlightOrder()).toEqual([B, A, C]);
  });

  it('breaks a tie by dispatch id, so equal times never swap between polls', () => {
    inFlight({ [A]: 5, [B]: 5, [C]: 5 });
    expect(inFlightOrder()).toEqual([A, B, C]);
    liveTick(C, 40);
    liveTick(A, 1);
    expect(inFlightOrder()).toEqual([A, B, C]);
  });
});

describe('lastRealUpdateMs and compareByLastUpdate', () => {
  it('takes the newest real time, and the directory time only when nothing real is known', () => {
    expect(lastRealUpdateMs({ queuedAt: at(1), claimedAt: at(2), lastStatusAt: at(4), lastSendAt: at(3) }, T0 + 99 * 60_000)).toBe(T0 + 4 * 60_000);
    expect(lastRealUpdateMs({}, 1234)).toBe(1234);
    expect(lastRealUpdateMs({ lastStatusAt: 'not a time' }, 1234)).toBe(1234);
  });

  it('orders newest first, then by id', () => {
    const rows = [
      { id: 'b', sort: 5 },
      { id: 'a', sort: 5 },
      { id: 'c', sort: 9 },
    ];
    expect([...rows].sort(compareByLastUpdate).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });
});

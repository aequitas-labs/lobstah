import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addWatch,
  appendWatchEvents,
  ensureLayout,
  laneDirs,
  readWatch,
  readWatchEvents,
  runWatchCheck,
} from '@lobstah/core';
import type { Descriptor } from '@lobstah/core';
import { handleStreamLine } from '../src/loops/watch.js';
import { SingleFlight } from '../src/run.js';
import type { ReportNotification } from '../src/loops/report.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-event-'));
  process.env.LOBSTAH_HOME = dir;
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('appendWatchEvents', () => {
  it('dedupes by seq so a stream and a poll seeing the same event append once', () => {
    addWatch('k', 'true');
    const e = (seq: number) => ({ seq, summary: `s${seq}`, at: new Date().toISOString() });
    expect(appendWatchEvents('k', [e(1), e(2)])).toHaveLength(2);
    expect(appendWatchEvents('k', [e(2), e(3)])).toHaveLength(1);
    expect(readWatchEvents('k').map((x) => x.seq)).toEqual([1, 2, 3]);
  });
});

describe('handleStreamLine', () => {
  const pings: ReportNotification[] = [];
  const notify = (n: ReportNotification) => pings.push(n);
  beforeEach(() => (pings.length = 0));

  it('appends the event, advances the cursor, and notifies for man-owned', () => {
    addWatch('ume:live', 'true');
    handleStreamLine('ume:live', JSON.stringify({ seq: 7, summary: 'verdict landed', cursor: '7' }), () => {}, notify);
    expect(readWatchEvents('ume:live')).toHaveLength(1);
    expect(readWatch('ume:live')!.cursor).toBe('7');
    expect(pings[0]?.note).toBe('verdict landed');
  });

  it('a bare cursor checkpoint advances without an event', () => {
    addWatch('ume:live', 'true');
    handleStreamLine('ume:live', JSON.stringify({ cursor: '12' }), () => {}, notify);
    expect(readWatchEvents('ume:live')).toHaveLength(0);
    expect(readWatch('ume:live')!.cursor).toBe('12');
    expect(pings).toHaveLength(0);
  });

  it('the cadence check re-seeing a streamed event is a no-op, not a duplicate', () => {
    const script = path.join(dir, 'check.cjs');
    fs.writeFileSync(
      script,
      `console.log(JSON.stringify({ cursor: '7', events: [{ seq: 7, summary: 'verdict landed' }] }));`,
    );
    const w = addWatch('ume:live', `node "${script}"`);
    handleStreamLine('ume:live', JSON.stringify({ seq: 7, summary: 'verdict landed' }), () => {}, notify);
    const { fresh } = runWatchCheck(readWatch('ume:live') ?? w);
    expect(fresh).toHaveLength(0);
    expect(readWatchEvents('ume:live')).toHaveLength(1);
  });

  it('a dispatch-owned stream event forks the continuation immediately', () => {
    const owner = '77777777-7777-7777-7777-777777777777';
    const activeDir = path.join(laneDirs('work').active, owner);
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, 'descriptor.json'), JSON.stringify({ id: owner, repo: 'r', brief: 'b' }));
    addWatch('ume:worker', 'true', { owner: `dispatch:${owner}` });
    handleStreamLine('ume:worker', JSON.stringify({ seq: 1, summary: 'round 1' }), () => {}, notify);
    const queued = fs
      .readdirSync(laneDirs('work').queue)
      .map((f) => JSON.parse(fs.readFileSync(path.join(laneDirs('work').queue, f), 'utf8')) as Descriptor);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.followUp).toBe(owner);
    expect(pings).toHaveLength(0); // dispatch-owned never pings the human channel
  });

  it('garbage lines are logged and skipped, never fatal', () => {
    addWatch('ume:live', 'true');
    const logs: string[] = [];
    handleStreamLine('ume:live', 'not json at all', (m) => logs.push(m), notify);
    expect(logs[0]).toContain('unparseable');
    expect(readWatchEvents('ume:live')).toHaveLength(0);
  });
});

describe('SingleFlight', () => {
  it('runs jobs one at a time in arrival order, surviving failures', async () => {
    const flight = new SingleFlight();
    const order: string[] = [];
    const slow = flight.run(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push('slow');
    });
    const failing = flight.run(() => {
      order.push('failing');
      throw new Error('boom');
    });
    const fast = flight.run(() => order.push('fast'));
    await Promise.allSettled([slow, failing, fast]);
    expect(order).toEqual(['slow', 'failing', 'fast']);
    await expect(failing).rejects.toThrow('boom');
    await expect(fast).resolves.toBeDefined();
  });
});

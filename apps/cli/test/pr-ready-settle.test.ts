import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { derivePrEvents, ensureLayout, loadConfig, parsePrRef, readPr, upsertPr } from '@lobstah/core';
import type { GhPrView, PrEvidence } from '@lobstah/core';
import { buildTendReport } from '../src/tend.js';
import { observePr } from '../src/pr-watch.js';
import { glassPoll } from '../src/glass.js';
import { pruneStaleAcks, readAck, writeAck } from '../src/acks.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-ready-settle-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), 'attentionKinds = ["pr:ready", "pr:draft", "pr:checks", "pr:conflict", "pr:review"]\n');
});
afterEach(() => {
  vi.restoreAllMocks();
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const ref = parsePrRef('https://github.com/acme/web/pull/9')!;
const start = Date.parse('2026-10-06T10:00:00Z');
const iso = (secs: number) => new Date(start + secs * 1000).toISOString();
const green = { total: 1, passed: 1, failed: 0, pending: 0 };
const pending = { total: 1, passed: 0, failed: 0, pending: 1 };
function observe(secs: number, over: Partial<PrEvidence> = {}): void {
  upsertPr({
    url: ref.url, number: 9, state: 'OPEN', draft: false,
    reviewDecision: '', mergeStateStatus: 'CLEAN', headSha: 'head-a',
    checks: green, review: { unresolvedThreads: 0, changesRequested: false }, observedAt: iso(secs), ...over,
  });
}
function attention(secs: number) {
  const items = buildTendReport(start + secs * 1000).attention;
  pruneStaleAcks(items); // CLI views prune, just like attention / man tend.
  return items;
}
const ready = (secs: number) => attention(secs).filter((a) => a.kind === 'pr:ready');
function ack(secs: number): string {
  const item = ready(secs)[0]!;
  writeAck({ key: item.key, kind: item.kind, stateHash: item.stateHash, at: iso(secs), by: 'pet' });
  return item.stateHash;
}

describe('pr:ready settling, shared by all attention readers', () => {
  it('defaults to 600 seconds and stands on a later read without any new forge event', () => {
    expect(loadConfig().readySettleSecs).toBe(600);
    const view: GhPrView = {
      state: 'OPEN', isDraft: false, headRefOid: 'head-a', mergeStateStatus: 'CLEAN', reviewDecision: '',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    };
    observePr(ref, view, { now: new Date(start) });
    const baseline = derivePrEvents(ref, view, '0');
    expect(derivePrEvents(ref, view, baseline.cursor).events).toEqual([]);
    expect(ready(599)).toEqual([]);
    expect(ready(600)).toEqual([expect.objectContaining({ standingSince: iso(600), ageSecs: 0 })]);
    expect(ready(700)).toHaveLength(1);
    expect(readPr(ref.key)?.observations).toBe(1); // no new observation needed
  });

  it.each([300, 900])('resets a same-sha flap at %is, inside or outside the settle window', (flap) => {
    observe(0);
    expect(ready(flap)).toHaveLength(flap < 600 ? 0 : 1);
    observe(flap, { checks: pending });
    expect(ready(flap)).toEqual([]);
    expect(readPr(ref.key)?.standingSince['pr:ready']).toBeUndefined();
    observe(flap + 10);
    expect(ready(flap + 609)).toEqual([]);
    expect(ready(flap + 610)).toHaveLength(1);
  });

  it('changes the glass poll ETag at expiry, so the 304 path cannot hide ready attention', () => {
    observe(0);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start + 599000);
    const before = glassPoll(false);
    expect(JSON.parse(before.body).attention).toEqual([]);
    clock.mockReturnValue(start + 600000);
    const after = glassPoll(false);
    expect(JSON.parse(after.body).attention).toEqual([expect.objectContaining({ kind: 'pr:ready' })]);
    expect(after.hash).not.toBe(before.hash);
    expect(readPr(ref.key)?.observations).toBe(1);
  });

  it.each([
    { draft: true },
    { checks: { total: 1, passed: 0, failed: 1, pending: 0 } },
    { mergeStateStatus: 'DIRTY' },
    { review: { unresolvedThreads: 1, changesRequested: false } },
  ])('keeps the ready ack through a same-head flap, without hiding other kinds: %j', (flap) => {
    observe(0);
    const hash = ack(600);
    observe(700, flap);
    const other = attention(700).filter((a) => a.kind !== 'pr:ready');
    expect(other).toEqual([expect.objectContaining({ standingSince: iso(700), ageSecs: 0 })]);
    expect(other[0]?.acked).toBeUndefined();
    expect(readAck(ref.key)?.stateHash).toBe(hash);
    observe(710);
    expect(ready(1309)).toEqual([]);
    expect(ready(1310)).toEqual([expect.objectContaining({ stateHash: hash, acked: { by: 'pet', at: iso(600) } })]);
  });

  it('new commits settle again and re-stand once, even if first observed green', () => {
    observe(0);
    const oldHash = ack(600);
    observe(700, { headSha: 'head-b' });
    expect(readPr(ref.key)?.standingSince['pr:ready']).toBe(iso(700));
    expect(ready(1299)).toEqual([]);
    const item = ready(1300)[0]!;
    expect(item.stateHash).not.toBe(oldHash);
    expect(item.acked).toBeUndefined();
    ack(1300);
    observe(1400, { headSha: 'head-b' });
    expect(ready(2000)).toEqual([expect.objectContaining({ stateHash: item.stateHash, acked: { by: 'pet', at: iso(1300) } })]);
  });

  it('honors a custom settle period and 0 restores immediate ready attention', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), 'readySettleSecs = 12\n');
    observe(0);
    expect(ready(11)).toEqual([]);
    expect(ready(12)).toHaveLength(1);
    fs.writeFileSync(path.join(home, 'config.toml'), 'readySettleSecs = 0\n');
    observe(20, { headSha: 'head-b' });
    expect(ready(20)).toEqual([expect.objectContaining({ standingSince: iso(20) })]);
  });

  it('unknown checks never become ready, regardless of settle or approval', () => {
    observe(0, { reviewDecision: 'APPROVED', checks: { ...green, unknown: 'no permission' } });
    expect(ready(10000)).toEqual([]);
    fs.writeFileSync(path.join(home, 'config.toml'), 'readySettleSecs = 0\n');
    expect(ready(10000)).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, claimNext, complete, enqueue, ensureLayout, executorPath, mergeEvidence } from '@lobstah/core';
import { advanceCursor, buildDigest, dueHelmDigest, lastReportedAt, renderDigest } from '../src/digest.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-digest-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(executorPath(), JSON.stringify({ heartbeat: new Date().toISOString() }));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

function land(id: string, verb: 'done' | 'failed', note?: string): void {
  enqueue({ id, repo: 'r', brief: 'b' });
  claimNext('work');
  appendStatus(id, 'work', verb, note);
  complete(id, 'work');
}

describe('man report — the delta digest', () => {
  it('an empty fleet has nothing to say', () => {
    const d = buildDigest();
    expect(d.changed).toBe(false);
    expect(d.landed).toEqual([]);
    expect(d.verdict).toBe('idle');
  });

  it('a terminal catch since the cursor lands in the digest with its evidence', () => {
    land('aaaaaaaa-0000-0000-0000-000000000001', 'done', 'shipped');
    mergeEvidence('aaaaaaaa-0000-0000-0000-000000000001', 'work', { prUrl: 'https://x/pr/9' });
    const d = buildDigest();
    expect(d.changed).toBe(true);
    expect(d.landed).toEqual([
      expect.objectContaining({ id: 'aaaaaaaa-0000-0000-0000-000000000001', verb: 'done', repo: 'r', note: 'shipped', prUrl: 'https://x/pr/9' }),
    ]);
    const text = renderDigest(d);
    expect(text).toContain('aaaaaaaa');
    expect(text).toContain('https://x/pr/9');
  });

  it('advancing the cursor consumes the delta; the next digest is quiet', () => {
    land('aaaaaaaa-0000-0000-0000-000000000002', 'failed', 'flaky');
    const first = buildDigest();
    expect(first.changed).toBe(true);
    advanceCursor('fleet', first.now);
    expect(lastReportedAt('fleet')).toBeDefined();
    const second = buildDigest();
    expect(second.changed).toBe(false);
    expect(second.landed).toEqual([]);
  });

  it('cursors are independent — one grounds reporting does not consume another', () => {
    land('aaaaaaaa-0000-0000-0000-000000000003', 'done');
    const first = buildDigest({ cursor: 'a' });
    advanceCursor('a', first.now);
    expect(buildDigest({ cursor: 'a' }).changed).toBe(false);
    expect(buildDigest({ cursor: 'b' }).changed).toBe(true);
  });

  it('standing attention arises once, then keeps waiting without re-arising', () => {
    enqueue({ id: 'aaaaaaaa-0000-0000-0000-000000000004', repo: 'r', brief: 'b' });
    claimNext('work');
    appendStatus('aaaaaaaa-0000-0000-0000-000000000004', 'work', 'needs-decision', 'which flavor?');
    const first = buildDigest();
    expect(first.changed).toBe(true);
    expect(first.arisen).toEqual([expect.objectContaining({ verb: 'needs-decision', note: 'which flavor?' })]);
    advanceCursor('fleet', first.now);
    const second = buildDigest();
    expect(second.changed).toBe(false);
    expect(second.arisen).toEqual([]);
    expect(second.standing).toEqual([expect.objectContaining({ verb: 'needs-decision' })]);
    expect(renderDigest(second)).toContain('still-waiting');
  });

  it('a grounds-scoped digest sees only its own repos', () => {
    enqueue({ id: 'aaaaaaaa-0000-0000-0000-000000000010', repo: 'mine', brief: 'b' });
    claimNext('work');
    appendStatus('aaaaaaaa-0000-0000-0000-000000000010', 'work', 'done');
    complete('aaaaaaaa-0000-0000-0000-000000000010', 'work');
    enqueue({ id: 'aaaaaaaa-0000-0000-0000-000000000011', repo: 'theirs', brief: 'b' });
    claimNext('work');
    appendStatus('aaaaaaaa-0000-0000-0000-000000000011', 'work', 'needs-decision', 'not yours');
    const d = buildDigest({ repos: new Set(['mine']) });
    expect(d.landed).toEqual([expect.objectContaining({ repo: 'mine' })]);
    expect(d.standing).toEqual([]);
    const all = buildDigest();
    expect(all.landed).toHaveLength(1);
    expect(all.standing).toHaveLength(1);
  });

  it('the helm park digest is due only past the cadence AND with a non-empty delta', () => {
    const helm = { grounds: 'fleet', repos: ['r'] };
    expect(dueHelmDigest(helm, 900)).toBeUndefined(); // no delta — never due
    land('aaaaaaaa-0000-0000-0000-000000000020', 'done');
    const due = dueHelmDigest(helm, 900);
    expect(due?.changed).toBe(true); // never reported — due immediately
    advanceCursor('fleet', due!.now);
    land('aaaaaaaa-0000-0000-0000-000000000021', 'done');
    expect(dueHelmDigest(helm, 900)).toBeUndefined(); // delta exists, cadence not elapsed
    const old = new Date(Date.now() - 901_000);
    fs.utimesSync(path.join(home, 'reported', 'fleet.json'), old, old);
    expect(dueHelmDigest(helm, 900)?.changed).toBe(true); // cadence elapsed + delta
  });

  it('never reaches back past 24 hours, cursor or none', () => {
    land('aaaaaaaa-0000-0000-0000-000000000005', 'done');
    const old = new Date(Date.now() - 25 * 3600_000).toISOString();
    fs.writeFileSync(
      path.join(home, 'state', 'aaaaaaaa-0000-0000-0000-000000000005.status'),
      `${JSON.stringify({ at: old, verb: 'done' })}\n`,
    );
    expect(buildDigest().landed).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { derivePrStacks, ensureLayout, listNotices, loadConfig, readStackEpochs, syncStackReadiness, unseenNotices, upsertPr } from '../src/index.js';
import type { PrEvidence } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const time = Date.parse('2026-10-07T12:00:00Z');
const row = (n: number, over: Partial<PrEvidence> = {}): PrEvidence => ({
  url: `https://github.com/acme/web/pull/${n}`, number: n, state: 'OPEN', draft: false,
  headSha: `sha-${n}`, headRefName: `b${n}`, baseRefName: n === 1 ? 'main' : `b${n - 1}`,
  reviewDecision: '', mergeStateStatus: 'CLEAN', checks: { total: 1, passed: 1, failed: 0, pending: 0 },
  observedAt: new Date(time).toISOString(), ...over,
});
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-stack-ready-'));
  process.env.LOBSTAH_HOME = home; ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), 'readySettleSecs = 0\n');
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });
const sync = () => syncStackReadiness(loadConfig(), time);
const readyNotices = () => listNotices(100).filter((n) => n.kind === 'stack-ready');

describe('stack detection and readiness', () => {
  it('finds a chain bottom to top, not a lone PR', () => {
    expect(derivePrStacks([row(3), row(1), row(2)])[0]?.members.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(derivePrStacks([row(1)])).toEqual([]);
  });
  it('never joins across repos, forks, ambiguous siblings, or non-trunk floors', () => {
    expect(derivePrStacks([row(1), row(2, { url: 'https://github.com/elsewhere/web/pull/2' })])).toEqual([]);
    expect(derivePrStacks([row(1), row(2, { isCrossRepository: true })])).toEqual([]);
    expect(derivePrStacks([row(1), row(2), row(9, { baseRefName: 'b1' })])).toEqual([]);
    expect(derivePrStacks([row(1, { baseRefName: 'release' }), row(2)])).toEqual([]);
    expect(derivePrStacks([row(1, { baseRefName: 'master' }), row(2)], { trunk: () => 'master' })).toHaveLength(1);
  });
  it('uses the same ready rule, unknown checks and human gates never guessed green', () => {
    const bad = row(3, { draft: true });
    expect(derivePrStacks([row(1), row(2), bad])[0]).toMatchObject({ ready: 2, allReady: false, text: expect.stringContaining('#3 (draft)') });
    for (const over of [
      { mergeStateStatus: 'DIRTY' }, { checks: { total: 1, passed: 0, failed: 1, pending: 0 } },
      { checks: { total: 0, passed: 0, failed: 0, pending: 0, unknown: 'no permission' as const } },
      { review: { changesRequested: true } },
    ]) expect(derivePrStacks([row(1), row(2, over)])[0]?.allReady).toBe(false);
  });
  it('wakes once for three PRs, across repeated scans and restarts', () => {
    [1, 2, 3].forEach((n) => upsertPr(row(n))); sync();
    expect(readyNotices()).toHaveLength(1);
    expect(unseenNotices(true).filter((n) => n.kind === 'stack-ready')).toHaveLength(1);
    sync(); sync();
    expect(unseenNotices(true)).toEqual([]);
    expect(readyNotices()[0]?.text).toContain('#1 → #2 → #3 (3 PRs, all green)');
    expect(readStackEpochs()['pr:acme/web#3']?.notified).toBe(true);
  });
  it.each([
    { draft: true }, { mergeStateStatus: 'DIRTY' },
    { checks: { total: 1, passed: 0, failed: 1, pending: 0 } },
  ])('re-notifies after an observed not-ready state clears: %j', (over) => {
    [1, 2, 3].forEach((n) => upsertPr(row(n))); sync();
    upsertPr(row(2, over)); sync(); upsertPr(row(2)); sync(); sync();
    expect(readyNotices()).toHaveLength(2);
  });
  it('new heads settle, then re-notify once on a cadence scan without a forge event', () => {
    const cfg = { ...loadConfig(), readySettleSecs: 10 };
    [1, 2, 3].forEach((n) => upsertPr(row(n)));
    syncStackReadiness(cfg, time + 9000); expect(readyNotices()).toHaveLength(0);
    syncStackReadiness(cfg, time + 10000); expect(readyNotices()).toHaveLength(1);
    upsertPr(row(2, { headSha: 'new', observedAt: new Date(time + 11000).toISOString() }));
    syncStackReadiness(cfg, time + 11000); expect(readyNotices()).toHaveLength(1);
    syncStackReadiness(cfg, time + 21000); syncStackReadiness(cfg, time + 22000);
    expect(readyNotices()).toHaveLength(2);
  });
  it('bottom merges and retargets do not wake again for unchanged remaining heads', () => {
    [1, 2, 3].forEach((n) => upsertPr(row(n))); sync();
    upsertPr(row(1, { state: 'MERGED' })); sync(); // before GitHub retarget
    upsertPr(row(2, { baseRefName: 'main' })); sync(); sync();
    expect(readyNotices()).toHaveLength(1);
    expect(derivePrStacks([row(1, { state: 'MERGED' }), row(2, { baseRefName: 'main' }), row(3)])[0]?.members.map((p) => p.number)).toEqual([2, 3]);
  });
  it('follows pr:ready attention config, with an explicit stack-ready opt-in', () => {
    [1, 2, 3].forEach((n) => upsertPr(row(n)));
    syncStackReadiness({ ...loadConfig(), attentionKinds: ['question'] }, time);
    expect(readyNotices()[0]?.quiet).toBe(true); expect(unseenNotices(false)).toEqual([]);
    expect(loadConfig().attentionKinds).toContain('pr:ready');
    fs.writeFileSync(path.join(home, 'config.toml'), 'attentionKinds = ["stack-ready"]\n');
    expect(loadConfig().attentionKinds).toEqual(['stack-ready']);
  });
  it('never delivers stale or disabled stack notices, even before they were consumed', () => {
    [1, 2, 3].forEach((n) => upsertPr(row(n))); sync();
    upsertPr(row(2, { draft: true })); sync();
    expect(unseenNotices(false)).toEqual([]);
    upsertPr(row(2)); sync();
    expect(unseenNotices(false)).toHaveLength(1);
    fs.writeFileSync(path.join(home, 'config.toml'), 'attentionKinds = ["question"]\n');
    expect(unseenNotices(false)).toEqual([]);
  });
  it('a closed member invalidates an undelivered ready notice', () => {
    [1, 2, 3].forEach((n) => upsertPr(row(n))); sync();
    upsertPr(row(3, { state: 'CLOSED' })); sync();
    expect(unseenNotices(false).every((n) => n.refId !== 'pr:acme/web#3')).toBe(true);
  });
});

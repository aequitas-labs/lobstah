import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  consumeRelievedNotice,
  ensureLayout,
  groundsErrors,
  groundsList,
  heartbeatHelm,
  helmOf,
  listHelms,
  readHelm,
  relieveHelm,
  resolveGrounds,
  takeHelm,
} from '../src/index.js';
import type { Config } from '../src/index.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-helm-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

const TTL_MS = 1800_000;
const BASE: Config = {
  repos: {
    web: { path: '/x/web', trunk: 'main' },
    api: { path: '/x/api', trunk: 'main' },
  },
  harness: {},
  limits: { maxConcurrent: 2, choreConcurrent: 1, wedgeThresholdSecs: 600, maxRestartAttempts: 2, wallClockSecs: 3600, choreRetentionDays: 7 },
  soak: { deferSecs: 90, ttlSecs: 1800 },
  helm: { ttlSecs: 1800, reportSecs: 900 },
  grounds: {},
};
const FLEET = { name: 'fleet', repos: ['web', 'api'] };

describe('taking and holding the helm', () => {
  it('an open helm is taken, and re-taking is an idempotent re-sign', () => {
    const first = takeHelm({ sessionId: 's-one', grounds: FLEET, ttlMs: TTL_MS });
    expect('ok' in first && first.ok.sessionId).toBe('s-one');
    const again = takeHelm({ sessionId: 's-one', grounds: FLEET, ttlMs: TTL_MS });
    expect('ok' in again && again.ok.signedOnAt).toBe('ok' in first ? first.ok.signedOnAt : '');
    expect(listHelms()).toHaveLength(1);
  });

  it('a live foreign holder refuses without --take', () => {
    takeHelm({ sessionId: 's-one', grounds: FLEET, ttlMs: TTL_MS });
    const res = takeHelm({ sessionId: 's-two', grounds: FLEET, ttlMs: TTL_MS });
    expect('held' in res && res.held.sessionId).toBe('s-one');
    expect(readHelm('fleet')?.sessionId).toBe('s-one');
  });

  it('--take displaces a live holder and leaves them a stand-down notice', () => {
    takeHelm({ sessionId: 's-one', grounds: FLEET, ttlMs: TTL_MS });
    const res = takeHelm({ sessionId: 's-two', grounds: FLEET, ttlMs: TTL_MS, take: true });
    expect('ok' in res && res.ok.tookFrom?.sessionId).toBe('s-one');
    const notice = consumeRelievedNotice('s-one');
    expect(notice).toMatchObject({ grounds: 'fleet', by: 's-two' });
    expect(consumeRelievedNotice('s-one')).toBeUndefined(); // delivered once
  });

  it('a stale holder is claimable without --take — a dead orchestrator holds nothing', () => {
    takeHelm({ sessionId: 's-one', grounds: FLEET, ttlMs: TTL_MS, now: Date.now() - TTL_MS - 60_000 });
    const res = takeHelm({ sessionId: 's-two', grounds: FLEET, ttlMs: TTL_MS });
    expect('ok' in res && res.ok.sessionId).toBe('s-two');
  });

  it('two grounds hold two helms without conflict', () => {
    takeHelm({ sessionId: 's-one', grounds: { name: 'a', repos: ['web'] }, ttlMs: TTL_MS });
    takeHelm({ sessionId: 's-two', grounds: { name: 'b', repos: ['api'] }, ttlMs: TTL_MS });
    expect(listHelms()).toHaveLength(2);
    expect(helmOf('s-one')?.grounds).toBe('a');
    expect(helmOf('s-two')?.grounds).toBe('b');
  });

  it('relieve steps down and clears any stand-down notice', () => {
    takeHelm({ sessionId: 's-one', grounds: FLEET, ttlMs: TTL_MS });
    takeHelm({ sessionId: 's-two', grounds: FLEET, ttlMs: TTL_MS, take: true });
    relieveHelm('s-two');
    expect(readHelm('fleet')).toBeUndefined();
    relieveHelm('s-one'); // held nothing, but the notice from the take clears
    expect(consumeRelievedNotice('s-one')).toBeUndefined();
  });

  it('heartbeat refreshes the registration in place', () => {
    takeHelm({ sessionId: 's-one', grounds: FLEET, ttlMs: TTL_MS, now: Date.now() - 60_000 });
    const before = readHelm('fleet')!.heartbeatAt;
    const after = heartbeatHelm('s-one')!.heartbeatAt;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
  });
});

describe('grounds resolution', () => {
  it('no configured grounds means one implicit fleet covering every repo', () => {
    expect(groundsList(BASE)).toEqual([{ name: 'fleet', repos: ['web', 'api'] }]);
    expect(resolveGrounds(BASE).name).toBe('fleet');
  });

  it('a sole configured grounds resolves without a name; several demand one', () => {
    const one: Config = { ...BASE, grounds: { base: { repos: ['web'] } } };
    expect(resolveGrounds(one).name).toBe('base');
    const two: Config = { ...BASE, grounds: { base: { repos: ['web'] }, aeq: { repos: ['api'] } } };
    expect(() => resolveGrounds(two)).toThrow(/--grounds/);
    expect(resolveGrounds(two, 'aeq').repos).toEqual(['api']);
    expect(() => resolveGrounds(two, 'nope')).toThrow(/unknown grounds/);
  });

  it('a repo in two grounds, or an unknown repo, is a config error', () => {
    const overlap: Config = { ...BASE, grounds: { a: { repos: ['web'] }, b: { repos: ['web'] } } };
    expect(groundsErrors(overlap)).toEqual([expect.stringContaining('at most one grounds')]);
    const unknown: Config = { ...BASE, grounds: { a: { repos: ['ghost'] } } };
    expect(groundsErrors(unknown)).toEqual([expect.stringContaining('unknown repo "ghost"')]);
    expect(groundsErrors(BASE)).toEqual([]);
  });
});

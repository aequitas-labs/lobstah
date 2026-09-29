import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addWatch, appendStatus, ensureLayout, laneDirs, listWatches, mergeEvidence, pendingIds, readPr, readWatch, upsertPr } from '@lobstah/core';
import type { PrEvidence } from '@lobstah/core';
import { backfillPrWatches } from '../src/pr-watch.js';
import { buildTendReport } from '../src/tend.js';
import { buildGlassSnapshot } from '../src/glass.js';
import { processTest } from '../../../test/process-test.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const url = (n: number) => `https://github.com/acme/web/pull/${n}`;
const key = (n: number) => `pr:acme/web#${n}`;
const pr = (n: number, over: Partial<PrEvidence> = {}): PrEvidence => ({
  url: url(n), number: n, state: 'OPEN', draft: false, reviewDecision: '',
  mergeStateStatus: 'CLEAN', headSha: `sha-${n}`,
  checks: { total: 1, passed: 1, failed: 0, pending: 0 },
  observedAt: `2026-09-${String(n).padStart(2, '0')}T00:00:00Z`, ...over,
});

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-backfill-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});
const lobstah = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf8', env: { ...process.env, LOBSTAH_HOME: home, PATH: `${home}${path.delimiter}${process.env.PATH}` }, timeout: 10_000,
});
const dispatch = (id: string, followUp?: string) => {
  const dir = path.join(laneDirs('work').done, id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'descriptor.json'), JSON.stringify({ id, repo: 'web', brief: 'b', followUp }));
  appendStatus(id, 'work', 'done', 'shipped');
};

const files = (dir: string): string[] => {
  const d = path.join(home, dir);
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
};

describe('read commands never register PR watches', () => {
  processTest('catch, man tend, the glass snapshot, status, ls, and prs over 20 done dispatches with PR evidence create no watch and no dispatch', () => {
    for (let n = 1; n <= 20; n++) {
      const id = `dispatch-${String(n).padStart(2, '0')}`;
      dispatch(id);
      const failed = { total: 2, passed: 1, failed: 1, pending: 0 };
      mergeEvidence(id, 'work', { prUrl: url(n), pr: pr(n, { state: n % 2 ? 'MERGED' : 'OPEN', checks: failed }) });
    }
    const watchersBefore = files('watchers');
    const queueBefore = pendingIds('work').length;
    for (const args of [['catch', 'dispatch-01'], ['catch', 'dispatch-02'], ['man', 'tend'], ['status'], ['ls'], ['ls', '--all'], ['prs']]) {
      const res = lobstah(...args);
      expect(res.status, `${args.join(' ')}: ${res.stderr}`).toBe(0);
    }
    buildTendReport();
    buildGlassSnapshot();
    expect(files('watches')).toEqual([]);
    expect(listWatches()).toEqual([]);
    expect(files('watchers')).toEqual(watchersBefore);
    expect(pendingIds('work').length).toBe(queueBefore);
    expect(pendingIds('chore')).toEqual([]);
  });
});

describe('watch backfill (explicit migration)', () => {
  processTest('is a dry run by default and registers only with --apply', () => {
    dispatch('dispatch-a');
    mergeEvidence('dispatch-a', 'work', { prUrl: url(1), pr: pr(1) });
    const dry = lobstah('watch', 'backfill');
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain(key(1));
    expect(dry.stdout).toContain('dry run');
    expect(readWatch(key(1))).toBeUndefined();
    const applied = lobstah('watch', 'backfill', '--apply');
    expect(applied.status).toBe(0);
    expect(readWatch(key(1))?.owner).toBe('dispatch:dispatch-a');
    expect(readWatch(key(1))?.cursor).toBe('0');
  });

  it('registers an open evidence PR once, skips terminal evidence, and leaves existing watches alone', () => {
    dispatch('dispatch-a');
    mergeEvidence('dispatch-a', 'work', { prUrl: url(1), pr: pr(1) });
    dispatch('dispatch-b');
    mergeEvidence('dispatch-b', 'work', { prUrl: url(2), pr: pr(2, { state: 'MERGED' }) });
    expect(backfillPrWatches()).toEqual([{ key: key(1), action: 'register', owner: 'dispatch:dispatch-a' }]);
    expect(readWatch(key(1))).toBeUndefined(); // dry run
    expect(backfillPrWatches({ apply: true })).toHaveLength(1);
    expect(readWatch(key(1))?.owner).toBe('dispatch:dispatch-a');
    expect(readWatch(key(2))).toBeUndefined();
    expect(backfillPrWatches({ apply: true })).toEqual([]);
  });

  it('chooses the latest on-disk chain member, or man when the chain is gone', () => {
    dispatch('dispatch-a');
    dispatch('dispatch-z', 'dispatch-a');
    mergeEvidence('dispatch-a', 'work', { prUrl: url(3), pr: pr(3) });
    upsertPr(pr(3), 'dispatch-a');
    upsertPr(pr(4), 'culled-dispatch');
    expect(backfillPrWatches({ apply: true })).toHaveLength(2);
    expect(readWatch(key(3))?.owner).toBe('dispatch:dispatch-z');
    expect(readWatch(key(4))?.owner).toBe('man');
  });

  it('follows a surviving descendant of a culled ancestor and retires a terminal record watch', () => {
    dispatch('dispatch-z', 'culled-dispatch');
    upsertPr(pr(3), 'culled-dispatch');
    upsertPr(pr(4, { state: 'CLOSED' }));
    addWatch(key(4), 'echo custom');
    const rows = backfillPrWatches({ apply: true });
    expect(rows.map((r) => r.action).sort()).toEqual(['register', 'retire']);
    expect(readWatch(key(3))?.owner).toBe('dispatch:dispatch-z');
    expect(readWatch(key(4))).toBeUndefined();
  });
});

describe('prs', () => {
  processTest('lists three records newest first, with state and watch status', () => {
    upsertPr(pr(1)); upsertPr(pr(3)); upsertPr(pr(2));
    addWatch(key(3), 'echo custom');
    const res = lobstah('prs');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('no watch');
    expect(res.stdout.indexOf('#3')).toBeLessThan(res.stdout.indexOf('#2'));
    expect(res.stdout.indexOf('#2')).toBeLessThan(res.stdout.indexOf('#1'));
    expect(res.stdout).toContain('watching');
    expect(res.stdout).toContain('passed');
  });

  processTest('lists the prBadge state: a conflicting PR reads conflicts, never green', () => {
    upsertPr(pr(1, { mergeStateStatus: 'DIRTY' })); upsertPr(pr(2, { mergeStateStatus: 'BEHIND' }));
    const res = lobstah('prs');
    expect(res.status).toBe(0);
    const line = (n: number) => res.stdout.split('\n').find((l) => l.includes(`#${n}`)) ?? '';
    expect(line(1)).toContain('conflicts');
    expect(line(2)).toContain('behind');
    expect(res.stdout).not.toContain('green');
  });

  processTest('rejects the removed prs sync subcommand', () => {
    upsertPr(pr(7));
    upsertPr(pr(8));
    // A portable check fixture: the shipped check is exercised against real
    // GitHub PRs in the manual run, while this tests sync on Windows too.
    const script = path.join(home, 'check.cjs');
    const record = path.join(home, 'prs', 'acme__web__7.json');
    fs.writeFileSync(script, `
      const fs = require('node:fs');
      const file = ${JSON.stringify(record)};
      const pr = JSON.parse(fs.readFileSync(file, 'utf8'));
      pr.state = 'MERGED';
      pr.mergedAt = '2026-09-24T12:00:00Z';
      pr.observedAt = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(pr));
      process.stdout.write(JSON.stringify({ cursor: 'merged', events: [], done: true }));
    `);
    addWatch(key(7), `"${process.execPath}" "${script}"`);
    const res = lobstah('prs', 'sync');
    expect(res.status).toBe(2);
    expect(res.stdout).toContain('prs takes no positional arguments');
  });
});

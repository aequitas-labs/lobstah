import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addWatch, appendStatus, ensureLayout, laneDirs, mergeEvidence, readPr, readWatch, upsertPr } from '@lobstah/core';
import type { PrEvidence } from '@lobstah/core';
import { backfillPrWatches } from '../src/pr-watch.js';
import { buildTendReport } from '../src/tend.js';
import { buildGlassSnapshot } from '../src/glass.js';

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
  encoding: 'utf8', env: { ...process.env, LOBSTAH_HOME: home, PATH: `${home}:${process.env.PATH}` }, timeout: 10_000,
});
const dispatch = (id: string, followUp?: string) => {
  const dir = path.join(laneDirs('work').done, id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'descriptor.json'), JSON.stringify({ id, repo: 'web', brief: 'b', followUp }));
  appendStatus(id, 'work', 'done', 'shipped');
};

describe('PR watch backfill', () => {
  it('registers an open evidence PR once, skips terminal evidence, and leaves existing watches alone', () => {
    dispatch('dispatch-a');
    mergeEvidence('dispatch-a', 'work', { prUrl: url(1), pr: pr(1) });
    dispatch('dispatch-b');
    mergeEvidence('dispatch-b', 'work', { prUrl: url(2), pr: pr(2, { state: 'MERGED' }) });
    expect(backfillPrWatches()).toBe(1);
    expect(readWatch(key(1))?.owner).toBe('dispatch:dispatch-a');
    expect(readWatch(key(2))).toBeUndefined();
    expect(backfillPrWatches()).toBe(0);
  });

  it('chooses the latest on-disk chain member, or man when the chain is gone', () => {
    dispatch('dispatch-a');
    dispatch('dispatch-z', 'dispatch-a');
    mergeEvidence('dispatch-a', 'work', { prUrl: url(3), pr: pr(3) });
    upsertPr(pr(3), 'dispatch-a');
    upsertPr(pr(4), 'culled-dispatch');
    expect(backfillPrWatches()).toBe(2);
    expect(readWatch(key(3))?.owner).toBe('dispatch:dispatch-z');
    expect(readWatch(key(4))?.owner).toBe('man');
  });

  it('follows a surviving descendant of a culled ancestor and retires a terminal record watch', () => {
    dispatch('dispatch-z', 'culled-dispatch');
    upsertPr(pr(3), 'culled-dispatch');
    upsertPr(pr(4, { state: 'CLOSED' }));
    addWatch(key(4), 'echo custom');
    expect(backfillPrWatches()).toBe(1);
    expect(readWatch(key(3))?.owner).toBe('dispatch:dispatch-z');
    expect(readWatch(key(4))).toBeUndefined();
  });

  it('backfills on tend, glass data, and catch read paths', () => {
    dispatch('dispatch-a');
    mergeEvidence('dispatch-a', 'work', { prUrl: url(5), pr: pr(5) });
    buildTendReport();
    expect(readWatch(key(5))).toBeDefined();
    fs.rmSync(path.join(home, 'watches'), { recursive: true });
    buildGlassSnapshot();
    expect(readWatch(key(5))).toBeDefined();
    fs.rmSync(path.join(home, 'watches'), { recursive: true });
    expect(lobstah('catch', 'dispatch-a').status).toBe(0);
    expect(readWatch(key(5))).toBeDefined();
  });

  it('lists three records newest first, with state and watch status', () => {
    upsertPr(pr(1)); upsertPr(pr(3)); upsertPr(pr(2));
    const res = lobstah('prs');
    expect(res.status).toBe(0);
    expect(res.stdout.indexOf('#3')).toBeLessThan(res.stdout.indexOf('#2'));
    expect(res.stdout.indexOf('#2')).toBeLessThan(res.stdout.indexOf('#1'));
    expect(res.stdout).toContain('watching');
    expect(res.stdout).toContain('passed');
  });

  it('prs sync checks a due PR once, refreshes its record, and retires its terminal watch', () => {
    upsertPr(pr(7));
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
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('registered: 0');
    expect(res.stdout).toContain('refreshed: 1');
    expect(readPr(key(7))).toMatchObject({ state: 'MERGED', mergedAt: '2026-09-24T12:00:00Z' });
    expect(readWatch(key(7))).toBeUndefined();
    const second = lobstah('prs', 'sync');
    expect(second.stdout).toContain('registered: 0');
    expect(second.stdout).toContain('refreshed: 0');
  });
});

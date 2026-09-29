import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendStatus, claimNext, complete, enqueue, ensureLayout, executorPath, mergeEvidence } from '@lobstah/core';
import { petRow, petStateFile, type PetState } from '../src/pet.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-attention-json-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(executorPath(), JSON.stringify({ heartbeat: new Date().toISOString() }));
  fs.writeFileSync(path.join(home, 'config.toml'), 'attentionKinds = ["question", "pr:draft"]\n');
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

// spawnSync: every child has exited before the test (and its teardown) ends.
const lobstah = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, LOBSTAH_HOME: home }, timeout: 10_000 });

const Q = '11111111-1111-1111-1111-111111111111';
const P = '22222222-2222-2222-2222-222222222222';
const PR_URL = 'https://github.com/acme/web/pull/9';

function standingItems(): void {
  enqueue({ id: Q, repo: 'web', brief: 'b' }, 'work');
  claimNext('work');
  appendStatus(Q, 'work', 'needs-decision', 'which color?');
  enqueue({ id: P, repo: 'web', brief: 'b' }, 'work');
  claimNext('work');
  appendStatus(P, 'work', 'done', 'opened');
  complete(P, 'work');
  mergeEvidence(P, 'work', {
    prUrl: PR_URL,
    pr: {
      url: PR_URL,
      number: 9,
      state: 'OPEN',
      draft: true,
      reviewDecision: '',
      mergeStateStatus: 'DRAFT',
      headSha: 'abc1234',
      checks: { total: 1, passed: 1, failed: 0, pending: 0 },
      review: { unresolvedThreads: 0, changesRequested: false },
      observedAt: new Date().toISOString(),
    },
  });
}

type Item = Record<string, unknown>;
/** ageSecs is measured at read time; two reads a moment apart differ in it only. */
const withoutAge = (items: Item[]) => items.map(({ ageSecs: _age, ...rest }) => rest);

describe('attention --json', () => {
  it('prints only { attention }, with the same items and fields as man tend --json', () => {
    standingItems();
    expect(lobstah('attention', 'ack', 'pr:acme/web#9', '--by', 'pet').status).toBe(0);
    const narrow = lobstah('attention', '--json');
    expect(narrow.status).toBe(0);
    const parsed = JSON.parse(narrow.stdout) as { attention: Item[] };
    expect(Object.keys(parsed)).toEqual(['attention']);
    const tend = JSON.parse(lobstah('man', 'tend', '--json').stdout) as { attention: Item[] };
    expect(parsed.attention).toHaveLength(2);
    expect(withoutAge(parsed.attention)).toEqual(withoutAge(tend.attention));
    // The fields the pet decodes.
    const question = parsed.attention.find((a) => a.kind === 'question')!;
    expect(question).toMatchObject({ id: Q, verb: 'needs-decision', note: 'which color?', key: `work:${Q}` });
    const draft = parsed.attention.find((a) => a.kind === 'pr:draft')!;
    expect(draft).toMatchObject({ id: P, key: 'pr:acme/web#9', prUrl: PR_URL, acked: { by: 'pet' } });
  });

  it('prints an empty list when nothing stands', () => {
    const res = lobstah('attention', '--json');
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ attention: [] });
  });
});

describe('doctor pet row', () => {
  const missing = () => path.join(home, 'absent');
  const writeState = (s: PetState) => {
    fs.mkdirSync(path.dirname(petStateFile()), { recursive: true });
    fs.writeFileSync(petStateFile(), JSON.stringify(s));
  };
  const now = Date.parse('2026-09-29T12:00:00Z');
  const installed = () => {
    const plist = path.join(home, 'lobstah.pet.plist');
    fs.writeFileSync(plist, '');
    return plist;
  };

  it('skips when not installed and no pet ever ran', () => {
    expect(petRow({ now, plist: missing(), binary: missing(), platform: 'darwin' })).toMatchObject({ status: 'skip', detail: expect.stringContaining('not installed') });
    expect(petRow({ now, plist: missing(), binary: missing(), platform: 'linux' })).toMatchObject({ status: 'skip', detail: 'macOS only' });
  });

  it('warns when installed but no pet has written its state', () => {
    expect(petRow({ now, plist: installed(), binary: missing() })).toMatchObject({ status: 'warn', detail: expect.stringContaining('installed; not running') });
  });

  it('is ok when running and the last read worked', () => {
    writeState({ pid: 4242, at: new Date(now - 5_000).toISOString(), ok: true, command: 'attention --json', consecutiveFailures: 0, items: 3, lastOkAt: new Date(now - 5_000).toISOString() });
    const row = petRow({ now, plist: installed(), binary: missing(), alive: (pid) => pid === 4242 });
    expect(row.status).toBe('ok');
    expect(row.detail).toBe('installed; running (pid 4242); last read worked 5s ago (`lobstah attention --json`, 3 walking)');
  });

  it('warns with the reason when running but the last read failed', () => {
    writeState({ pid: 4242, at: new Date(now - 3_000).toISOString(), ok: false, reason: '`lobstah man tend --json` timed out', consecutiveFailures: 4, lastOkAt: new Date(now - 600_000).toISOString() });
    const row = petRow({ now, plist: installed(), binary: missing(), alive: () => true });
    expect(row.status).toBe('warn');
    expect(row.detail).toBe('installed; running (pid 4242); last read failed 3s ago, 4 in a row: `lobstah man tend --json` timed out; last worked 10m ago');
  });

  it('warns when the recorded pid is gone or the state is stale', () => {
    writeState({ pid: 4242, at: new Date(now - 5_000).toISOString(), ok: true, command: 'attention --json', consecutiveFailures: 0, items: 0 });
    expect(petRow({ now, plist: installed(), binary: missing(), alive: () => false })).toMatchObject({ status: 'warn', detail: expect.stringContaining('installed; not running;') });
    writeState({ pid: 4242, at: new Date(now - 600_000).toISOString(), ok: true, command: 'attention --json', consecutiveFailures: 0, items: 0 });
    expect(petRow({ now, plist: installed(), binary: missing(), alive: () => true })).toMatchObject({ status: 'warn', detail: expect.stringContaining('pid 4242 has not read for 10m') });
  });
});

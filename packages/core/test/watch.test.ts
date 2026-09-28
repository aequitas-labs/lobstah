import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addWatch,
  listWatches,
  pendingWatchEvents,
  readWatch,
  readWatchEvents,
  removeWatch,
  runWatchCheck,
  watchDue,
  watchErrorCell,
  watchErrorText,
  watchFailureLogLine,
  watchIntervalSecs,
} from '../src/watch.js';
import { listNotices } from '../src/notices.js';
import { classifyGhError, firstMeaningfulLine } from '../src/gh-errors.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-watch-'));
  process.env.LOBSTAH_HOME = dir;
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A check script that pages two events after cursor 0, then goes quiet. */
function pagingCheck(): string {
  const script = path.join(dir, 'check.cjs');
  fs.writeFileSync(
    script,
    `const cursor = process.argv[2];
if (cursor === '0') console.log(JSON.stringify({ cursor: '2', events: [{ seq: 1, summary: 'first' }, { seq: 2, summary: 'second' }] }));
else console.log(JSON.stringify({ cursor }));
`,
  );
  return `node "${script}" {cursor}`;
}

describe('addWatch', () => {
  it('is idempotent: re-adding updates the check but keeps the cursor', () => {
    addWatch('ume:abc', 'echo one', { cursor: '7' });
    const updated = addWatch('ume:abc', 'echo two');
    expect(updated.check).toBe('echo two');
    expect(updated.cursor).toBe('7');
    expect(readWatch('ume:abc')!.check).toBe('echo two');
    expect(listWatches()).toHaveLength(1);
  });

  it('defaults to man ownership; --for makes it dispatch-owned', () => {
    expect(addWatch('a', 'true').owner).toBe('man');
    expect(addWatch('b', 'true', { owner: 'dispatch:1234' }).owner).toBe('dispatch:1234');
  });
});

describe('runWatchCheck', () => {
  it('appends events, advances the cursor, and goes quiet on the next check', () => {
    const w = addWatch('ume:abc', pagingCheck());
    const first = runWatchCheck(w);
    expect(first.fresh.map((e) => e.summary)).toEqual(['first', 'second']);
    expect(first.watch.cursor).toBe('2');
    expect(first.watch.lastError).toBeUndefined();
    const second = runWatchCheck(first.watch);
    expect(second.fresh).toEqual([]);
    expect(readWatchEvents('ume:abc')).toHaveLength(2);
  });

  it('a failing check records lastError and leaves the cursor untouched', () => {
    const w = addWatch('bad', 'exit 3');
    const { watch, fresh } = runWatchCheck(w);
    expect(fresh).toEqual([]);
    expect(watch.lastExit).toBe(3);
    expect(watchErrorText(watch)).toContain('(exit 3)');
    expect(watch.cursor).toBe('0');
  });

  it('unparseable output is an error, not silent progress', () => {
    const w = addWatch('garbled', 'echo not-json');
    const { watch } = runWatchCheck(w);
    expect(watch.lastError).toContain('unparseable');
    expect(watch.cursor).toBe('0');
  });

  it('done: true retires the watch once its events are consumed', () => {
    const script = path.join(dir, 'done.cjs');
    fs.writeFileSync(script, `console.log(JSON.stringify({ cursor: '1', events: [{ seq: 1, summary: 'final' }], done: true }));`);
    const w = addWatch('ume:closing', `node "${script}"`);
    runWatchCheck(w);
    const pending = pendingWatchEvents(true);
    expect(pending[0]!.events[0]!.summary).toBe('final');
    expect(listWatches()).toHaveLength(0); // consumed + done = retired
  });
});

describe('pendingWatchEvents', () => {
  it('is level-triggered: peek leaves events standing, consume advances', () => {
    const w = addWatch('ume:abc', pagingCheck());
    runWatchCheck(w);
    expect(pendingWatchEvents(false)).toHaveLength(1);
    expect(pendingWatchEvents(false)).toHaveLength(1); // still standing
    expect(pendingWatchEvents(true)).toHaveLength(1);
    expect(pendingWatchEvents(true)).toHaveLength(0); // consumed
  });

  it('separates man-owned from dispatch-owned delivery', () => {
    const w = addWatch('ume:worker', pagingCheck(), { owner: 'dispatch:1234' });
    runWatchCheck(w);
    expect(pendingWatchEvents(false, 'man')).toHaveLength(0);
    expect(pendingWatchEvents(false, 'dispatch')).toHaveLength(1);
  });
});

describe('watchDue', () => {
  it('due immediately when never checked, then not until the cadence elapses', () => {
    const w = addWatch('ume:abc', 'true');
    expect(watchDue(w, 45)).toBe(true);
    w.lastCheckedAt = new Date().toISOString();
    expect(watchDue(w, 45)).toBe(false);
    w.lastCheckedAt = new Date(Date.now() - 46_000).toISOString();
    expect(watchDue(w, 45)).toBe(true);
    w.everySecs = 120;
    expect(watchDue(w, 45)).toBe(false); // per-watch override wins
  });
});

describe('removeWatch', () => {
  it('removes the watch and its events', () => {
    const w = addWatch('ume:abc', pagingCheck());
    runWatchCheck(w);
    expect(removeWatch('ume:abc')).toBe(true);
    expect(listWatches()).toHaveLength(0);
    expect(readWatchEvents('ume:abc')).toEqual([]);
    expect(removeWatch('ume:abc')).toBe(false);
  });
});

describe('watch failures', () => {
  /** A stubbed `gh` that fails the way a GitHub App without Checks: read does. */
  function stubGh(stderr: string, code = 1): string {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const gh = path.join(bin, 'gh');
    fs.writeFileSync(gh, `#!/bin/sh\necho '${stderr}' >&2\nexit ${code}\n`);
    fs.chmodSync(gh, 0o755);
    return `PATH="${bin}:$PATH" gh pr view 12 --repo acme/web --json statusCheckRollup`;
  }
  const FORBIDDEN = 'GraphQL: Resource not accessible by integration (repository.pullRequest.statusCheckRollup)';

  it("keeps the failing command's stderr and exit code; the log line names the key, reason, and remedy", () => {
    const w = addWatch('pr:acme/web#12', stubGh(FORBIDDEN));
    const { watch } = runWatchCheck(w);
    expect(watch.lastError).toBe('Resource not accessible by integration (repository.pullRequest.statusCheckRollup)');
    expect(watch.lastExit).toBe(1);
    expect(watch.errorKind).toBe('checks-permission');
    expect(watch.failures).toBe(1);
    expect(watch.failingSince).toBe(watch.lastCheckedAt);
    const line = watchFailureLogLine(watch);
    expect(line).toMatch(/^pr:acme\/web#12 check failed: Resource not accessible by integration .*\(exit 1\) — grant the GitHub App `Checks: read`/);
    expect(watchErrorCell(watch)).toContain(`failing since ${watch.failingSince}`);
  });

  it("reads lobstah's own `error:` line from stdout when stderr is empty", () => {
    const w = addWatch('pr:acme/web#13', `echo 'error: Resource not accessible by integration'; exit 1`);
    const { watch } = runWatchCheck(w);
    expect(watch.lastError).toBe('Resource not accessible by integration');
    expect(watch.lastExit).toBe(1);
  });

  it('posts watch-failing once at the third failure, and watch-recovered once on recovery', () => {
    const script = path.join(dir, 'flaky.sh');
    const flag = path.join(dir, 'ok');
    fs.writeFileSync(script, `if [ -f "${flag}" ]; then echo '{"cursor":"1"}'; else echo 'HTTP 401: Bad credentials' >&2; exit 1; fi\n`);
    const w = addWatch('flaky', `sh "${script}"`);
    const t0 = Date.parse('2026-09-28T00:00:00Z');
    const kinds = () => listNotices(100).map((n) => n.kind);
    for (let i = 0; i < 5; i++) runWatchCheck(readWatch('flaky')!, new Date(t0 + i * 60_000));
    expect(kinds().filter((k) => k === 'watch-failing')).toHaveLength(1);
    const failing = listNotices(100).find((n) => n.kind === 'watch-failing')!;
    expect(failing.text).toContain('flaky failing 3×');
    expect(failing.text).toContain('Bad credentials');
    expect(readWatch('flaky')!.failures).toBe(5);
    expect(readWatch('flaky')!.failingSince).toBe(new Date(t0).toISOString());
    fs.writeFileSync(flag, '');
    runWatchCheck(readWatch('flaky')!, new Date(t0 + 10 * 60_000));
    runWatchCheck(readWatch('flaky')!, new Date(t0 + 11 * 60_000));
    expect(kinds().filter((k) => k === 'watch-recovered')).toHaveLength(1);
    const after = readWatch('flaky')!;
    expect(after.lastError).toBeUndefined();
    expect(after.failures).toBeUndefined();
    expect(after.cursor).toBe('1');
    void w;
  });

  it('a streak shorter than three posts nothing, not even a recovery', () => {
    const script = path.join(dir, 'blip.sh');
    const flag = path.join(dir, 'ok2');
    fs.writeFileSync(script, `if [ -f "${flag}" ]; then echo '{"cursor":"1"}'; else exit 1; fi\n`);
    addWatch('blip', `sh "${script}"`);
    runWatchCheck(readWatch('blip')!);
    runWatchCheck(readWatch('blip')!);
    fs.writeFileSync(flag, '');
    runWatchCheck(readWatch('blip')!);
    expect(listNotices(100)).toEqual([]);
  });

  it('a check that half-worked applies its cursor and still records the error', () => {
    addWatch('half', `echo '{"cursor":"7","error":"Resource not accessible by integration"}'`);
    const { watch } = runWatchCheck(readWatch('half')!);
    expect(watch.cursor).toBe('7');
    expect(watch.lastError).toBe('Resource not accessible by integration');
    expect(watch.lastExit).toBeUndefined();
    expect(watch.failures).toBe(1);
  });

  it('backs off a permission or auth failure: doubles per failure, caps at one hour', () => {
    const w = { everySecs: 45, errorKind: 'checks-permission' as const };
    expect(watchIntervalSecs({ ...w, failures: 0 }, 45)).toBe(45);
    expect(watchIntervalSecs({ ...w, failures: 1 }, 45)).toBe(90);
    expect(watchIntervalSecs({ ...w, failures: 2 }, 45)).toBe(180);
    expect(watchIntervalSecs({ ...w, failures: 6 }, 45)).toBe(2880);
    expect(watchIntervalSecs({ ...w, failures: 7 }, 45)).toBe(3600);
    expect(watchIntervalSecs({ ...w, failures: 500 }, 45)).toBe(3600);
    for (const kind of ['auth', 'not-found', 'rate-limit', 'permission'] as const) {
      expect(watchIntervalSecs({ everySecs: 45, errorKind: kind, failures: 2 }, 45)).toBe(180);
    }
    // A transient or unknown failure retries at cadence.
    expect(watchIntervalSecs({ everySecs: 45, errorKind: 'unknown', failures: 4 }, 45)).toBe(45);
    // A watch already slower than the cap is not sped up.
    expect(watchIntervalSecs({ everySecs: 7200, errorKind: 'auth', failures: 3 }, 45)).toBe(7200);
  });

  it('watchDue honours the backoff', () => {
    const now = Date.parse('2026-09-28T01:00:00Z');
    const w = addWatch('slow', 'true', { everySecs: 45 });
    w.lastCheckedAt = new Date(now - 60_000).toISOString();
    w.failures = 2;
    w.errorKind = 'auth';
    expect(watchDue(w, 45, now)).toBe(false); // 180s interval
    expect(watchDue(w, 45, now + 120_001)).toBe(true);
  });
});

describe('classifyGhError', () => {
  it('maps the common causes to a remedy', () => {
    expect(classifyGhError('GraphQL: Resource not accessible by integration (repository.pullRequest.statusCheckRollup)')).toEqual({
      kind: 'checks-permission',
      remedy: expect.stringContaining('`Checks: read`'),
    });
    expect(classifyGhError('Resource not accessible by integration (fails even without check results)').kind).toBe('permission');
    expect(classifyGhError("GraphQL: Could not resolve to a Repository with the name 'acme/nope'.").kind).toBe('not-found');
    expect(classifyGhError('HTTP 404: Not Found (https://api.github.com/repos/acme/nope)').kind).toBe('not-found');
    expect(classifyGhError('HTTP 401: Bad credentials (https://api.github.com/graphql)').kind).toBe('auth');
    expect(classifyGhError('To get started with GitHub CLI, please run:  gh auth login').kind).toBe('auth');
    expect(classifyGhError('API rate limit exceeded for installation ID 123.').kind).toBe('rate-limit');
    expect(classifyGhError('gh: spawnSync gh ENOENT').kind).toBe('gh-missing');
    expect(classifyGhError('sh: gh: command not found').kind).toBe('gh-missing');
    expect(classifyGhError('something odd happened')).toEqual({ kind: 'unknown' });
  });

  it('firstMeaningfulLine skips blanks and node warnings and unwraps error:', () => {
    expect(firstMeaningfulLine('\n(node:1) ExperimentalWarning: x\nGraphQL: boom\n')).toBe('boom');
    expect(firstMeaningfulLine('', 'error: "quoted reason"')).toBe('quoted reason');
    expect(firstMeaningfulLine('', '')).toBeUndefined();
  });
});

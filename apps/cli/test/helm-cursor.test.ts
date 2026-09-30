import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  appendStatus,
  claimNext,
  complete,
  enqueue,
  ensureLayout,
  loadConfig,
  noticesDir,
  postNotice,
  readHelm,
  takeHelm,
  writeHold,
} from '@lobstah/core';
import type { Notice } from '@lobstah/core';
import { buildDigest } from '../src/digest.js';
import { readCursor } from '../src/reported.js';
import { landedCatches } from '../src/tend.js';
import { liveWatcher } from '../src/watchers.js';
import { removeTempDir } from '../../../test/temp-dir.js';

// End to end against the built CLI (`pnpm build` runs before `pnpm test`).
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const OLD_HELM = '0ld0ld00-0000-4000-8000-000000000001';
const HELM = '7e740e13-0000-4000-8000-000000000002';
const TAKER = '7a4e7a4e-0000-4000-8000-000000000003';
const ID = '51151151-1111-4111-8111-111111111111';
const DAYS_AGO = Date.now() - 3 * 24 * 3600_000;

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-helmcursor-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  // One repo, so the implicit "fleet" grounds covers dispatches in repo r.
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = "${home.replace(/\\/g, '/')}"\ntrunk = "main"\n`);
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

function lobstah(...args: string[]) {
  // Never inherit the test runner's own harness session id.
  const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 15_000 });
}

/** A notice as it sits on disk after `atMs` — delivered to nobody. */
function oldNotice(kind: Notice['kind'], text: string, atMs = DAYS_AGO, refId?: string): Notice {
  const n: Notice = { seq: `${String(atMs).padStart(15, '0')}-1-0`, kind, at: new Date(atMs).toISOString(), text, refId };
  fs.mkdirSync(noticesDir(), { recursive: true });
  fs.writeFileSync(path.join(noticesDir(), `${n.seq}.json`), JSON.stringify(n));
  return n;
}

function signOn(session: string, ...extra: string[]) {
  const res = lobstah('man', 'helm', '--session', session, '--harness', 'claude', ...extra);
  expect(res.status, res.stdout + res.stderr).toBe(0);
  return res;
}

const wait = (session: string) => lobstah('man', 'wait', '--session', session, '--timeout', '2');

describe('helm sign-on starts its cursor at the sign-on', () => {
  it('after a gap, an old notice does not wake man wait; man tend still lists it', () => {
    oldNotice('trap-stowed', 'trap wt:abc stowed');
    const on = signOn(HELM);
    expect(on.stdout).toContain('wakesFrom:');
    const res = wait(HELM);
    expect(res.stdout).not.toContain('trap-stowed');
    expect(res.stdout).toContain('timeout: true');
    expect(lobstah('man', 'tend').stdout).toContain('trap wt:abc stowed');
  });

  it('a notice posted after the sign-on still wakes', () => {
    signOn(HELM);
    postNotice({ kind: 'trap-stowed', text: 'trap wt:new stowed' });
    const res = wait(HELM);
    expect(res.stdout).toContain('trap wt:new stowed');
    expect(res.stdout).not.toContain('timeout: true');
  });

  it('a standing question from before the sign-on still wakes', () => {
    enqueue({ id: ID, repo: 'r', brief: 'b' });
    claimNext('work');
    appendStatus(ID, 'work', 'needs-decision', 'which flavor?');
    oldNotice('trap-stowed', 'trap wt:abc stowed');
    signOn(HELM);
    const res = wait(HELM);
    expect(res.stdout).toContain(ID);
    expect(res.stdout).toContain('needs-decision');
    expect(res.stdout).not.toContain('trap-stowed');
  });

  it('a standing condition (a free-space hold) from before the sign-on still wakes', () => {
    writeHold({ since: new Date(DAYS_AGO).toISOString(), checkedAt: new Date().toISOString(), freeBytes: 1, needBytes: 2, dir: home });
    oldNotice('disk-held', 'dispatches held: 0 GB free');
    signOn(HELM);
    expect(wait(HELM).stdout).toContain('dispatches held');
  });

  it('--take from a live helm keeps its cursor, so an in-flight notice still wakes', () => {
    signOn(HELM);
    const floor = readHelm('fleet')!.wakesFrom!;
    // Posted after the first helm signed on, before the take: in flight.
    postNotice({ kind: 'trap-stowed', text: 'trap wt:inflight stowed' });
    const later = Date.now() + 5;
    while (Date.now() < later) {
      // step past the millisecond so a reset would drop the notice
    }
    signOn(TAKER, '--take');
    expect(readHelm('fleet')).toMatchObject({ sessionId: TAKER, wakesFrom: floor });
    expect(wait(TAKER).stdout).toContain('trap wt:inflight stowed');
  });

  it('a sign-on over a stale helm starts a new cursor; a re-sign by the same session keeps it', () => {
    const grounds = { name: 'fleet', repos: [] };
    takeHelm({ sessionId: OLD_HELM, grounds, ttlMs: 60_000, now: DAYS_AGO });
    const now = Date.now();
    const reg = takeHelm({ sessionId: HELM, grounds, ttlMs: 60_000, now });
    if (!('ok' in reg)) throw new Error('expected the stale helm to be claimable');
    expect(reg.ok.wakesFrom).toBe(new Date(now).toISOString());
    const again = takeHelm({ sessionId: HELM, grounds, ttlMs: 60_000, now: now + 10_000 });
    if (!('ok' in again)) throw new Error('expected a re-sign');
    expect(again.ok.wakesFrom).toBe(reg.ok.wakesFrom);
  });

  it('the digest for the grounds starts no earlier than the sign-on', () => {
    enqueue({ id: ID, repo: 'r', brief: 'b' });
    claimNext('work');
    appendStatus(ID, 'work', 'done', 'landed before the sign-on');
    complete(ID, 'work');
    expect(buildDigest({ cursor: 'fleet', now: Date.now() + 1000 }).landed.map((l) => l.id)).toContain(ID);
    signOn(HELM);
    expect(buildDigest({ cursor: 'fleet', now: Date.now() + 1000 }).landed).toEqual([]);
  });
});

describe('man wait reports only delivered catches', () => {
  const land = () => {
    enqueue({ id: ID, repo: 'r', brief: 'b' });
    claimNext('work');
    appendStatus(ID, 'work', 'done', 'landed');
    complete(ID, 'work');
  };
  const unreported = () => landedCatches(loadConfig()).find((c) => c.id === ID)?.unreported;

  it('advances through a done event delivered to the helm watcher', async () => {
    signOn(HELM);
    enqueue({ id: ID, repo: 'r', brief: 'b' });
    claimNext('work');
    const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
    delete env.CLAUDE_CODE_SESSION_ID;
    const child = spawn(process.execPath, [cli, 'man', 'wait', '--session', HELM, '--timeout', '5'], { env, stdio: 'pipe' });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    try {
      const deadline = Date.now() + 4_000;
      while (!liveWatcher(HELM, 'man') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      expect(liveWatcher(HELM, 'man')).toBeDefined();
      // The watcher registers before capturing its event baseline.
      await new Promise((r) => setTimeout(r, 500));
      const at = appendStatus(ID, 'work', 'done', 'landed').at;
      complete(ID, 'work');
      expect(unreported()).toBe(true);
      const exit = await new Promise<number | null>((resolve) => child.once('exit', resolve));
      expect(exit, stdout).toBe(0);
      expect(stdout).toContain(ID);
      expect(readCursor('fleet')).toBe(at);
      expect(unreported()).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }, 10_000);

  it('--peek leaves a landed catch unreported', () => {
    signOn(HELM);
    land();
    expect(unreported()).toBe(true);
    const peek = lobstah('man', 'wait', '--peek', '--session', HELM);
    expect(peek.status).toBe(0);
    expect(readCursor('fleet')).toBeUndefined();
    expect(unreported()).toBe(true);
  });

  it('an older standing reminder never moves a reported cursor backwards', () => {
    signOn(HELM);
    land();
    expect(lobstah('man', 'report', '--session', HELM).status).toBe(0);
    const through = readCursor('fleet')!;
    expect(unreported()).toBe(false);
    const questionId = '62262262-2222-4222-8222-222222222222';
    enqueue({ id: questionId, repo: 'r', brief: 'question' });
    claimNext('work');
    appendStatus(questionId, 'work', 'needs-decision', 'which one?', new Date(Date.parse(through) - 1_000).toISOString());
    const wait = lobstah('man', 'wait', '--session', HELM, '--timeout', '1');
    expect(wait.status).toBe(0);
    expect(wait.stdout).toContain(questionId);
    expect(readCursor('fleet')).toBe(through);
    expect(unreported()).toBe(false);
  });

  it('a catch landed without a helm stays unreported until man report prints it', () => {
    land();
    expect(unreported()).toBe(true);
    expect(lobstah('man', 'wait', '--timeout', '1').status).toBe(3);
    expect(readCursor('fleet')).toBeUndefined();
    expect(unreported()).toBe(true);
    const report = lobstah('man', 'report');
    expect(report.status).toBe(0);
    expect(report.stdout).toContain(ID.slice(0, 8));
    expect(unreported()).toBe(false);
  });

  it('a quiet wait still prints a digest without advancing the cursor', () => {
    signOn(HELM);
    land();
    const result = lobstah('man', 'wait', '--session', HELM, '--timeout', '1');
    expect(result.status).toBe(3);
    expect(result.stdout).toContain('timeout: true');
    expect(result.stdout).toContain(ID.slice(0, 8));
    expect(readCursor('fleet')).toBeUndefined();
    expect(unreported()).toBe(true);
  });
});

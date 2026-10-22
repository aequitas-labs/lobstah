import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  addWatch,
  readWatch,
  appendStatus,
  claimNext,
  closeRequest,
  enqueue,
  ensureLayout,
  noticeStands,
  listNotices,
  postNotice,
  writeRequest,
  DEFAULT_WAIT,
  IdleWait,
  takeHelm,
} from '@lobstah/core';
import { removeTempDir } from '../../../test/temp-dir.js';

// End to end against the built CLI (`pnpm build` runs before `pnpm test`):
// the bug was control flow in main.ts, so only a real invocation shows it.
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-peek-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

function lobstah(...args: string[]) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LOBSTAH_HOME: home },
    timeout: 10_000,
  });
  return { ...res, elapsedMs: Date.now() - started };
}

describe('man wait --peek — a check, never a park', () => {
  it('a peek preserves capped history; actual event delivery resets it', () => {
    const sid = 'backed-off-helm';
    fs.writeFileSync(path.join(home, 'config.toml'), '[repos.r]\npath = "."\n');
    takeHelm({ sessionId: sid, grounds: { name: 'home', repos: ['r'] }, ttlMs: 60_000 });
    enqueue({ id: 'question', repo: 'r', brief: 'b' }); claimNext('work');
    appendStatus('question', 'work', 'needs-decision', 'which one?');
    for (let i = 0; i < 7; i++) new IdleWait(sid, DEFAULT_WAIT, undefined, 0).timedOut(14_400_000);
    expect(lobstah('man', 'wait', '--session', sid, '--peek').status).toBe(0);
    expect(new IdleWait(sid, DEFAULT_WAIT).timeoutSecs).toBe(14400);
    const woke = lobstah('man', 'wait', '--session', sid);
    expect(woke.status, woke.stderr).toBe(0);
    expect(woke.stdout).toContain('which one?');
    expect(new IdleWait(sid, DEFAULT_WAIT).timeoutSecs).toBe(900);
  });
  it('a pause wakes once with its waiting kind, link and full note, then stays quiet', () => {
    const id = 'pause';
    enqueue({ id, repo: 'r', brief: 'b' }); claimNext('work');
    appendStatus(id, 'work', 'paused', 'CI pending; read the whole pause', undefined, { waitingOn: 'pr', link: 'https://github.com/o/r/pull/1' });
    const res = lobstah('man', 'wait', '--timeout', '1');
    expect(res.status, res.stdout).toBe(0);
    expect(res.stdout).toContain('verb: paused');
    expect(res.stdout).toContain('waitingOn: pr');
    expect(res.stdout).toContain('https://github.com/o/r/pull/1');
    expect(res.stdout).toContain('CI pending; read the whole pause');
    expect(res.stdout).toContain('decide if the human needs to act');
    expect(lobstah('man', 'wait', '--peek').stdout).toContain('standing: none');
  });

  it('returns promptly with exit 0 and standing: none on an empty home', () => {
    const res = lobstah('man', 'wait', '--peek');
    expect(res.signal).toBeNull(); // not killed by the spawn timeout
    expect(res.status).toBe(0);
    expect(res.elapsedMs).toBeLessThan(5_000);
    expect(res.stdout).toContain('standing: none');
    expect(res.stdout).not.toContain('timeout');
  });

  it('emits a standing needs-decision without consuming it', () => {
    const id = '77777777-7777-7777-7777-777777777777';
    enqueue({ id, repo: 'r', brief: 'b' });
    claimNext('work');
    appendStatus(id, 'work', 'needs-decision', 'which flavor?');
    for (let i = 0; i < 2; i++) {
      const res = lobstah('man', 'wait', '--peek');
      expect(res.status).toBe(0);
      expect(res.stdout).toContain(id);
      expect(res.stdout).toContain('needs-decision');
      expect(res.stdout).not.toContain('standing: none');
    }
  });

  it('rejects --peek with --timeout as a usage error', () => {
    const res = lobstah('man', 'wait', '--peek', '--timeout', '3');
    expect(res.status).toBe(2);
    expect(res.stdout).toContain('--peek never blocks');
  });
});

it('man wait keeps waiting when a watch is retired during its check', () => {
  const script = path.join(home, 'retire-watch.cjs');
  fs.writeFileSync(
    script,
    `
    require('node:fs').unlinkSync(${JSON.stringify(path.join(home, 'watches', 'retired.json'))});
    console.log(JSON.stringify({ cursor: '1', events: [{ seq: 1, summary: 'stale' }] }));
  `,
  );
  addWatch('retired', `"${process.execPath}" "${script}"`, { owner: 'man' });
  const res = lobstah('man', 'wait', '--timeout', '1');
  expect(res.error).toBeUndefined();
  expect(res.status).toBe(3); // quiet timeout, not the recoverable race's exit 1
  expect(res.stdout).toContain('timeout: true');
  expect(res.stdout).not.toContain('stale');
  expect(res.stdout).not.toContain('error:');
  expect(readWatch('retired')).toBeUndefined();
});

describe('man wait: a trap request', () => {
  it('is a trap-request event carrying the id, repo, and harness, and stands until closed', () => {
    const r = writeRequest('trap-request', { repo: 'web', harness: 'codex' });
    const res = lobstah('man', 'wait', '--peek');
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^event: trap-request$/m);
    expect(res.stdout).toContain(`id: ${r.id}`);
    expect(res.stdout).toMatch(/^repo: web$/m);
    expect(res.stdout).toMatch(/^harness: codex$/m);
    const notice = listNotices(10).find((n) => n.kind === 'trap-request')!;
    expect(noticeStands(notice)).toBe(true);
    closeRequest(r.id, 'reserved');
    expect(noticeStands(notice)).toBe(false);
  });
});

describe('man wait: a trap start wakes once', () => {
  it('sign-on does not wake; trap-available does', () => {
    postNotice({ kind: 'trap-signed-on', text: 'trap amber-gull signed on', refId: 'abcd1234' });
    const quiet = lobstah('man', 'wait', '--peek');
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toContain('standing: none');
    postNotice({ kind: 'trap-available', text: 'trap amber-gull is available', refId: 'abcd1234' });
    const woke = lobstah('man', 'wait', '--peek');
    expect(woke.stdout).toContain('notice: trap-available');
    expect(woke.stdout).not.toContain('trap-signed-on');
  });
});

it('a quiet lifecycle digest does not reset an expired wait or stick its empty count', () => {
  const sid = 'digest-helm';
  fs.writeFileSync(path.join(home, 'config.toml'), '[repos.r]\npath = "."\n');
  takeHelm({ sessionId: sid, grounds: { name: 'home', repos: ['r'] }, ttlMs: 60_000 });
  postNotice({ kind: 'trap-stowed', text: 'routine lifecycle', repo: 'r' });
  for (let i = 0; i < 4; i++) {
    const result = lobstah('man', 'wait', '--session', sid, '--timeout', '0.01');
    expect(result.status, result.stderr).toBe(3);
    expect(result.stdout).toContain('routine lifecycle');
    expect(result.stdout).toContain(`emptyTimeouts: ${i + 1}`);
  }
  expect(new IdleWait(sid, DEFAULT_WAIT).emptyCount).toBe(4);
  expect(new IdleWait(sid, DEFAULT_WAIT).timeoutSecs).toBe(3600);
}, 15_000);

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  bounceExpiredSignOffs,
  enqueue,
  ensureLayout,
  listNotices,
  noticeOrphanedBait,
  readSignedOff,
  sendTrapMessage,
  signOnTrap,
  unhandledTrapMessages,
} from '@lobstah/core';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * A trap signed off by SessionEnd on a restart and re-soaked a minute later
 * lost its messages (bounced as never delivered) and its bait was flagged
 * orphaned. Its address is now held for [soak].signOffGraceSecs.
 */

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const SESSION = 'restarting-session';
const GRACE_MS = 600_000;
let home: string;
let worktree: string;
let trapId: string;

const signOn = () => {
  const signed = signOnTrap({ sessionId: SESSION, harness: 'claude', repo: 'web', worktree, cwd: worktree, ttlMs: 60_000, name: 'crisp-crab' });
  if (!('ok' in signed)) throw new Error('unexpected hold');
  return signed.ok.trapId;
};

const run = (args: string[], stdin?: object) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX')));
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: worktree,
    encoding: 'utf8',
    env: { ...env, LOBSTAH_HOME: home },
    ...(stdin ? { input: JSON.stringify(stdin) } : {}),
    timeout: 20_000,
  });
};
const sessionEnd = () => run(['hook', 'session-end'], { session_id: SESSION, hook_event_name: 'SessionEnd', reason: 'other', cwd: worktree });
const bounces = () => listNotices(100).filter((n) => n.kind === 'message-bounced');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-signoff-'));
  worktree = path.join(home, 'wt');
  fs.mkdirSync(worktree);
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  trapId = signOn();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

describe('a trap that signs off keeps its address for the grace', () => {
  it('unread messages are held at sign-off and delivered when the worktree re-soaks', () => {
    sendTrapMessage(trapId, 'helm', 'check the fleet');
    expect(sessionEnd().status).toBe(0);
    expect(readSignedOff(trapId)).toMatchObject({ trapId, name: 'crisp-crab' });
    expect(bounces()).toEqual([]);
    expect(unhandledTrapMessages(trapId).map((m) => m.text)).toEqual(['check the fleet']);

    expect(signOn()).toBe(trapId);
    expect(readSignedOff(trapId)).toBeUndefined();
    const stop = run(['hook', 'stop'], { session_id: SESSION, hook_event_name: 'Stop' });
    expect(stop.stdout).toContain('check the fleet');
  });

  it('a send to the signed-off trap is held, not refused; after the grace, held messages bounce to the helm', () => {
    sessionEnd();
    const sent = run(['send', 'wt:crisp-crab', 'are you back?']);
    expect(sent.status, sent.stderr).toBe(0);
    expect(sent.stdout).toContain('the message is held and delivers if its worktree re-soaks within');
    expect(bounceExpiredSignOffs(GRACE_MS, Date.now() + 60_000)).toEqual([]);
    expect(bounceExpiredSignOffs(GRACE_MS, Date.now() + GRACE_MS + 1_000)).toEqual([trapId]);
    expect(bounces().map((n) => n.text)).toEqual([expect.stringContaining('never delivered (from terminal): are you back?')]);
    expect(readSignedOff(trapId)).toBeUndefined();
    // The address is gone after the grace.
    expect(run(['send', 'wt:crisp-crab', 'late']).status).not.toBe(0);
  });

  it('a trap that re-soaked has its hold released by the daemon pass, with nothing bounced', () => {
    sendTrapMessage(trapId, 'helm', 'hello');
    sessionEnd();
    signOn();
    expect(bounceExpiredSignOffs(GRACE_MS, Date.now() + GRACE_MS + 1_000)).toEqual([]);
    expect(bounces()).toEqual([]);
  });

  it('addressed bait raises bait-orphaned only after the grace', () => {
    sessionEnd();
    enqueue({ id: 'addressed-work', repo: 'web', brief: 'b', for: `wt:${trapId}` });
    noticeOrphanedBait(Date.now(), GRACE_MS);
    expect(listNotices(100).filter((n) => n.kind === 'bait-orphaned')).toEqual([]);
    noticeOrphanedBait(Date.now() + GRACE_MS + 1_000, GRACE_MS);
    expect(listNotices(100).filter((n) => n.kind === 'bait-orphaned')).toHaveLength(1);
  });

  it('[soak].signOffGraceSecs = 0 bounces at sign-off, as before', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[soak]\nsignOffGraceSecs = 0\n');
    sendTrapMessage(trapId, 'helm', 'gone already');
    sessionEnd();
    expect(bounces()).toHaveLength(1);
    expect(readSignedOff(trapId)).toBeUndefined();
  });
});

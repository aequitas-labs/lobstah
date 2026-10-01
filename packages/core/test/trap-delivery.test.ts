import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendStatus, beatTrap, claimBait, enqueue, ensureLayout, heartbeatTrap, laneDirs,
  listNotices, noticeIdleTrapClaims, noticeStands, noticeWakes, readTrap, releaseCatch, requestCancel,
  signOnTrap, unreportedTrapBait, unseenNotices,
} from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-trap-delivery-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T18:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

function caught() {
  const worktree = path.join(home, 'wt');
  fs.mkdirSync(worktree);
  const signed = signOnTrap({ worktree, cwd: worktree, repo: 'web', harness: 'codex', sessionId: 's', ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('unexpected hold');
  const reg = signed.ok;
  enqueue({ id: 'bait', repo: 'web', for: `wt:${reg.trapId}`, brief: 'original task' });
  claimBait(reg);
  return readTrap(reg.trapId)!;
}

describe('unacknowledged trap claims', () => {
  it('recovers the original brief without claiming again; a tool beat is not a receipt', () => {
    const reg = caught();
    beatTrap({ cwd: reg.cwd, sessionId: reg.sessionId, toolName: 'Bash', toolInput: { command: 'lobstah soak --wait' } });
    expect(unreportedTrapBait(reg)?.descriptor.brief).toBe('original task');
    expect(claimBait(reg)).toBeNull();
    expect(unreportedTrapBait({ ...reg, sessionId: 'foreign' })).toBeUndefined();
    appendStatus('bait', 'work', 'working', 'starting', undefined, undefined, true);
    expect(unreportedTrapBait(reg)).toBeUndefined();
  });

  it('old reports do not acknowledge a re-claim, even in the same millisecond', () => {
    const reg = caught();
    appendStatus('bait', 'work', 'working', 'old attempt', undefined, undefined, true);
    releaseCatch(reg);
    claimBait(reg);
    expect(unreportedTrapBait(readTrap(reg.trapId)!)).toBeDefined();
  });

  it('recovers a claim whose waiter died before writing the status receipt', () => {
    const reg = caught();
    fs.writeFileSync(path.join(home, 'state', 'bait.status'), '');
    expect(unreportedTrapBait(reg)).toBeDefined();
  });

  it('notices an idle claim after 60s despite a fresh park, once per claim epoch', () => {
    const reg = caught();
    const notices = () => listNotices(50).filter((n) => n.kind === 'trap-claim-idle');
    vi.setSystemTime(Date.now() + 59_999);
    noticeIdleTrapClaims();
    expect(notices()).toHaveLength(0);
    vi.setSystemTime(Date.now() + 1);
    heartbeatTrap(reg.trapId, { parked: true });
    noticeIdleTrapClaims();
    noticeIdleTrapClaims();
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ refId: 'bait', repo: 'web' });
    expect(unseenNotices(false).some((n) => n.kind === 'trap-claim-idle')).toBe(true);
    const notice = notices()[0]!;
    const future = new Date(Date.now() + 1_000).toISOString();
    const wakes = noticeWakes({ sessionId: 'new-helm', grounds: 'fleet', repos: ['web'], signedOnAt: future, heartbeatAt: future, wakesFrom: future })!;
    expect(wakes(notice)).toBe(true); // still standing when a new helm signs on
    appendStatus('bait', 'work', 'working', 'starting', undefined, undefined, true);
    expect(noticeStands(notice)).toBe(false);
    expect(wakes(notice)).toBe(false);
    expect(fs.existsSync(path.join(laneDirs('work').active, 'bait', 'claim.json'))).toBe(true);
    releaseCatch(reg);
    claimBait(reg);
    vi.setSystemTime(Date.now() + 60_000);
    noticeIdleTrapClaims();
    expect(notices()).toHaveLength(2);
  });

  it.each(['working', 'paused', 'done', 'failed'])('does not re-deliver or notice a worker report: %s', (verb) => {
    const reg = caught();
    appendStatus('bait', 'work', verb, 'worker acknowledgement', undefined, undefined, true);
    vi.setSystemTime(Date.now() + 120_000);
    expect(unreportedTrapBait(reg)).toBeUndefined();
    noticeIdleTrapClaims();
    expect(listNotices().some((n) => n.kind === 'trap-claim-idle')).toBe(false);
  });

  it('leaves cancellation to the park, not the idle notice', () => {
    caught();
    vi.setSystemTime(Date.now() + 120_000);
    noticeIdleTrapClaims();
    const notice = listNotices().find((n) => n.kind === 'trap-claim-idle')!;
    requestCancel('bait', 'work');
    expect(noticeStands(notice)).toBe(false);
    noticeIdleTrapClaims();
    expect(listNotices().filter((n) => n.kind === 'trap-claim-idle')).toHaveLength(1);
  });
});

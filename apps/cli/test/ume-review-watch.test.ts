import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  appendStatus, claimBait, enqueue, ensureLayout, listWatches, readTrap, readTurnOwner,
  signOnTrap, unhandled, type TrapRegistration,
} from '@lobstah/core';
import { createUmeReviewWatch, registerUmeReview, syncUmeReviews, type UmeRead } from '../src/ume-review-watch.js';
import { createTurnWaits, readTurnWaitRecords } from '../src/turn-waits.js';
import { createCodexTrapWatch } from '../src/codex-trap-watch.js';
import { soakPark } from '../src/trap-park.js';
import { listenerRow } from '../src/hook-readiness.js';
import { deliverDispatchOwned } from '../../pick/src/loops/watch.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let trap: TrapRegistration;
const ID = '44444444-4444-4444-8444-444444444444';
const ARTIFACT = '47dd003a-1e5';
const LINK = `https://app.ume.so/a/${ARTIFACT}`;
const KEY = `ume:${ID}:${ARTIFACT}`;
const PROJECT = 'vr95mce908';
let now: number;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-ume-review-'));
  vi.stubEnv('LOBSTAH_HOME', path.join(home, 'lobstah'));
  vi.stubEnv('AGENT_TURN_HOME', path.join(home, 'turns'));
  ensureLayout();
  const signed = signOnTrap({ worktree: home, cwd: home, repo: 'r', harness: 'codex', sessionId: 'thread', ttlMs: 600_000,
    window: { tmuxPane: '%7', tmuxSocket: '/tmp/tmux-501/lobstah' } });
  if (!('ok' in signed)) throw new Error('held');
  enqueue({ id: ID, repo: 'r', for: `wt:${signed.ok.trapId}`, brief: 'write the plan' });
  claimBait(signed.ok);
  trap = readTrap(signed.ok.trapId)!;
  appendStatus(ID, 'work', 'paused', 'waiting on review', undefined, { waitingOn: 'review', link: LINK }, true);
  now = Date.now();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); removeTempDir(home); });
const batch = (seq: number, kind = 'comments.sent') => ({ feedbackCount: 1, batches: [{ artifact: ARTIFACT, cursor: seq, entries: [{ seq, kind }] }] });
function register() {
  return registerUmeReview(ID, 'work', { at: new Date(now).toISOString(), verb: 'paused', link: LINK }, { UME_PROJECT: PROJECT })!;
}

it('wakes a parked hookless Codex through the existing send path, once per new feedback batch', async () => {
  register();
  const read = vi.fn<UmeRead>().mockResolvedValue(batch(1));
  const poll = createUmeReviewWatch(read);
  const tmux = vi.fn(async (args: string[]) => args[0] === 'capture-pane' ? '› Ask Codex to do anything\n? for shortcuts\n' : '');
  await poll(now, () => {});
  await createCodexTrapWatch({ tmux })(now, () => {});
  expect(tmux.mock.calls.some(c => c[0][0] === 'send-keys')).toBe(true);
  expect(unhandled(ID, 'work')[0]?.text).toContain(`Set UME_PROJECT to ${PROJECT}`);
  expect(unhandled(ID, 'work')[0]?.text).toContain(`ume feedback ${ARTIFACT} --since 0`);
  expect(listWatches()[0]).toMatchObject({ key: KEY, owner: `dispatch:${ID}`, cursor: '1' });
  expect(read.mock.calls[0]).toEqual([['feedback', ARTIFACT, '--peek', '--since', '0', '--json'], home, PROJECT]);
  tmux.mockClear();
  // A repeated peek, even after a daemon restart, never repeats the wake.
  await createUmeReviewWatch(read)(now + 16_000, () => {});
  await createCodexTrapWatch({ tmux })(now + 16_000, () => {});
  expect(tmux).not.toHaveBeenCalled();
  expect(unhandled(ID, 'work')).toHaveLength(1);
  read.mockResolvedValue(batch(2, 'thread.resolved'));
  await poll(now + 32_000, () => {});
  expect(unhandled(ID, 'work')).toHaveLength(2);
});

it('does not wake without new feedback and keeps ume read cursors untouched', async () => {
  fs.mkdirSync(path.join(home, '.ume'));
  const state = JSON.stringify({ cursors: { [ARTIFACT]: 5 }, project: PROJECT });
  fs.writeFileSync(path.join(home, '.ume', 'next.json'), state);
  register();
  const read = vi.fn<UmeRead>().mockResolvedValue({ feedbackCount: 0 });
  await createUmeReviewWatch(read)(now, () => {});
  expect(unhandled(ID, 'work')).toHaveLength(0);
  expect(read.mock.calls[0][0]).toContain('5');
  expect(fs.readFileSync(path.join(home, '.ume', 'next.json'), 'utf8')).toBe(state);
});

it('finds a legacy park in another organization and persists that project for later polls', async () => {
  // A park registration has no project: the original bug replayed it in the daemon's project.
  fs.writeFileSync(path.join(readTurnOwner(trap.sessionId)!.waits, 'ume.json'), JSON.stringify({
    from: 'ume', read: `ume feedback ${ARTIFACT}`, wait: `ume await ${ARTIFACT} --turn-line --since {cursor}`,
    cwd: home, cursor: '5',
  }));
  appendStatus(ID, 'work', 'working', 'preparing to park'); // Registration alone is sufficient.
  const read = vi.fn<UmeRead>(async (args, _cwd, project) => {
    if (args[0] === 'projects') return { projects: [{ project: 'other-org' }, { project: PROJECT }] };
    if (project !== PROJECT) throw new Error('ume: no_such_artifact');
    return batch(6, 'artifact.approved');
  });
  const poll = createUmeReviewWatch(read);
  await poll(now, () => {});
  expect(unhandled(ID, 'work')).toHaveLength(1);
  expect(listWatches()[0]).toMatchObject({ cursor: '6', umeReview: { project: PROJECT } });
  expect(read.mock.calls[0][0]).toContain('5');
  read.mockClear();
  await poll(now + 16_000, () => {});
  expect(read.mock.calls.map(c => c[2])).toEqual([PROJECT]);
});

it.each(['codex', 'claude'])('delivers feedback to a %s park hook or foreground listener', async harness => {
  signOnTrap({ ...trap, harness, ttlMs: 600_000 });
  register();
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await createUmeReviewWatch(async () => batch(1))(now, () => {});
  await soakPark(trap.trapId, '0', false);
  expect(output.mock.calls[0][0]).toContain(`ume feedback ${ARTIFACT}`);
});

it('retains approval until done, then clears the dispatch watch without forking a continuation', async () => {
  register();
  await createUmeReviewWatch(async () => batch(1, 'artifact.approved'))(now, () => {});
  deliverDispatchOwned(() => {});
  expect(listWatches()).toHaveLength(1);
  expect(listWatches()[0].lastFollowUpId).toBeUndefined();
  appendStatus(ID, 'work', 'done', 'approved; finished');
  syncUmeReviews();
  expect(listWatches()).toHaveLength(0);
});

it('drops feedback returned after the dispatch finishes', async () => {
  register();
  const read: UmeRead = async () => {
    appendStatus(ID, 'work', 'done', 'finished during poll');
    return batch(1);
  };
  await createUmeReviewWatch(read)(now, () => {});
  expect(unhandled(ID, 'work')).toHaveLength(0);
  expect(listWatches()).toHaveLength(0);
});

it('records poll failures and retries without losing feedback', async () => {
  register();
  const read = vi.fn<UmeRead>().mockRejectedValueOnce(new Error('engine offline')).mockResolvedValue(batch(1));
  const poll = createUmeReviewWatch(read);
  await poll(now, () => {});
  expect(listWatches()[0]).toMatchObject({ failures: 1, cursor: '0', lastError: 'engine offline' });
  await poll(now + 16_000, () => {});
  expect(unhandled(ID, 'work')).toHaveLength(1);
  expect(listWatches()[0].lastError).toBeUndefined();
});

it('doctor shows a paused catch without a park listener', () => {
  // The brief's claim park heartbeat has expired, and no hook or foreground listener is running.
  const row = listenerRow(now + 11_000);
  expect(row.status).toBe('warn');
  expect(row.detail).toContain('paused without a park listener');
});

it('the daemon polls a registered ume park and keeps its recovery pointer without launching a second wait', async () => {
  const oldExitListeners = new Set(process.listeners('exit'));
  fs.mkdirSync(path.join(home, '.ume'));
  fs.writeFileSync(path.join(home, '.ume', 'next.json'), JSON.stringify({ project: PROJECT }));
  fs.writeFileSync(path.join(readTurnOwner(trap.sessionId)!.waits, 'ume.json'), JSON.stringify({
    from: 'ume', read: `ume feedback ${ARTIFACT}`, wait: `ume await ${ARTIFACT} --turn-line --since {cursor}`,
    cwd: home, cursor: '5',
  }));
  const start = vi.fn(() => { throw new Error('must not launch the legacy long wait'); });
  try {
    const { pass, children } = createTurnWaits(start, { umeRead: async () => batch(6) });
    pass(now, () => {});
    await vi.waitFor(() => expect(unhandled(ID, 'work')).toHaveLength(1));
    expect(start).not.toHaveBeenCalled();
    expect(children.size).toBe(0);
    expect(readTurnWaitRecords()[0].pointer).toMatchObject({ inbox: ID, lane: 'work' });
    appendStatus(ID, 'work', 'done', 'approved; finished');
    const next = '55555555-5555-4555-8555-555555555555';
    enqueue({ id: next, repo: 'r', for: `wt:${trap.trapId}`, brief: 'another task' });
    claimBait(readTrap(trap.trapId)!);
    pass(now + 16_000, () => {});
    await vi.waitFor(() => expect(listWatches()).toHaveLength(0));
  } finally {
    for (const listener of process.listeners('exit')) if (!oldExitListeners.has(listener)) process.removeListener('exit', listener);
  }
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendStatus, claimBait, codexIdleWakeAt, dispatchProgress, enqueue, ensureLayout, listNotices,
  noticeDispatchProgress, readTrap, resumeTrapTurn, sendMessage, sendTrapMessage,
  signOnTrap, trapWorkingStop, unhandled, type TrapRegistration,
} from '@lobstah/core';
import { codexIdleWakeMessage, createCodexTrapWatch } from '../src/codex-trap-watch.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let trap: TrapRegistration;
let now: number;
const ID = '44444444-4444-4444-8444-444444444444';
const IDLE = '› Ask Codex to do anything\n? for shortcuts\n';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-codex-trap-watch-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  const signed = signOnTrap({ worktree: home, cwd: home, repo: 'r', harness: 'codex', sessionId: 'thread', ttlMs: 600_000,
    window: { tmuxPane: '%7', tmuxSocket: '/tmp/tmux-501/lobstah' } });
  if (!('ok' in signed)) throw new Error('held');
  enqueue({ id: ID, repo: 'r', for: `wt:${signed.ok.trapId}`, brief: 'throwaway task' });
  claimBait(signed.ok);
  trap = readTrap(signed.ok.trapId)!;
  appendStatus(ID, 'work', 'working', 'Taking over; next I will read the code', undefined, undefined, true);
  now = Date.now();
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });
function goIdle() { trapWorkingStop(trap, true, now); trapWorkingStop(trap, true, now); }
const pane = (screen = IDLE) => vi.fn(async (args: string[]) => args[0] === 'capture-pane' ? screen : '');

it('re-prompts an idle working Codex once, persists across daemon restarts, and only then notifies the helm', async () => {
  goIdle();
  const tmux = pane();
  noticeDispatchProgress(now + 60_000);
  expect(listNotices().filter(n => n.kind === 'trap-idle-working')).toHaveLength(0);
  expect(dispatchProgress(now + 60_000)).toHaveLength(0);
  await createCodexTrapWatch({ tmux })(now + 60_000, () => {});
  expect(tmux.mock.calls.map(c => c[0])).toEqual([
    ['capture-pane', '-p', '-t', '%7'],
    ['send-keys', '-t', '%7', '-l', codexIdleWakeMessage(ID)],
    ['send-keys', '-t', '%7', 'Enter'],
  ]);
  expect(codexIdleWakeAt(trap)).toBe(now + 60_000);
  noticeDispatchProgress(now + 119_999);
  expect(listNotices().filter(n => n.kind === 'trap-idle-working')).toHaveLength(0);
  tmux.mockClear();
  await createCodexTrapWatch({ tmux })(now + 120_000, () => {});
  expect(tmux).not.toHaveBeenCalled();
  noticeDispatchProgress(now + 120_000);
  expect(listNotices().filter(n => n.kind === 'trap-idle-working')).toEqual([expect.objectContaining({ kind: 'trap-idle-working', refId: ID })]);
});

it('a recovered worker clears idleness; later progress on the same claim does not buy another automatic wake', async () => {
  goIdle();
  const tmux = pane();
  await createCodexTrapWatch({ tmux })(now + 60_000, () => {});
  resumeTrapTurn(trap, true);
  noticeDispatchProgress(now + 120_000);
  expect(listNotices().filter(n => n.kind === 'trap-idle-working')).toHaveLength(0);
  appendStatus(ID, 'work', 'working', 'Code inspected', undefined, undefined, true);
  goIdle();
  tmux.mockClear();
  await createCodexTrapWatch({ tmux })(now + 180_000, () => {});
  expect(tmux).not.toHaveBeenCalled();
});

it.each(['paused', 'needs-decision', 'working'] as const)('delivers dispatch and session sends to an idle %s Codex without a park hook', async verb => {
  appendStatus(ID, 'work', verb, 'last report', undefined, undefined, true);
  sendMessage(ID, 'work', 'keep going', 'helm');
  sendTrapMessage(trap.trapId, 'helm', 'session steering');
  const tmux = pane();
  await createCodexTrapWatch({ tmux })(now, () => {});
  expect(tmux.mock.calls[1][0][4]).toContain(`lobstah inbox ${ID}`);
  expect(tmux.mock.calls[1][0][4]).toContain('lobstah soak --wait --timeout 0');
  expect(unhandled(ID, 'work')).toHaveLength(1); // Delivery never consumes an instruction.
  tmux.mockClear();
  await createCodexTrapWatch({ tmux })(now + 1000, () => {});
  expect(tmux).not.toHaveBeenCalled();
  sendMessage(ID, 'work', 'another instruction', 'helm');
  await createCodexTrapWatch({ tmux })(now + 2000, () => {});
  expect(tmux.mock.calls.some(c => c[0][0] === 'send-keys')).toBe(true);
});

it('defers while busy and retries, but never types into a dialog', async () => {
  goIdle();
  const tmux = pane('• Working (esc to interrupt)');
  const watch = createCodexTrapWatch({ tmux });
  await watch(now + 60_000, () => {});
  expect(codexIdleWakeAt(trap)).toBeUndefined();
  tmux.mockImplementation(async args => args[0] === 'capture-pane' ? 'Hooks need review\n› 1. Review' : '');
  await watch(now + 61_000, () => {});
  expect(tmux.mock.calls.every(c => c[0][0] === 'capture-pane')).toBe(true);
  expect(codexIdleWakeAt(trap)).toBe(now + 61_000);
  noticeDispatchProgress(now + 121_000);
  expect(listNotices().filter(n => n.kind === 'trap-idle-working')[0]?.kind).toBe('trap-idle-working');
});

it('uses the shared server for a send, and retries busy or failed delivery without losing the message', async () => {
  signOnTrap({ ...trap, codexServer: true, ttlMs: 600_000 });
  sendMessage(ID, 'work', 'new steering', 'helm');
  const startTurn = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('busy').mockResolvedValue('started');
  const watch = createCodexTrapWatch({ startTurn });
  for (let n = 0; n < 4; n++) await watch(now + n * 1000, () => {});
  expect(startTurn).toHaveBeenCalledTimes(3);
  expect(startTurn.mock.calls[2][0]).toBe(trap.sessionId);
});

it('delivers the first message of a later dispatch on the same trap and gives that claim its own recovery', async () => {
  sendMessage(ID, 'work', 'first task steering', 'helm');
  const tmux = pane();
  goIdle();
  await createCodexTrapWatch({ tmux })(now + 60_000, () => {});
  expect(codexIdleWakeAt(trap)).toBe(now + 60_000);
  appendStatus(ID, 'work', 'done', 'finished', undefined, undefined, true);
  const next = '55555555-5555-4555-8555-555555555555';
  enqueue({ id: next, repo: 'r', for: `wt:${trap.trapId}`, brief: 'next task' });
  claimBait(readTrap(trap.trapId)!);
  trap = readTrap(trap.trapId)!;
  appendStatus(next, 'work', 'working', 'Taking over', undefined, undefined, true);
  sendMessage(next, 'work', 'second task steering', 'helm');
  tmux.mockClear();
  await createCodexTrapWatch({ tmux })(now, () => {});
  expect(tmux.mock.calls[1][0][4]).toContain(`lobstah inbox ${next}`);
  goIdle();
  await createCodexTrapWatch({ tmux })(now + 60_000, () => {});
  expect(codexIdleWakeAt(trap)).toBe(now + 60_000);
});

it('delivers a session send without an open catch and leaves Claude traps alone', async () => {
  appendStatus(ID, 'work', 'done', 'finished', undefined, undefined, true);
  sendTrapMessage(trap.trapId, 'helm', 'a new instruction');
  const tmux = pane();
  await createCodexTrapWatch({ tmux })(now, () => {});
  expect(tmux.mock.calls[1][0][4]).toContain('new session message');
  signOnTrap({ ...trap, harness: 'claude', ttlMs: 600_000 });
  tmux.mockClear();
  sendTrapMessage(trap.trapId, 'helm', 'more steering');
  await createCodexTrapWatch({ tmux })(now, () => {});
  expect(tmux).not.toHaveBeenCalled();
});

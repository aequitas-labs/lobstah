import { expect, it, vi } from 'vitest';
import type { TrapRegistration } from '@lobstah/core';
import { compactTrapSession } from '../src/trap-compact.js';
import { sendSessionPrompt } from '../src/usage-limit-watch.js';
import type { TmuxRunner } from '../src/tmux-terminal.js';

const trap = (harness: string): TrapRegistration => ({
  trapId: 'seat', sessionId: 'same-session', repo: 'r', harness, worktree: '/repo', cwd: '/repo',
  signedOnAt: '', heartbeatAt: '',
});

it.each(['claude', 'codex'])('injects /compact in the existing %s terminal session', async harness => {
  const calls: string[][] = [];
  const tmux: TmuxRunner = async args => {
    calls.push(args);
    return args[0] === 'capture-pane' ? `${harness === 'codex' ? '›' : '❯'}\n? for shortcuts · esc to interrupt` : '';
  };
  const swap = vi.fn();
  const reg = { ...trap(harness), window: { tmuxPane: '%4', tmuxSocket: '/tmp/lobstah' } };
  const sendPrompt = vi.fn((session, text, options) => sendSessionPrompt(session, text, { ...options, tmux, writerAlive: () => true }));
  expect(await compactTrapSession(reg, { id: 'job', lane: 'work' }, { sendPrompt, swap })).toBe('/compact');
  expect(calls.filter(args => args[0] === 'send-keys')).toEqual([
    ['send-keys', '-t', '%4', '-l', '/compact'], ['send-keys', '-t', '%4', 'Enter'],
  ]);
  expect(sendPrompt.mock.calls[0]?.[0].sessionId).toBe('same-session');
  expect(swap).not.toHaveBeenCalled();
});

it('compacts shared Codex threads through their existing server thread', async () => {
  const compactThread = vi.fn(async () => {}), sendPrompt = vi.fn(), swap = vi.fn();
  expect(await compactTrapSession({ ...trap('codex'), codexServer: true }, undefined, { compactThread, sendPrompt, swap })).toBe('thread/compact/start');
  expect(compactThread).toHaveBeenCalledWith('same-session');
  expect(sendPrompt).not.toHaveBeenCalled();
  expect(swap).not.toHaveBeenCalled();
});

it('uses a fresh-session swap for a Codex trap without a supported input route', async () => {
  const sendPrompt = vi.fn(async () => ({ blocked: 'no supported input route', unavailable: true as const })), swap = vi.fn(async () => ({} as never));
  expect(await compactTrapSession(trap('codex'), { id: 'job', lane: 'work' }, { sendPrompt, swap })).toBe('fresh-session swap');
  expect(swap).toHaveBeenCalledWith('job', 'work', expect.objectContaining({ harness: 'codex' }));
});

it('does not type /compact into a permission dialog or replace a Claude session', async () => {
  const tmux: TmuxRunner = vi.fn(async () => '❯ Allow once\n? for shortcuts');
  const swap = vi.fn();
  const sendPrompt: typeof sendSessionPrompt = (session, text, options) => sendSessionPrompt(session, text, { ...options, tmux, writerAlive: () => true });
  await expect(compactTrapSession({ ...trap('claude'), window: { tmuxPane: '%4', tmuxSocket: '/tmp/lobstah' } }, undefined, { sendPrompt, swap })).rejects.toThrow('Could not compact');
  expect(tmux).toHaveBeenCalledTimes(1);
  expect(swap).not.toHaveBeenCalled();
});

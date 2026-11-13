import { expect, it, vi } from 'vitest';
import { USAGE_RESET_MESSAGE, createUsageLimitWatch, usageComposerReady, wakeUsageSession } from '../src/usage-limit-watch.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimBait, enqueue, ensureLayout, signOnTrap } from '@lobstah/core';
import { removeTempDir } from '../../../test/temp-dir.js';
import type { TmuxRunner } from '../src/tmux-terminal.js';

it('sends the reset message to the existing idle pane without starting another process', async () => {
  const calls: string[][] = [];
  const tmux: TmuxRunner = async (args) => {
    calls.push(args);
    return args[0] === 'capture-pane' ? '❯\n? for shortcuts · auto mode' : '';
  };
  const result = await wakeUsageSession(
    { harness: 'claude', sessionId: 'limited-session', window: { tmuxPane: '%4', tmuxSocket: '/tmp/lobstah' } },
    { tmux, writerAlive: () => true },
  );
  expect(result).toBe('started');
  expect(calls.filter((args) => args[0] === 'send-keys')).toEqual([
    ['send-keys', '-t', '%4', '-l', USAGE_RESET_MESSAGE],
    ['send-keys', '-t', '%4', 'Enter'],
  ]);
});

it('does not type into a permission dialog, a busy turn or a reused terminal tab', async () => {
  expect(usageComposerReady('claude', '❯ Allow once\n? for shortcuts')).toBe(false);
  expect(usageComposerReady('claude', '❯\nesc to interrupt')).toBe(false);
  expect(usageComposerReady('claude', '❯')).toBe(false);
  const tmux = vi.fn(async () => '❯\n? for shortcuts');
  expect(
    await wakeUsageSession(
      { harness: 'claude', sessionId: 'gone', window: { tmuxPane: '%4', tmuxSocket: '/tmp/lobstah' } },
      { tmux, writerAlive: () => false },
    ),
  ).toHaveProperty('blocked');
  expect(tmux).not.toHaveBeenCalled();
});

it('wakes a shared-server Codex session with one turn on its existing thread', async () => {
  const startTurn = vi.fn(async () => 'started' as const);
  expect(await wakeUsageSession({ harness: 'codex', sessionId: 'thread-1', codexServer: true }, { startTurn })).toBe('started');
  expect(startTurn).toHaveBeenCalledWith('thread-1', USAGE_RESET_MESSAGE);
});

it('targets the recorded native Terminal tab and checks its composer before sending the prompt', async () => {
  const calls: string[][] = [];
  const native = async (_script: string, args: string[]): Promise<string> => {
    calls.push(args);
    return '❯\n? for shortcuts · auto mode';
  };
  expect(
    await wakeUsageSession(
      { harness: 'claude', sessionId: 'native', window: { termProgram: 'Apple_Terminal', tty: 'ttys123' } },
      { native, writerAlive: () => true },
    ),
  ).toBe('started');
  expect(calls).toEqual([['ttys123'], ['ttys123', USAGE_RESET_MESSAGE]]);
});

it('never swaps by default and attempts the other harness only after explicit opt-in', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-limit-opt-in-'));
  const before = process.env.LOBSTAH_HOME,
    beforeClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.LOBSTAH_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
  try {
    ensureLayout();
    const config = path.join(home, 'config.toml');
    fs.writeFileSync(config, `[repos.r]\npath = '${home.replaceAll('\\', '/')}'\n`);
    const worktree = path.join(home, 'worktree');
    fs.mkdirSync(worktree);
    const signed = signOnTrap({ worktree, cwd: worktree, repo: 'r', harness: 'claude', sessionId: 'quota-limited', ttlMs: 60_000 });
    if (!('ok' in signed)) throw new Error('could not sign on');
    enqueue({ id: 'limited-work', repo: 'r', brief: 'Continue the release', for: `wt:${signed.ok.trapId}` });
    claimBait(signed.ok);
    const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'test', 'quota-limited.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        isApiErrorMessage: true,
        error: 'rate_limit',
        message: { content: [{ type: 'text', text: 'Usage limit reached' }] },
      }) + '\n',
    );
    const swap = vi.fn(async () => {
      throw new Error('injected launch stop');
    });
    const watch = createUsageLimitWatch({ swap });
    watch(Date.now(), () => {});
    expect(swap).not.toHaveBeenCalled();
    fs.appendFileSync(config, '\n[soak]\nswapOnLimit = true\n');
    watch(Date.now(), () => {});
    expect(swap).toHaveBeenCalledWith('limited-work', 'work', expect.objectContaining({ harness: 'codex' }));
    watch(Date.now(), () => {});
    expect(swap).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    if (before === undefined) delete process.env.LOBSTAH_HOME;
    else process.env.LOBSTAH_HOME = before;
    if (beforeClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = beforeClaude;
    removeTempDir(home);
  }
});

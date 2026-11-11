import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claimBait, enqueue, ensureLayout, readStatusLog, readTrap, signOnTrap, type TrapRegistration } from '@lobstah/core';
import { codexClaimWakeMessage, codexPaneReady, codexWakeRoute, createCodexClaimWatch } from '../src/codex-claim-watch.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const ID = '44444444-4444-4444-8444-444444444444';
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-codex-claim-watch-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

/** A Codex trap that claimed ID; returns the trap and when it claimed. */
function claimedCodexTrap(over: Partial<TrapRegistration> = {}): { trap: TrapRegistration; at: number } {
  const worktree = path.join(home, 'wt');
  fs.mkdirSync(worktree, { recursive: true });
  const signed = signOnTrap({ worktree, cwd: worktree, repo: 'web', harness: 'codex', sessionId: 'codex-thread-1', ttlMs: 60_000, ...over });
  if (!('ok' in signed)) throw new Error('unexpected hold');
  enqueue({ id: ID, repo: 'web', for: `wt:${signed.ok.trapId}`, brief: 'fix the build' });
  claimBait(readTrap(signed.ok.trapId)!);
  return { trap: readTrap(signed.ok.trapId)!, at: Date.parse(readStatusLog(ID, 'work').at(-1)!.at) };
}
const WAKE_MS = 120_000;
const LOBSTAH_PANE = { tmuxPane: '%7', tmuxSocket: '/private/tmp/tmux-501/lobstah' };
/** The bottom of an idle Codex TUI, as tmux captures it. */
const IDLE = '  Worked for 2h 31m 55s • 2:54 PM\n› Ask Codex to do anything\n  GPT-6-Luna high · ~/wt · Soak a…\n  ? for shortcuts    ⚠ 6 warnings · f2 to view\n';

describe('the Codex claim watch', () => {
  it("types the wake into a silent trap's pane once, as one prompt", async () => {
    const { at } = claimedCodexTrap({ window: LOBSTAH_PANE });
    const tmux = vi.fn(async (args: string[]) => (args[0] === 'capture-pane' ? IDLE : ''));
    const watch = createCodexClaimWatch({ tmux });
    const logs: string[] = [];
    await watch(at + WAKE_MS, (m) => logs.push(m));
    expect(tmux.mock.calls.map((c) => c[0])).toEqual([
      ['capture-pane', '-p', '-t', '%7'],
      ['send-keys', '-t', '%7', '-l', codexClaimWakeMessage(ID)],
      ['send-keys', '-t', '%7', 'Enter'],
    ]);
    expect(codexClaimWakeMessage(ID)).not.toContain('\n');
    expect(logs.join('\n')).toContain(`woke Codex trap`);
    tmux.mockClear();
    await watch(at + WAKE_MS + 1000, () => {});
    expect(tmux).not.toHaveBeenCalled();
  });

  it('never types into a pane at a dialog, where Enter would choose an option', () => {
    expect(codexPaneReady(IDLE.replace(/\n/g, ' ⏎ '))).toBe(true);
    const review = '  Hooks need review ⏎  7 hooks are new or changed ⏎ › 1. Review ⏎   2. Trust all ⏎   3. Continue without trusting';
    expect(codexPaneReady(review)).toBe(false);
    expect(codexPaneReady('  This conversation is open in another app ⏎  Press enter to continue')).toBe(false);
    expect(codexPaneReady('• Working (12s • esc to interrupt) ⏎ › ⏎ ? for shortcuts')).toBe(false);
  });

  it('counts a pane at a dialog as its one wake, so the claim is released on schedule', async () => {
    const { at } = claimedCodexTrap({ window: LOBSTAH_PANE });
    const tmux = vi.fn(async (args: string[]) => (args[0] === 'capture-pane' ? '  Hooks need review\n› 1. Review\n  2. Trust all\n' : ''));
    const logs: string[] = [];
    await createCodexClaimWatch({ tmux })(at + WAKE_MS, (m) => logs.push(m));
    expect(tmux.mock.calls.map((c) => c[0][0])).toEqual(['capture-pane']);
    expect(logs.join('\n')).toContain('Hooks need review');
    const released: string[] = [];
    await createCodexClaimWatch({ tmux })(at + WAKE_MS + 600_000, (m) => released.push(m));
    expect(released.join('\n')).toContain('back in the queue');
  });

  it('waits while the pane shows a running turn', async () => {
    const { at } = claimedCodexTrap({ window: LOBSTAH_PANE });
    const tmux = vi.fn(async (args: string[]) => (args[0] === 'capture-pane' ? '• Working (12s • esc to interrupt)\n' : ''));
    const watch = createCodexClaimWatch({ tmux });
    await watch(at + WAKE_MS, () => {});
    await watch(at + WAKE_MS + 1000, () => {});
    expect(tmux.mock.calls.every((c) => c[0][0] === 'capture-pane')).toBe(true);
  });

  it('starts a turn on the shared server for a trap there', async () => {
    const { at } = claimedCodexTrap({ codexServer: true });
    const startTurn = vi.fn(async () => 'started' as const);
    await createCodexClaimWatch({ startTurn })(at + WAKE_MS, () => {});
    expect(startTurn).toHaveBeenCalledWith('codex-thread-1', codexClaimWakeMessage(ID));
  });

  it("reaches a trap by the shared server, or by its pane on lobstah's tmux server, and says why not otherwise", () => {
    const trap = (over: Partial<TrapRegistration>) => ({ trapId: 't', sessionId: 'thread-9', ...over }) as TrapRegistration;
    expect(codexWakeRoute(trap({ codexServer: true }))).toEqual({ kind: 'server', threadId: 'thread-9' });
    expect(codexWakeRoute(trap({ window: LOBSTAH_PANE }))).toEqual({ kind: 'pane', pane: '%7' });
    expect(codexWakeRoute(trap({ window: { tmuxPane: '%1', tmuxSocket: '/tmp/tmux-501/default' } }))).toMatchObject({ kind: 'none', why: 'its pane is on another tmux server' });
    expect(codexWakeRoute(trap({}))).toMatchObject({ kind: 'none' });
  });
});

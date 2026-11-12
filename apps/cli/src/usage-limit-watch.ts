import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  acknowledgeUsageReset,
  harnessProcessAlive,
  laneOf,
  listTraps,
  loadConfig,
  observeUsageLimits,
  postNotice,
  readRoster,
  readTrap,
  sendMessageOnce,
  trapHasBackgroundWait,
  trapUsageLimit,
  usageAccount,
} from '@lobstah/core';
import type { TrapRegistration, WindowRef } from '@lobstah/core';
import { startCodexTurn } from './codex-server.js';
import { codexPaneReady } from './codex-claim-watch.js';
import { TMUX_SOCKET, tmuxPaneTail, tmuxRunner, type TmuxRunner } from './tmux-terminal.js';
import { swapTrapCatch } from './trap-swap.js';

const exec = promisify(execFile);
export const USAGE_RESET_MESSAGE =
  'The usage limit has reset; continue where you stopped. Run `lobstah soak --wait --timeout 0` in the foreground first to restore your listener and read queued work.';
type WakeTrap = Pick<TrapRegistration, 'harness' | 'sessionId' | 'window' | 'codexServer' | 'harnessProcess'>;
type WakeResult = 'started' | 'busy' | { blocked: string };

/** A prompt may enter an idle harness composer, never a permission or trust dialog. */
export function usageComposerReady(harness: string, screen: string): boolean {
  if (/esc to interrupt|allow once|do you want to|trust this folder|enter to confirm/i.test(screen)) return false;
  return harness === 'codex'
    ? codexPaneReady(screen)
    : /(^|\n|⏎)\s*❯/.test(screen) && /bypass permissions|shift.tab|\? for shortcuts|accept edits|auto mode/i.test(screen);
}

/** Select only the recorded Terminal tab or iTerm session; inputs are argv, never interpolated script. */
function terminalScript(window: WindowRef, writing: boolean): { script: string; id: string } | undefined {
  if (window.termProgram === 'Apple_Terminal' && window.tty)
    return {
      id: window.tty,
      script: `on run argv
      tell application "Terminal"
        repeat with w in windows
          repeat with t in tabs of w
            if (tty of t as string) ends with (item 1 of argv) then
              ${writing ? 'do script (item 2 of argv) in t\nreturn "started"' : 'return contents of t'}
            end if
          end repeat
        end repeat
      end tell
      error "recorded Terminal tab not found"
    end run`,
    };
  const id = window.itermSession?.split(':').at(-1);
  if (id && /^[a-f0-9-]{36}$/i.test(id))
    return {
      id,
      script: `on run argv
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if id of s contains (item 1 of argv) then
                ${writing ? 'tell s to write text (item 2 of argv)\nreturn "started"' : 'return contents of s'}
              end if
            end repeat
          end repeat
        end repeat
      end tell
      error "recorded iTerm session not found"
    end run`,
    };
  return undefined;
}

/** Process and terminal seams let tests prove targeted delivery without touching a live pane. */
export interface UsageLimitWatchOptions {
  /** The opt-in handover, injectable so tests never stop a real harness. */
  swap?: typeof swapTrapCatch;
  /** Verify the recorded writer before typing into a tab that might now hold a shell. */
  writerAlive?: (trap: WakeTrap) => boolean;
  tmux?: TmuxRunner;
  startTurn?: typeof startCodexTurn;
  native?: (script: string, args: string[]) => Promise<string>;
}

/** Wake one existing session; a shared Codex thread receives a turn, never a second process. */
export async function wakeUsageSession(trap: WakeTrap, options: UsageLimitWatchOptions = {}): Promise<WakeResult> {
  if (trap.codexServer) return (options.startTurn ?? startCodexTurn)(trap.sessionId, USAGE_RESET_MESSAGE);
  const alive = options.writerAlive ? options.writerAlive(trap) : !!trap.harnessProcess && harnessProcessAlive(trap.harnessProcess);
  if (!alive) return { blocked: 'its recorded harness process is no longer running; open the saved session to continue' };
  const window = trap.window;
  if (window?.tmuxPane && window.tmuxSocket && path.basename(window.tmuxSocket) === TMUX_SOCKET) {
    const run = options.tmux ?? tmuxRunner();
    const screen = await tmuxPaneTail(window.tmuxPane, 6, run);
    if (screen && /esc to interrupt/i.test(screen)) return 'busy';
    if (!screen || !usageComposerReady(trap.harness, screen)) return { blocked: 'its pane is not at an idle harness composer' };
    await run(['send-keys', '-t', window.tmuxPane, '-l', USAGE_RESET_MESSAGE]);
    await run(['send-keys', '-t', window.tmuxPane, 'Enter']);
    return 'started';
  }
  const read = window && terminalScript(window, false),
    write = window && terminalScript(window, true);
  if (read && write && (process.platform === 'darwin' || options.native)) {
    const native =
      options.native ??
      (async (script: string, args: string[]): Promise<string> =>
        (await exec('osascript', ['-e', script, '--', ...args], { timeout: 5000, maxBuffer: 256 * 1024 })).stdout);
    const screen = (await native(read.script, [read.id])).split(/\r?\n/).filter(Boolean).slice(-8).join('\n');
    if (!usageComposerReady(trap.harness, screen)) return { blocked: 'its tab is not at an idle harness composer' };
    await native(write.script, [write.id, USAGE_RESET_MESSAGE]);
    return 'started';
  }
  return { blocked: 'open the recorded session and send the reset message; no supported input route is recorded' };
}

/** Detect before ghost sweeping; retry reset prompts until their existing sessions receive them. */
export function createUsageLimitWatch(options: UsageLimitWatchOptions = {}): (now: number, log: (message: string) => void) => void {
  const running = new Set<string>();
  const swapAttempts = new Map<string, number>();
  return (now, log): void => {
    const wakes = observeUsageLimits(now);
    const config = loadConfig();
    if (config.soak.swapOnLimit)
      for (const trap of listTraps()) {
        if (!trap.claimed || trap.configured || running.has(trap.trapId) || !trapUsageLimit(trap)) continue;
        const harness = trap.harness === 'claude' ? 'codex' : 'claude';
        const lane = laneOf(trap.claimed);
        if (!lane || trapUsageLimit({ harness })) continue;
        if (now - (swapAttempts.get(trap.trapId) ?? -Infinity) < 60_000) continue;
        swapAttempts.set(trap.trapId, now);
        running.add(trap.trapId);
        void (options.swap ?? swapTrapCatch)(trap.claimed, lane, { cfg: config, harness })
          .then(() => log(`usage limit: moved ${trap.name ?? trap.trapId} to ${harness}`))
          .catch((error) => {
            const reason = error instanceof Error ? error.message : String(error);
            log(`usage limit: ${reason}`);
            postNotice({
              kind: 'usage-limit',
              text: `${usageAccount(trap)} automatic swap needs attention · ${reason}`,
              dedupeKey: `usage-swap-blocked-${usageAccount(trap).replace(/\W/g, '-')}-${trapUsageLimit(trap)?.resetAt ?? 'unknown'}`,
            });
          })
          .finally(() => running.delete(trap.trapId));
      }
    for (const wake of wakes) {
      if (running.has(wake.trapId)) continue;
      const trap = readTrap(wake.trapId),
        roster = readRoster(wake.trapId),
        session = trap ?? roster;
      if (!session || session.sessionId !== wake.sessionId || (!trap && roster?.state === 'stowed')) {
        acknowledgeUsageReset(wake);
        continue;
      }
      running.add(wake.trapId);
      void (async (): Promise<void> => {
        if (trap?.claimed) {
          const lane = laneOf(trap.claimed);
          if (lane) sendMessageOnce(trap.claimed, lane, `usage-reset-${wake.fingerprint}`, USAGE_RESET_MESSAGE, 'usage-limit');
          if (trapHasBackgroundWait(trap, now)) {
            acknowledgeUsageReset(wake);
            return;
          }
        }
        const result = await wakeUsageSession(session, options);
        if (result === 'started' || result === 'busy') {
          acknowledgeUsageReset(wake);
          log(`usage limit reset: woke ${session.name ?? session.trapId}`);
        } else if (typeof result === 'object')
          postNotice({
            kind: 'usage-limit-reset',
            refId: wake.trapId,
            text: `${usageAccount(session)} limit reset · ${session.name ?? session.trapId} needs its session opened · ${result.blocked}`,
            dedupeKey: `usage-reset-blocked-${usageAccount(session).replace(/\W/g, '-')}-${wake.resetAt}`,
          });
      })()
        .catch((error) => {
          const reason = error instanceof Error ? error.message : String(error);
          log(`usage reset for ${session.name ?? session.trapId}: ${reason}`);
          postNotice({
            kind: 'usage-limit-reset',
            text: `${usageAccount(session)} limit reset · open ${session.name ?? session.trapId} to continue · ${reason}`,
            dedupeKey: `usage-reset-blocked-${usageAccount(session).replace(/\W/g, '-')}-${wake.resetAt}`,
          });
        })
        .finally(() => {
          running.delete(wake.trapId);
        });
    }
  };
}

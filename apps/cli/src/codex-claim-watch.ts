import * as path from 'node:path';
import {
  loadConfig,
  recordClaimWake,
  releaseUnacknowledgedClaim,
  unacknowledgedCodexClaims,
  unreportedTrapBait,
  type TrapRegistration,
} from '@lobstah/core';
import { startCodexTurn } from './codex-server.js';
import { TMUX_SOCKET, tmuxPaneTail, tmuxRunner, type TmuxRunner } from './tmux-terminal.js';

/**
 * What a silent Codex trap is told: one line, so it can be typed into a TUI
 * as a single prompt. A foreground `soak --wait` re-delivers the claimed
 * brief, which is kept until the worker's first report.
 */
export function codexClaimWakeMessage(dispatchId: string): string {
  return (
    `lobstah: dispatch ${dispatchId} was claimed for you, but its brief reached a listener after your turn ended, so you never saw it. ` +
    'Run `lobstah soak --wait --timeout 0` now, in the foreground, to receive it. ' +
    'On Codex, always run `lobstah soak --wait` in the foreground: a background command that finishes after your turn ends never starts a new turn.'
  );
}

/** Codex's TUI shows this while a turn runs: a prompt typed then would wait in line. */
const CODEX_BUSY = /esc to interrupt/i;
/**
 * Codex's idle composer: its `›` prompt line and the footer under it. Only
 * then does typed text land in the composer. A dialog (hook review, a
 * permission prompt, "open in another app") hides both, and Enter there
 * would choose one of its options.
 */
export function codexPaneReady(screen: string): boolean {
  return /(^|⏎)\s*›/.test(screen) && /\? for shortcuts/.test(screen) && !CODEX_BUSY.test(screen);
}

/** How the daemon reaches one trap's Codex session, or why it can't. */
export type CodexWakeRoute = { kind: 'server'; threadId: string } | { kind: 'pane'; pane: string } | { kind: 'none'; why: string };

/** A trap on the shared server takes a turn by RPC; one in a pane on lobstah's tmux server takes typed input. */
export function codexWakeRoute(trap: TrapRegistration): CodexWakeRoute {
  if (trap.codexServer) return { kind: 'server', threadId: trap.sessionId };
  const pane = trap.window?.tmuxPane;
  const socket = trap.window?.tmuxSocket;
  if (pane && socket && path.basename(socket) === TMUX_SOCKET) return { kind: 'pane', pane };
  return { kind: 'none', why: pane ? 'its pane is on another tmux server' : 'it records no tmux pane and is not on the shared Codex server' };
}

/** Type `text` into a pane as one prompt and submit it. */
async function typeIntoPane(pane: string, text: string, run: TmuxRunner): Promise<'started' | 'busy' | { blocked: string }> {
  const screen = await tmuxPaneTail(pane, 4, run);
  // A running turn: the next tick looks again.
  if (screen && CODEX_BUSY.test(screen)) return 'busy';
  // A dialog or an unreadable pane: lobstah won't type into it.
  if (!screen || !codexPaneReady(screen)) return { blocked: screen ? `its pane shows ${screen}` : 'its pane cannot be read' };
  await run(['send-keys', '-t', pane, '-l', text]);
  await run(['send-keys', '-t', pane, 'Enter']);
  return 'started';
}

/** Test seams for the watch; production uses the real server and tmux. */
export interface CodexClaimWatchDeps {
  startTurn?: typeof startCodexTurn;
  tmux?: TmuxRunner;
}

/**
 * The daemon's `codexClaimWatch` hook (see unacknowledgedCodexClaims). Each
 * tick it wakes a Codex trap that claimed work and hasn't reported, once per
 * claim; releases the claim when the trap stays silent after that; and
 * finalizes a cancel nobody is reading. A trap busy in a turn isn't woken:
 * the next tick tries again.
 */
export function createCodexClaimWatch(deps: CodexClaimWatchDeps = {}): (now: number, log: (message: string) => void) => Promise<void> | undefined {
  let running = false;
  return (now, log) => {
    if (running) return undefined;
    const soak = loadConfig().soak;
    const steps = unacknowledgedCodexClaims(now, { wakeAfterMs: soak.codexClaimWakeSecs * 1000, releaseAfterMs: soak.codexClaimReleaseSecs * 1000 });
    if (steps.length === 0) return undefined;
    running = true;
    // The daemon doesn't wait for this; tests do.
    return (async () => {
      for (const step of steps) {
        const name = step.trap.name ?? step.trap.trapId;
        if (step.kind !== 'wake') {
          const { requeued, finalized } = releaseUnacknowledgedClaim(step);
          if (requeued) log(`Codex trap ${name} never reported for ${requeued} after a wake: back in the queue`);
          if (finalized) log(`Codex trap ${name} never read its cancelled ${finalized}: finalized`);
          continue;
        }
        const claimAt = unreportedTrapBait(step.trap)?.claim.at;
        if (!claimAt) continue;
        const route = codexWakeRoute(step.trap);
        try {
          const text = codexClaimWakeMessage(step.dispatchId);
          const result =
            route.kind === 'server'
              ? await (deps.startTurn ?? startCodexTurn)(route.threadId, text)
              : route.kind === 'pane'
                ? await typeIntoPane(route.pane, text, deps.tmux ?? tmuxRunner())
                : undefined;
          if (result === 'busy') continue;
          // A wake that can't be delivered still counts as the one wake: the release follows on schedule.
          recordClaimWake(step.trap, step.dispatchId, claimAt, now);
          const why = route.kind === 'none' ? route.why : typeof result === 'object' ? result.blocked : undefined;
          log(why ? `cannot wake Codex trap ${name} for ${step.dispatchId}: ${why}` : `woke Codex trap ${name} for its unread ${step.dispatchId}`);
        } catch (error) {
          log(`could not wake Codex trap ${name} for ${step.dispatchId}, will retry: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })().finally(() => {
      running = false;
    });
  };
}

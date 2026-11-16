import {
  IdleWait, acknowledgeTrapMessage, baitBrief, cancelRequested, claimBait,
  hasOpenCatch, heartbeatTrap, laneOf, loadConfig, needsFreshTrapSession,
  readTrap, resumeTrapTurn, stowTrap, toonHelp, toonKV, trapSessionTitle,
  TRAP_INSTRUCTION_RULE, unhandled, unhandledTrapMessages, unreportedTrapBait,
} from '@lobstah/core';

/** Leave time for hook setup and output before the harness's 14,500s limit. */
export const HOOK_PARK_MS = 14_400_000;
export const PARK_RENEWAL_REASON = 'lobstah: this trap is still signed on. End this turn now to keep listening; the Stop hook will park again.';

/** How a park ended: an event, sign-off, hook renewal, or an explicit zero-time probe. */
export type ParkEnd = 'woke' | 'gone' | 'timeout';

/**
 * The trap side of the park: heartbeat, then wait for something to act on.
 * Messages deliver first (cheap context, no catch lifecycle), then bait; a
 * trap with an open catch waits for a cancel or a `lobstah send` message
 * about it. Driven by the Stop hook (wakes are hook-decision JSON; quiet
 * deadlines renew in the shell) or run as `soak --wait` in a hookless
 * session (wakes print plain; --timeout 0 is an explicit one-shot probe).
 */
export async function soakPark(trapId: string, timeout: string | undefined, plain = false): Promise<ParkEnd> {
  // Both plugins allow 14,500 seconds. Quiet deadlines renew independently;
  // return to the harness before its absolute deadline kills this hook.
  const hookDeadline = plain ? Infinity : Date.now() + HOOK_PARK_MS;
  const sessionId = readTrap(trapId)?.sessionId;
  let idle = new IdleWait(sessionId, loadConfig().wait, timeout);
  const rearm = `lobstah soak --wait${timeout === undefined ? '' : ` --timeout ${timeout}`}`;
  // Self-instructive in plain mode (axi.md P9): every exit tells the session
  // its own next command — a foreground park has no hook to re-arm it.
  const block = plain
    ? (reason: string) => {
        idle.woke();
        const trap = readTrap(trapId);
        if (trap) resumeTrapTurn(trap, true);
        console.log(reason);
        console.log(toonHelp([`${rearm}   (when you finish handling this, run this here to keep listening)`]));
      }
    : (reason: string) => { idle.woke(); const trap = readTrap(trapId); if (trap) resumeTrapTurn(trap, true); console.log(JSON.stringify({ decision: 'block', reason })); };
  while (true) {
    if (readTrap(trapId)?.sessionId !== sessionId) return 'gone';
    const reg = heartbeatTrap(trapId, { parked: true });
    if (!reg) {
      if (plain) {
        console.log(
          toonKV({ trap: `wt:${trapId}`, soaking: false, note: 'registration gone (stowed or swept) — sign on again with `lobstah soak`' }),
        );
      }
      return 'gone'; // stowed while parked
    }
    // Messages before bait: steering should never queue behind a work claim.
    const msgs = unhandledTrapMessages(trapId);
    if (msgs.length > 0) {
      const lines = msgs.map((m) => {
        acknowledgeTrapMessage(trapId, m.file);
        return `[from ${m.from}] ${m.text}`;
      });
      block(
        [
          `Message${msgs.length > 1 ? 's' : ''} for this session:`,
          ...lines,
          TRAP_INSTRUCTION_RULE,
        ].join('\n'),
      );
      return 'woke';
    }
    if (hasOpenCatch(reg)) {
      const id = reg.claimed!;
      const lane = laneOf(id) ?? 'work';
      if (cancelRequested(id, lane)) {
        block(
          `Your assigned dispatch ${id} was cancelled. Stop working on it, leave the worktree as it is, ` +
            `and run \`lobstah report ${id} failed "cancelled by request"\`.`,
        );
        return 'woke';
      }
      const pending = unreportedTrapBait(reg);
      const messages = unhandled(id, lane);
      const instruction = messages.length > 0 ? [
        `New instruction for your dispatch ${id}:`,
        ...messages.map((m) => m.text),
        `Read it with \`lobstah inbox ${id}\`, act on it, and keep reporting.`,
        TRAP_INSTRUCTION_RULE,
      ].join('\n\n') : undefined;
      // The daemon swaps outside this process; the old conversation never receives fresh work.
      const awaitingFreshSession = pending && needsFreshTrapSession(pending.descriptor);
      if (!awaitingFreshSession && (pending || instruction)) {
        // Include steering and the unread brief in the continuation itself.
        // The inbox stays unread until the worker consumes it through `inbox`.
        block([instruction, pending ? baitBrief(id, pending.descriptor) : undefined].filter(Boolean).join('\n\n'));
        return 'woke';
      }
    } else {
      if (reg.one && reg.claimed) {
        stowTrap(trapId, 'signed off after its one catch', reg.sessionId);
        return 'gone'; // one catch was the deal — the trap comes out of the water
      }
      const caught = claimBait(reg);
      if (caught && !needsFreshTrapSession(caught.descriptor)) {
        if (plain) {
          const title = trapSessionTitle({ sessionId: reg.sessionId, cwd: reg.worktree })?.title;
          if (title) console.log(toonKV({ title }));
        }
        block(baitBrief(caught.id, caught.descriptor));
        return 'woke';
      }
    }
    if (!idle.probe && Date.now() >= hookDeadline) {
      console.log(JSON.stringify({ decision: 'block', reason: PARK_RENEWAL_REASON }));
      return 'timeout';
    }
    if (idle.expired()) {
      idle.timedOut();
      if (!idle.probe) {
        // Renew inside the shell process: a quiet deadline never requests another model turn.
        idle = new IdleWait(sessionId, loadConfig().wait, timeout);
        continue;
      }
      if (plain) {
        console.log(toonKV({ timeout: true, waitedSecs: idle.timeoutSecs, stillSignedOn: true }));
        console.log(toonHelp([`${rearm}   (no work yet — run this again to keep listening)`, `lobstah stow   (sign off instead)`]));
        process.exitCode = 3;
      }
      return 'timeout';
    }
    await new Promise((r) => setTimeout(r, Math.min(idle.pollMs(1500), Math.max(1, hookDeadline - Date.now()))));
  }
}

import fs from 'node:fs';
import path from 'node:path';
import {
  atomicRenameSync, codexIdleWakeAt, dispatchProgress, hasOpenCatch, laneOf, listTraps, loadConfig,
  lobstahHome, recordCodexIdleWake, trapUsageLimit, unhandled, unhandledTrapMessages, uniqueTempPath,
  type TrapRegistration,
} from '@lobstah/core';
import { wakeCodexTrap, type CodexClaimWatchDeps } from './codex-claim-watch.js';

export function codexIdleWakeMessage(id: string): string {
  return `lobstah: you ended your turn while dispatch ${id} still reports working. Read your dispatch with \`lobstah status ${id}\` and keep working now, in this same turn. Check \`lobstah inbox ${id}\` and \`lobstah soak --wait --timeout 0\` for steering. Do not stop after an acknowledgement or takeover note; continue until done, failed, needs-decision, blocked, or paused.`;
}

interface Delivered { sessionId: string; messages: string[] }
const deliveryFile = (trap: TrapRegistration) => path.join(lobstahHome(), 'codex-send-wakes', `${encodeURIComponent(trap.trapId)}.json`);
function delivered(trap: TrapRegistration): string[] {
  try {
    const old = JSON.parse(fs.readFileSync(deliveryFile(trap), 'utf8')) as Delivered;
    return old.sessionId === trap.sessionId ? old.messages : [];
  } catch { return []; }
}
function recordDelivery(trap: TrapRegistration, messages: string[]) {
  const file = deliveryFile(trap);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, JSON.stringify({ sessionId: trap.sessionId, messages } satisfies Delivered));
  atomicRenameSync(tmp, file);
}

/** Recover stopped Codex workers and deliver sends even when no park hook is running. */
export function createCodexTrapWatch(deps: CodexClaimWatchDeps = {}) {
  let running = false;
  return (now: number, log: (message: string) => void): Promise<void> | undefined => {
    if (running) return undefined;
    running = true;
    return (async () => {
      const idle = new Set(dispatchProgress(now, loadConfig(), { includeRecoverableCodex: true }).filter(p => p.state === 'idle-while-working').map(p => p.id));
      for (const trap of listTraps()) {
        if (trap.harness !== 'codex' || trapUsageLimit(trap)) continue;
        const id = hasOpenCatch(trap) ? trap.claimed : undefined;
        const messages = [
          ...unhandledTrapMessages(trap.trapId).map(m => `trap:${m.file}`),
          ...(id ? unhandled(id, laneOf(id) ?? 'work').map(m => `dispatch:${id}:${m.file}`) : []),
        ];
        const old = delivered(trap);
        const send = messages.some(m => !old.includes(m));
        const recover = !!id && idle.has(id) && codexIdleWakeAt(trap) === undefined;
        if (!send && !recover) continue;
        const text = recover ? codexIdleWakeMessage(id!) : id
          ? `lobstah: new instructions for dispatch ${id}. Read \`lobstah inbox ${id}\` and \`lobstah soak --wait --timeout 0\` now to receive your messages, then act on them. Continue working in this turn until done, failed, needs-decision, blocked, or paused.`
          : 'lobstah: you have a new session message. Run `lobstah soak --wait --timeout 0` now in the foreground to receive it, then act on it.';
        try {
          const result = await wakeCodexTrap(trap, text, deps);
          if (result === 'busy') continue; // A live park hook also reads sends itself.
          if (recover) recordCodexIdleWake(trap, now);
          if (result === 'started') {
            if (send) recordDelivery(trap, messages);
            log(`woke Codex trap ${trap.name ?? trap.trapId}: ${recover ? `idle while working on ${id}` : 'unread send'}`);
          } else if (recover) {
            log(`cannot recover Codex trap ${trap.name ?? trap.trapId}: ${result.blocked}`);
          }
        } catch (error) {
          log(`could not wake Codex trap ${trap.name ?? trap.trapId}, will retry: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })().catch(error => {
      log(`codex trap watch failed, will retry: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { running = false; });
  };
}

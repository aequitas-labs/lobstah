import * as path from 'node:path';
import { DecisionError, readDecisionAnswer, standingDecisions, withdrawDecision } from './decisions.js';
import type { DecisionMeta, PermissionAsk } from './decisions.js';
import { listHelms } from './helm.js';
import { trapBySession } from './soak.js';
import { readStatusLog } from './status.js';
import { storedDescriptor } from './queue.js';

/** Harness lifecycle fields used to retire a permission card, without retaining tool output. */
export interface PermissionCardEvent {
  session_id?: string;
  hook_event_name?: string;
  tool_use_id?: string;
  turn_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  cwd?: string;
  tool_calls?: Array<{ tool_use_id?: string; tool_name?: string; tool_input?: unknown }>;
}

/** Recognize automatic requests, including cards written before call identities were stored. */
function waitsForTool(ask: PermissionAsk): boolean {
  return (
    !ask.helm &&
    ask.source !== 'proposal' &&
    !ask.intent &&
    (ask.call !== undefined ||
      (!!ask.session && !!ask.tool && (!ask.sessionGrant || ask.sessionGrant.reason === 'This tool call needs permission')))
  );
}

/** Match one completed call without retiring other parallel calls in the same session. */
function matchesCall(ask: PermissionAsk, event: PermissionCardEvent): boolean {
  if (ask.call?.id && event.tool_use_id) return ask.call.id === event.tool_use_id;
  if (!event.tool_name || !ask.tool) return false;
  const toolMatches = ask.tool === event.tool_name || (ask.tool.endsWith('*') && event.tool_name.startsWith(ask.tool.slice(0, -1)));
  if (!toolMatches) return false;
  const input = event.tool_input;
  if (typeof input !== 'object' || input === null) return false;
  const fields = input as Record<string, unknown>;
  if (ask.command !== undefined) {
    const command = fields.command ?? fields.cmd;
    return ask.command === (Array.isArray(command) ? command.map(String).join(' ') : command);
  }
  if (ask.path !== undefined) {
    const file = fields.file_path ?? fields.notebook_path ?? fields.path;
    return typeof file === 'string' && ask.path === path.resolve(event.cwd ?? process.cwd(), file);
  }
  return ask.call !== undefined;
}

/** Withdraw a card if it still stands; an answer that already won stays recorded. */
function retireCard(card: DecisionMeta): void {
  try {
    withdrawDecision(card.key);
  } catch (error) {
    if (error instanceof DecisionError && (error.status === 404 || (error.status === 409 && readDecisionAnswer(card.key)))) return;
    throw error;
  }
}

/** Retire automatic cards at call completion, denial, batch completion, or the end of their turn. */
export function settlePermissionCards(event: PermissionCardEvent): string[] {
  if (!event.session_id) return [];
  const endedTurn = ['Stop', 'SessionEnd', 'UserPromptSubmit'].includes(event.hook_event_name ?? '');
  const endedCall = ['PostToolUse', 'PostToolUseFailure', 'PermissionDenied'].includes(event.hook_event_name ?? '');
  const endedBatch = event.hook_event_name === 'PostToolBatch';
  const startingTurn = event.hook_event_name === 'PreToolUse' && event.turn_id;
  // Ordinary pre-tool checks and permission requests leave every pending call in place.
  if (!endedTurn && !endedCall && !endedBatch && !startingTurn) return [];
  const retired: string[] = [];
  for (const card of standingDecisions()) {
    const ask = card.permission;
    if (!ask || ask.session !== event.session_id || !waitsForTool(ask)) continue;
    const nextTurn = startingTurn && ask.call?.turn && ask.call.turn !== event.turn_id;
    const finishedBatch =
      endedBatch && event.tool_calls?.some((call) => matchesCall(ask, { ...call, cwd: event.cwd }));
    if (endedTurn || nextTurn || finishedBatch || (endedCall && matchesCall(ask, event))) {
      retireCard(card);
      retired.push(card.key);
    }
  }
  return retired;
}

/** Retire cards after their dispatch resumes or finishes, or their automatic request loses its session. */
export function reconcilePermissionCards(): string[] {
  const retired: string[] = [];
  for (const card of standingDecisions()) {
    const ask = card.permission;
    if (!ask || ask.helm) continue;
    const movedOn =
      card.dispatch &&
      readStatusLog(card.dispatch, card.lane ?? 'work').some(
        (entry) => entry.at > card.askedAt && ['working', 'paused', 'done', 'failed'].includes(entry.verb),
      );
    const trap = ask.session ? trapBySession(ask.session) : undefined;
    const dispatch = card.dispatch ? storedDescriptor(card.dispatch, card.lane ?? 'work') : undefined;
    const lostSession =
      (waitsForTool(ask) || dispatch) && ask.session && !trap && !listHelms().some((helm) => helm.sessionId === ask.session);
    const changedDispatch = dispatch && trap && trap.claimed !== card.dispatch;
    if (movedOn || lostSession || changedDispatch) {
      retireCard(card);
      retired.push(card.key);
    }
  }
  return retired;
}

import * as fs from 'node:fs';
import { decisionDir, readDecision, readDecisionAnswer } from './decisions.js';
import { parsePrRef } from './pr.js';
import { readPr } from './prs.js';
import { readRoster, rosterByAddress } from './roster.js';
import { readTrap, trapByAddress } from './soak.js';
import { readStatusLog } from './status.js';
import { trapAvailability } from './trap-availability.js';
import { TodoError, type TodoTrigger, type TodoTriggerSet, type TodoTriggerTarget } from './todos.js';
import { laneOf } from './worktrees.js';

/**
 * Todo triggers: what `--when` reads, whether lobstah can observe it, and
 * whether it has come true. A check reads only the local record a trigger
 * names, so it makes no GitHub calls and adds no watches.
 */

/** The dispatch verbs a trigger can wait on. */
const DISPATCH_VERBS = ['done', 'blocked', 'needs-decision', 'failed'] as const;
const PR_CONDITIONS = ['merged', 'closed', 'green'] as const;
const DISPATCH_ID = /^[A-Za-z0-9._-]+$/;

/** What a check found: not yet, true and how, or its record is gone. */
export type TriggerReading = { state: 'waiting' } | { state: 'met'; as: string } | { state: 'lost' };

function refuseUnobservable(subject: string): never {
  throw new TodoError(`lobstah can't observe "${subject}": it watches card:, dispatch:, pr: and trap:`);
}

function isOneOf<T extends string>(values: readonly T[], value: string | undefined): value is T {
  return values.includes(value as T);
}

/** Read one `--when` value, without checking that what it names exists. */
export function parseTodoTrigger(input: string): TodoTriggerTarget {
  const words = input.trim().split(/\s+/);
  const subject = words[0] ?? '';
  const condition = words[1];
  const separator = subject.indexOf(':');
  if (words.length > 2 || separator < 1) refuseUnobservable(subject || input);
  const kind = subject.slice(0, separator);
  const name = subject.slice(separator + 1);

  if (kind === 'card') {
    if (condition !== undefined) throw new TodoError(`a card trigger takes no condition, because an answer or a withdrawal both fire it: "${input.trim()}"`);
    return { kind: 'card', key: name.startsWith('decision:') ? name : `decision:${name}` };
  }
  if (kind === 'dispatch') {
    if (!DISPATCH_ID.test(name)) throw new TodoError(`not a dispatch id: "${name}"`);
    if (!isOneOf(DISPATCH_VERBS, condition)) throw new TodoError(`"${subject}" needs a verb to wait on: ${DISPATCH_VERBS.join(', ')}`);
    return { kind: 'dispatch', id: name, verb: condition };
  }
  if (kind === 'pr') {
    const ref = parsePrRef(subject);
    if (!ref) throw new TodoError(`not a PR reference: "${subject}": use pr:<owner>/<repo>#<number>`);
    if (!isOneOf(PR_CONDITIONS, condition)) throw new TodoError(`"${subject}" needs a condition to wait on: ${PR_CONDITIONS.join(', ')}`);
    return { kind: 'pr', key: ref.key, on: condition };
  }
  if (kind === 'trap') {
    if (condition !== 'free') throw new TodoError(`"${subject}" needs the condition it waits on: free`);
    return { kind: 'trap', trapId: '', name };
  }
  return refuseUnobservable(subject);
}

/**
 * Refuse a local trigger whose target lobstah doesn't know, and fill in what
 * it resolves to. A PR is read from GitHub by the CLI, which holds the watch.
 */
export function resolveTodoTrigger(target: TodoTriggerTarget): TodoTriggerTarget {
  if (target.kind === 'card') {
    if (!readDecision(target.key)) throw new TodoError(`no card ${target.key}: \`lobstah tend\` lists the cards that stand`);
    return target;
  }
  if (target.kind === 'dispatch') {
    if (!laneOf(target.id)) throw new TodoError(`no dispatch ${target.id}`);
    return target;
  }
  if (target.kind === 'trap') {
    const trapId = trapByAddress(target.name)?.trapId ?? rosterByAddress(target.name)?.trapId;
    if (!trapId) throw new TodoError(`no trap named "${target.name}"`);
    return { ...target, trapId };
  }
  return target;
}

/** A trigger in the form `--when` reads: `pr:o/r#1 merged`. */
export function todoTriggerLabel(target: TodoTriggerTarget): string {
  if (target.kind === 'card') return `card:${target.key}`;
  if (target.kind === 'dispatch') return `dispatch:${target.id} ${target.verb}`;
  if (target.kind === 'pr') return `${target.key} ${target.on}`;
  return `trap:${target.name} free`;
}

/** Whether a dispatch reported the verb after the todo was made, or stood at it when the todo was made. */
function dispatchReached(id: string, verb: string, createdAt: string): TriggerReading {
  const lane = laneOf(id);
  if (!lane) return { state: 'lost' };
  const since = Date.parse(createdAt);
  const entries = readStatusLog(id, lane);
  const latestAtAdd = entries.filter((entry) => Date.parse(entry.at) <= since).at(-1);
  const reported = latestAtAdd?.verb === verb || entries.some((entry) => entry.verb === verb && Date.parse(entry.at) > since);
  return reported ? { state: 'met', as: verb } : { state: 'waiting' };
}

/** Whether a PR record shows the condition. Green: at least one check, none failed, pending or unknown. */
function prReached(key: string, on: 'merged' | 'closed' | 'green'): TriggerReading {
  const pr = readPr(key);
  if (!pr) return { state: 'lost' };
  if (on === 'merged') return pr.state === 'MERGED' ? { state: 'met', as: 'merged' } : { state: 'waiting' };
  if (on === 'closed') return pr.state === 'CLOSED' ? { state: 'met', as: 'closed' } : { state: 'waiting' };
  const { total, failed, pending, unknown } = pr.checks;
  return total > 0 && failed === 0 && pending === 0 && unknown === undefined ? { state: 'met', as: 'green' } : { state: 'waiting' };
}

/** Whether a trap is signed on and free. A stowed one is only waiting; a forgotten one is gone. */
function trapReached(trapId: string): TriggerReading {
  const registration = readTrap(trapId);
  if (registration) return trapAvailability(registration).state === 'free' ? { state: 'met', as: 'free' } : { state: 'waiting' };
  return readRoster(trapId) ? { state: 'waiting' } : { state: 'lost' };
}

/** Read the one record this trigger names. `createdAt` is the todo's. */
export function readTodoTrigger(target: TodoTriggerTarget, createdAt: string): TriggerReading {
  if (target.kind === 'card') {
    if (readDecisionAnswer(target.key)) return { state: 'met', as: 'answered' };
    const dir = decisionDir(target.key);
    return dir && fs.existsSync(dir) ? { state: 'waiting' } : { state: 'met', as: 'withdrawn' };
  }
  if (target.kind === 'dispatch') return dispatchReached(target.id, target.verb, createdAt);
  if (target.kind === 'pr') return prReached(target.key, target.on);
  return trapReached(target.trapId);
}

/** What a todo waits on, with met ones marked: `pr:o/r#1 merged · ✓ trap:x free (any)`. */
export function todoWaitingOn(triggers: TodoTriggerSet): string {
  const items = triggers.items.map((item: TodoTrigger) => `${item.metAt ? '✓ ' : ''}${todoTriggerLabel(item)}`);
  return `${items.join(' · ')} (${triggers.mode})`;
}

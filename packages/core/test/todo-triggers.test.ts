import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { answerDecision, askDecision, decisionDir, withdrawDecision } from '../src/decisions.js';
import { prEvidence, type GhPrView } from '../src/pr.js';
import { parsePrRef } from '../src/pr.js';
import { prRecordFile, upsertPr } from '../src/prs.js';
import { enqueue, claimNext } from '../src/queue.js';
import { ensureLayout, laneDirs } from '../src/paths.js';
import { appendStatus } from '../src/status.js';
import { forgetRoster } from '../src/roster.js';
import { signOnTrap, stowTrap } from '../src/soak.js';
import { claimTodoFirings, fireDueTodos } from '../src/todo-fire.js';
import { parseTodoTrigger, readTodoTrigger, resolveTodoTrigger, todoTriggerLabel, todoWaitingOn } from '../src/todo-triggers.js';
import { addTodo, listTodos, snoozeTodo, staleTodos, TodoError, type TodoTriggerTarget } from '../src/todos.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const G = 'g';
const HOUR = 3600_000;
const later = () => Date.now() + HOUR;
const due = (ms: number) => new Date(ms).toISOString();
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-todo-triggers-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

const any = (...items: TodoTriggerTarget[]) => ({ mode: 'any' as const, items });
const all = (...items: TodoTriggerTarget[]) => ({ mode: 'all' as const, items });
const only = () => listTodos(G)[0]!;
const card = () => askDecision({ title: 'Ship?', grounds: G, askedBy: 'helm', maxBytes: 1024 }).meta.key;
const answer = (key: string) => answerDecision({ key, text: 'Yes', by: 'cli', now: new Date(), maxBytes: 1024 });
const dispatch = (id: string) => {
  enqueue({ id, repo: 'r', brief: 'b' });
  claimNext('work');
  return id;
};
const pr = (number: number, view: Partial<GhPrView> & { state: string }) => {
  const ref = parsePrRef(`o/r#${number}`)!;
  upsertPr(prEvidence(ref, { isDraft: false, headRefOid: 'abc', ...view } as GhPrView, new Date().toISOString()));
  return ref.key;
};
const passing = { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' };
const pending = { __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: null };
const failing = { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' };

describe('reading --when', () => {
  it('reads each kind', () => {
    expect(parseTodoTrigger('card:decision:ab12cd34')).toEqual({ kind: 'card', key: 'decision:ab12cd34' });
    expect(parseTodoTrigger('card:ab12cd34')).toEqual({ kind: 'card', key: 'decision:ab12cd34' });
    expect(parseTodoTrigger('dispatch:d1 needs-decision')).toEqual({ kind: 'dispatch', id: 'd1', verb: 'needs-decision' });
    expect(parseTodoTrigger('pr:o/r#7 merged')).toEqual({ kind: 'pr', key: 'pr:o/r#7', on: 'merged' });
    expect(parseTodoTrigger('trap:early-pebble free')).toMatchObject({ kind: 'trap', name: 'early-pebble' });
  });

  it('prints each kind back as it was read', () => {
    for (const text of ['card:decision:ab12cd34', 'dispatch:d1 done', 'pr:o/r#7 green']) expect(todoTriggerLabel(parseTodoTrigger(text))).toBe(text);
    expect(todoTriggerLabel({ kind: 'trap', trapId: 't', name: 'early-pebble' })).toBe('trap:early-pebble free');
  });

  it.each([
    ['deploy:prod done', `lobstah can't observe "deploy:prod": it watches card:, dispatch:, pr: and trap:`],
    ['ume:abc', `lobstah can't observe "ume:abc"`],
    ['linear:ENG-1 done', `lobstah can't observe "linear:ENG-1"`],
    ['whenever', `lobstah can't observe "whenever"`],
    ['dispatch:d1 working', '"dispatch:d1" needs a verb to wait on: done, blocked, needs-decision, failed'],
    ['dispatch:d1', 'needs a verb'],
    ['dispatch:../x done', 'not a dispatch id'],
    ['pr:o/r#7 approved', '"pr:o/r#7" needs a condition to wait on: merged, closed, green'],
    ['pr:nope merged', 'not a PR reference'],
    ['trap:x busy', '"trap:x" needs the condition it waits on: free'],
    ['card:ab12cd34 answered', 'a card trigger takes no condition'],
  ])('refuses %s', (input, message) => {
    expect(() => parseTodoTrigger(input)).toThrow(TodoError);
    expect(() => parseTodoTrigger(input)).toThrow(message);
  });

  it('refuses a card, dispatch or trap lobstah doesn’t know', () => {
    expect(() => resolveTodoTrigger(parseTodoTrigger('card:ab12cd34'))).toThrow('no card decision:ab12cd34');
    expect(() => resolveTodoTrigger(parseTodoTrigger('dispatch:nope done'))).toThrow('no dispatch nope');
    expect(() => resolveTodoTrigger(parseTodoTrigger('trap:no-such free'))).toThrow('no trap named "no-such"');
  });
});

describe('card triggers', () => {
  it('fires answered, naming the trigger and what happened', () => {
    const key = card();
    addTodo(G, 'x', Date.now(), { triggers: any({ kind: 'card', key }) });
    expect(fireDueTodos().fired).toBe(0);
    answer(key);
    expect(fireDueTodos().fired).toBe(1);
    expect(only().firing!.cause).toEqual({ kind: 'event', triggers: [`card:${key} answered`] });
    expect(claimTodoFirings(G)[0]!.firedBy).toBe(`card:${key} answered`);
  });

  it('fires withdrawn when the card goes with no answer', () => {
    const key = card();
    addTodo(G, 'x', Date.now(), { triggers: any({ kind: 'card', key }) });
    withdrawDecision(key);
    expect(fireDueTodos().fired).toBe(1);
    expect(only().firing!.cause).toEqual({ kind: 'event', triggers: [`card:${key} withdrawn`] });
  });

  it('an answer seen before a cull stays answered', () => {
    const key = card();
    addTodo(G, 'x', Date.now(), { triggers: all({ kind: 'card', key }, { kind: 'pr', key: pr(1, { state: 'OPEN' }), on: 'merged' }) });
    answer(key);
    fireDueTodos();
    fs.rmSync(decisionDir(key)!, { recursive: true, force: true });
    pr(1, { state: 'MERGED' });
    fireDueTodos();
    expect(only().firing!.cause).toEqual({ kind: 'event', triggers: [`card:${key} answered`, 'pr:o/r#1 merged'] });
  });
});

describe('dispatch triggers', () => {
  it.each(['done', 'blocked', 'needs-decision', 'failed'] as const)('fires on %s', (verb) => {
    const id = dispatch(`d-${verb}`);
    addTodo(G, 'x', Date.now() - 1000, { triggers: any({ kind: 'dispatch', id, verb }) });
    expect(fireDueTodos().fired).toBe(0);
    appendStatus(id, 'work', verb, 'note');
    expect(fireDueTodos().fired).toBe(1);
    expect(only().firing!.cause).toEqual({ kind: 'event', triggers: [`dispatch:${id} ${verb}`] });
  });

  it('a verb older than the todo doesn’t count, unless it is still the latest at add', () => {
    const id = dispatch('d1');
    appendStatus(id, 'work', 'blocked', 'old');
    appendStatus(id, 'work', 'working', 'resumed');
    addTodo(G, 'old verb', Date.now() + 1000, { triggers: any({ kind: 'dispatch', id, verb: 'blocked' }) });
    expect(fireDueTodos().fired).toBe(0);
    addTodo(G, 'latest verb', Date.now() + 1000, { triggers: any({ kind: 'dispatch', id, verb: 'working' as 'done' }) });
    expect(fireDueTodos().fired).toBe(1);
    expect(listTodos(G).find((t) => t.text === 'latest verb')!.firing).toBeDefined();
  });

  it('fires lost when the dispatch is culled', () => {
    const id = dispatch('d1');
    addTodo(G, 'x', Date.now(), { triggers: any({ kind: 'dispatch', id, verb: 'done' }) });
    fs.rmSync(path.join(laneDirs('work').active, id), { recursive: true, force: true });
    expect(fireDueTodos().fired).toBe(1);
    expect(only().firing!.cause).toEqual({ kind: 'lost', trigger: `dispatch:${id} done` });
    expect(claimTodoFirings(G)[0]!.firedBy).toBe(`gone: dispatch:${id} done`);
  });
});

describe('PR triggers', () => {
  it.each([
    ['MERGED', 'merged'],
    ['CLOSED', 'closed without merging'],
  ])('a merge wait fires once for %s and names the actual outcome', (state, outcome) => {
    const key = pr(1, { state: 'OPEN' });
    addTodo(G, 'finish the PR follow-up', Date.now(), { triggers: any({ kind: 'pr', key, on: 'merged' }) });
    expect(fireDueTodos().fired).toBe(0);
    pr(1, { state });
    expect(fireDueTodos().fired).toBe(1);
    expect(fireDueTodos().fired).toBe(0);
    expect(only().firing!.cause).toEqual({ kind: 'event', triggers: [`${key} ${outcome}`] });
    expect(claimTodoFirings(G)[0]!.firedBy).toBe(`${key} ${outcome}`);
    expect(claimTodoFirings(G)).toEqual([]);
  });

  it('a closed condition still waits specifically for closure without a merge', () => {
    const key = pr(1, { state: 'MERGED' });
    const target = { kind: 'pr' as const, key, on: 'closed' as const };
    expect(readTodoTrigger(target, due(Date.now()))).toEqual({ state: 'waiting' });
    pr(1, { state: 'CLOSED' });
    expect(readTodoTrigger(target, due(Date.now()))).toEqual({ state: 'met', as: 'closed' });
  });

  it.each([
    ['no checks', [], false],
    ['one pending', [passing, pending], false],
    ['one failed', [passing, failing], false],
    ['all passing', [passing], true],
  ])('green with %s: %s', (_name, statusCheckRollup, fires) => {
    const key = pr(1, { state: 'OPEN', statusCheckRollup } as never);
    expect(readTodoTrigger({ kind: 'pr', key, on: 'green' }, due(Date.now())).state).toBe(fires ? 'met' : 'waiting');
  });

  it('green is not met when checks can’t be read', () => {
    const key = pr(1, { state: 'OPEN', statusCheckRollup: [passing] } as never);
    const file = prRecordFile(key);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.checks.unknown = 'no permission';
    fs.writeFileSync(file, JSON.stringify(record));
    expect(readTodoTrigger({ kind: 'pr', key, on: 'green' }, due(Date.now())).state).toBe('waiting');
  });

  it('fires lost when the record is removed', () => {
    const key = pr(1, { state: 'OPEN' });
    addTodo(G, 'x', Date.now(), { triggers: any({ kind: 'pr', key, on: 'merged' }) });
    fs.rmSync(prRecordFile(key));
    expect(fireDueTodos().fired).toBe(1);
    expect(only().firing!.cause).toEqual({ kind: 'lost', trigger: `${key} merged` });
  });
});

describe('trap triggers', () => {
  const trap = () => {
    const worktree = path.join(home, 'checkout');
    fs.mkdirSync(worktree, { recursive: true });
    const signed = signOnTrap({ worktree, cwd: worktree, harness: 'codex', repo: 'r', sessionId: 's', ttlMs: 60_000, name: 'calm-reef' });
    if (!('ok' in signed)) throw new Error('unexpected hold');
    return signed.ok;
  };
  const target = (trapId: string): TodoTriggerTarget => ({ kind: 'trap', trapId, name: 'calm-reef' });

  it('resolves a name to its trap', () => {
    const { trapId } = trap();
    expect(resolveTodoTrigger(parseTodoTrigger('trap:calm-reef free'))).toEqual(target(trapId));
  });

  it('free when signed on with nothing to do', () => {
    const { trapId } = trap();
    expect(readTodoTrigger(target(trapId), due(Date.now()))).toEqual({ state: 'met', as: 'free' });
  });

  it('not free with queued work addressed to it', () => {
    const { trapId } = trap();
    enqueue({ id: 'queued', repo: 'r', for: `wt:${trapId}`, brief: 'b' });
    expect(readTodoTrigger(target(trapId), due(Date.now())).state).toBe('waiting');
  });

  it('stowed is waiting, not free and not lost', () => {
    const { trapId } = trap();
    stowTrap(trapId);
    expect(readTodoTrigger(target(trapId), due(Date.now())).state).toBe('waiting');
  });

  it('forgotten fires lost', () => {
    const { trapId } = trap();
    stowTrap(trapId);
    forgetRoster(trapId);
    addTodo(G, 'x', Date.now(), { triggers: any(target(trapId)) });
    expect(fireDueTodos().fired).toBe(1);
    expect(only().firing!.cause).toEqual({ kind: 'lost', trigger: 'trap:calm-reef free' });
  });
});

describe('any and all', () => {
  it('any fires on the first, naming it; the unmet one keeps listening after a snooze', () => {
    const a = pr(1, { state: 'OPEN' });
    const b = pr(2, { state: 'OPEN' });
    addTodo(G, 'x', Date.now(), { triggers: any({ kind: 'pr', key: a, on: 'merged' }, { kind: 'pr', key: b, on: 'merged' }) });
    pr(1, { state: 'MERGED' });
    expect(fireDueTodos().fired).toBe(1);
    expect(only().firing!.cause).toEqual({ kind: 'event', triggers: [`${a} merged`] });

    snoozeTodo(G, 1, due(later() + HOUR));
    expect(fireDueTodos().fired).toBe(0);
    expect(only().firing).toBeUndefined();
    expect(only().triggers!.items[0]!.metAs).toBe('merged');

    pr(2, { state: 'MERGED' });
    expect(fireDueTodos().fired).toBe(1);
    expect(only().firing!.cause).toEqual({ kind: 'event', triggers: [`${b} merged`] });
  });

  it('all stays quiet with a trigger unmet, then fires naming all of them', () => {
    const a = pr(1, { state: 'OPEN' });
    const b = pr(2, { state: 'OPEN' });
    addTodo(G, 'x', Date.now(), { triggers: all({ kind: 'pr', key: a, on: 'merged' }, { kind: 'pr', key: b, on: 'merged' }) });
    pr(1, { state: 'MERGED' });
    expect(fireDueTodos().fired).toBe(0);
    expect(only().firing).toBeUndefined();
    expect(only().triggers!.items[0]!.metAt).toBeDefined();

    pr(2, { state: 'MERGED' });
    expect(fireDueTodos().fired).toBe(1);
    expect(only().firing!.cause).toEqual({ kind: 'event', triggers: [`${a} merged`, `${b} merged`] });
  });

  it('a latched all-trigger stays met when its record goes false', () => {
    const a = pr(1, { state: 'OPEN', statusCheckRollup: [passing] } as never);
    const b = pr(2, { state: 'OPEN' });
    addTodo(G, 'x', Date.now(), { triggers: all({ kind: 'pr', key: a, on: 'green' }, { kind: 'pr', key: b, on: 'merged' }) });
    fireDueTodos();
    pr(1, { state: 'OPEN', statusCheckRollup: [failing] } as never);
    pr(2, { state: 'MERGED' });
    expect(fireDueTodos().fired).toBe(1);
  });

  it('a lost trigger in all mode fires rather than waiting forever', () => {
    const a = pr(1, { state: 'OPEN' });
    const b = pr(2, { state: 'OPEN' });
    addTodo(G, 'x', Date.now(), { triggers: all({ kind: 'pr', key: a, on: 'merged' }, { kind: 'pr', key: b, on: 'merged' }) });
    fs.rmSync(prRecordFile(a));
    expect(fireDueTodos().fired).toBe(1);
    expect(only().firing!.cause).toEqual({ kind: 'lost', trigger: `${a} merged` });
  });

  it('a lost trigger doesn’t fire again after a snooze', () => {
    const a = pr(1, { state: 'OPEN' });
    addTodo(G, 'x', Date.now(), { triggers: any({ kind: 'pr', key: a, on: 'merged' }) });
    fs.rmSync(prRecordFile(a));
    fireDueTodos();
    snoozeTodo(G, 1, due(later()));
    expect(fireDueTodos().fired).toBe(0);
  });

  it('a condition already true fires on the first check', () => {
    addTodo(G, 'x', Date.now(), { triggers: any({ kind: 'pr', key: pr(1, { state: 'MERGED' }), on: 'merged' }) });
    expect(fireDueTodos().fired).toBe(1);
  });
});

describe('the deadline backstop', () => {
  it('fires with cause time when the due passes with triggers unmet', () => {
    const key = pr(1, { state: 'OPEN' });
    const dueAt = due(Date.now() + HOUR);
    addTodo(G, 'x', Date.now(), { dueAt, triggers: all({ kind: 'pr', key, on: 'merged' }) });
    expect(fireDueTodos().fired).toBe(0);
    expect(fireDueTodos(Date.now() + 2 * HOUR).fired).toBe(1);
    expect(only().firing!.cause).toEqual({ kind: 'time', dueAt });
  });

  it('a trigger met first fires the event, and the time adds no second firing', () => {
    const key = pr(1, { state: 'MERGED' });
    addTodo(G, 'x', Date.now(), { dueAt: due(Date.now() + HOUR), triggers: any({ kind: 'pr', key, on: 'merged' }) });
    fireDueTodos();
    const first = only().firing;
    expect(first!.cause.kind).toBe('event');
    expect(fireDueTodos(Date.now() + 2 * HOUR).fired).toBe(0);
    expect(only().firing).toEqual(first);
  });
});

describe('showing and aging', () => {
  it('names what it waits on, with met ones marked', () => {
    expect(todoWaitingOn({ mode: 'any', items: [{ kind: 'pr', key: 'pr:o/r#1', on: 'merged' }, { kind: 'trap', trapId: 't', name: 'calm-reef', metAt: due(0), metAs: 'free' }] })).toBe('pr:o/r#1 merged · ✓ trap:calm-reef free (any)');
  });

  it('a todo waiting only on a trigger goes stale by age; a snooze quiets it', () => {
    const key = pr(1, { state: 'OPEN' });
    addTodo(G, 'x', Date.now() - 10 * 24 * HOUR, { triggers: any({ kind: 'pr', key, on: 'merged' }) });
    expect(staleTodos(listTodos(G), 3).map((t) => t.id)).toEqual([1]);
    snoozeTodo(G, 1, due(later()));
    expect(staleTodos(listTodos(G), 3)).toEqual([]);
    expect(fireDueTodos().fired).toBe(0);
    expect(only().triggers!.items[0]!.metAt).toBeUndefined();
  });
});

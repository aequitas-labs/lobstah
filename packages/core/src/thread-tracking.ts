import * as fs from 'node:fs';
import { decisionDir, readDecision, readDecisionAnswer, readArchivedDecision } from './decisions.js';
import { readRecordArchive } from './record-archive.js';
import { parsePrRef } from './pr.js';
import { readPr } from './prs.js';
import { storedDescriptor } from './queue.js';
import { briefTitle } from './reports.js';
import { readStatusLog } from './status.js';
import { listTodos, staleTodos, todoOverdue } from './todos.js';
import { laneOf } from './worktrees.js';
import { loadConfig } from './config.js';
import { storageGrounds } from './grounds-name.js';
import type { HelmThread, ThreadTrackedItem } from './thread-model.js';

/**
 * The live state of the work a thread links to: its dispatches, cards, PRs and todos.
 * Each read is one local record, as todo triggers read them: no GitHub calls, no watches.
 */

/** Verbs that hand a dispatch back to a person. */
const STALLED_VERBS = new Set(['failed', 'blocked', 'needs-decision']);

function unavailable(kind: 'dispatch' | 'card' | 'pr', ref: string, keys: string[], text?: string): ThreadTrackedItem {
  const label = kind === 'pr' ? 'PR' : kind === 'card' ? 'Card' : 'Dispatch';
  const title = text && text !== ref && !keys.includes(text) ? text : label;
  return { kind, ref, title, state: 'done', status: keys.some((key) => readRecordArchive(key)) ? 'archived' : 'removed' };
}

function dispatchItem(ref: string, text: string): ThreadTrackedItem {
  const id = ref.replace(/^(work|chore):/, '');
  const lane = laneOf(id);
  const href = `#dispatch/${encodeURIComponent(id)}`;
  if (!lane) return unavailable('dispatch', id, [`work:${id}`, `chore:${id}`], text);
  let title = text === ref || text === id ? 'Dispatch' : text;
  try {
    const brief = storedDescriptor(id, lane)?.brief;
    if (brief) title = briefTitle(brief);
  } catch {
    // The link text stands in for a descriptor that can't be read.
  }
  const verb = readStatusLog(id, lane).at(-1)?.verb;
  const state = verb === 'done' ? 'done' : verb && STALLED_VERBS.has(verb) ? 'stalled' : 'open';
  return { kind: 'dispatch', ref: id, title, state, status: verb ?? 'queued', href };
}

function cardItem(key: string): ThreadTrackedItem {
  const card = readDecision(key) ?? readArchivedDecision(key);
  const href = `#decision/${encodeURIComponent(key)}`;
  if (readDecisionAnswer(key)) return { kind: 'card', ref: key, title: card?.title ?? 'Card', state: 'done', status: 'answered', href };
  const dir = decisionDir(key);
  if (!card) return unavailable('card', key, [key]);
  if (!dir || !fs.existsSync(dir)) return { kind: 'card', ref: key, title: card.title, state: 'done', status: 'withdrawn', href };
  return { kind: 'card', ref: key, title: card.title, state: 'open', status: 'waiting for you', href };
}

/** A merge finishes a PR; closing it without a merge stalls the thread. */
function prItem(ref: string, text: string): ThreadTrackedItem {
  const key = parsePrRef(ref)?.key ?? ref;
  const pr = readPr(key);
  const href = ref.startsWith('https://') ? ref : undefined;
  const title = pr?.title ?? text;
  if (!pr) {
    if (readRecordArchive(key)) return unavailable('pr', key, [key], text);
    return { kind: 'pr', ref: key, title: title === ref || title === key ? 'PR' : title, state: 'open', status: 'removed', ...(href ? { href } : {}) };
  }
  if (pr.state === 'MERGED') return { kind: 'pr', ref: key, title, state: 'done', status: 'merged', ...(href ? { href } : {}) };
  if (pr.state === 'CLOSED') return { kind: 'pr', ref: key, title, state: 'stalled', status: 'closed without merging', ...(href ? { href } : {}) };
  return { kind: 'pr', ref: key, title, state: 'open', status: pr.draft ? 'draft' : pr.checks.failed > 0 ? 'checks failing' : 'open', ...(href ? { href } : {}) };
}

/** Every item the thread links to, in the order it was linked, followed by its todos. */
export function threadTrackedItems(item: HelmThread, opts: { now?: number; todoStaleDays?: number } = {}): ThreadTrackedItem[] {
  const now = opts.now ?? Date.now();
  const seen = new Set<string>();
  const items: ThreadTrackedItem[] = [];
  const add = (key: string, read: () => ThreadTrackedItem) => {
    if (seen.has(key)) return;
    seen.add(key);
    items.push(read());
  };
  for (const round of item.rounds) {
    for (const entry of round.entries) {
      if ('card' in entry) add(`card:${entry.card}`, () => cardItem(entry.card));
      else if ('link' in entry && entry.link === 'dispatched') add(`dispatch:${entry.ref.replace(/^(work|chore):/, '')}`, () => dispatchItem(entry.ref, entry.text));
      else if ('link' in entry && entry.link === 'pr') add(`pr:${parsePrRef(entry.ref)?.key ?? entry.ref}`, () => prItem(entry.ref, entry.text));
    }
  }
  if (item.outcome?.kind === 'dispatched' && item.outcome.ref) {
    const ref = item.outcome.ref;
    add(`dispatch:${ref.replace(/^(work|chore):/, '')}`, () => dispatchItem(ref, item.outcome!.note));
  }
  let todos: ReturnType<typeof listTodos> = [], staleDays = opts.todoStaleDays ?? 3;
  try {
    const config = loadConfig();
    staleDays = opts.todoStaleDays ?? config.helm.todoStaleDays;
    todos = listTodos(storageGrounds(item.grounds, config), { all: true }).filter((todo) => todo.thread === item.id);
  } catch {
    // Without a readable config or todo file, the thread has no todos to track.
  }
  const stale = new Set(staleTodos(todos, staleDays, now).map((todo) => todo.id));
  for (const todo of todos) {
    const title = todo.text.split('\n')[0]!.slice(0, 200);
    if (todo.state !== 'open') items.push({ kind: 'todo', ref: String(todo.id), title, state: 'done', status: todo.state });
    else if (todoOverdue(todo, now)) items.push({ kind: 'todo', ref: String(todo.id), title, state: 'stalled', status: 'overdue' });
    else if (stale.has(todo.id)) items.push({ kind: 'todo', ref: String(todo.id), title, state: 'stalled', status: 'stale' });
    else items.push({ kind: 'todo', ref: String(todo.id), title, state: 'open', status: 'open' });
  }
  return items.map((tracked) => tracked.kind === 'dispatch' && item.supersessions?.some((replacement) => replacement.dispatch === tracked.ref)
    ? { ...tracked, state: 'done', status: 'superseded' }
    : tracked);
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicRenameSync, lobstahHome, uniqueTempPath } from './paths.js';
import { withDirLock } from './dir-lock.js';
import { answerFileType, ANSWER_FILES_MAX, readDecision, readDecisionAnswer, readArchivedDecision } from './decisions.js';
import type { DecisionUpload } from './decisions.js';
import type { Attachment } from './types.js';
import { postNotice } from './notices.js';
import { storedDescriptor } from './queue.js';
import { laneOf } from './worktrees.js';
import { responseState, dispatchThreadTitle, recordThreadResponse, sayInThread, appendThreadEntry, personWords, acknowledgeThreadResponse, pendingThreadNotice, THREAD_PERSON, classifyThread, THREAD_GROUNDS, THREAD_ID, THREAD_IDLE_MS, THREAD_MESSAGES_MAX, ThreadError, threadOutcome, threadWords } from './thread-model.js';
import type { HelmThread, ThreadEntry, ThreadSummary, ThreadView } from './thread-model.js';

export const threadsRoot = () => path.join(lobstahHome(), 'threads');
const groundDir = (grounds: string) => {
  if (!THREAD_GROUNDS.test(grounds)) throw new ThreadError('Choose a valid grounds');
  return path.join(threadsRoot(), grounds);
};
const fileOf = (grounds: string, id: string) => {
  if (!THREAD_ID.test(id)) throw new ThreadError('Conversation not found', 404);
  return path.join(groundDir(grounds), `${id}.json`);
};
function save(item: HelmThread): void {
  const file = fileOf(item.grounds, item.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, JSON.stringify(item));
  atomicRenameSync(tmp, file);
}
export function listThreads(grounds?: string): HelmThread[] {
  let groundsList: string[];
  try { groundsList = grounds === undefined ? fs.readdirSync(threadsRoot()).filter((g) => THREAD_GROUNDS.test(g)) : [grounds]; }
  catch { return []; }
  return groundsList.flatMap((g) => {
    let files: string[];
    try { files = fs.readdirSync(groundDir(g)); } catch { return []; }
    return files.filter((name) => name.endsWith('.json') && THREAD_ID.test(name.slice(0, -5))).flatMap((name) => {
      try {
        const item = JSON.parse(fs.readFileSync(path.join(groundDir(g), name), 'utf8')) as HelmThread;
        return item.grounds === g && `${item.id}.json` === name ? [item] : [];
      } catch { return []; }
    });
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
export function readThread(id: string, grounds?: string): HelmThread | undefined {
  if (!THREAD_ID.test(id)) return undefined;
  if (grounds === undefined) return listThreads().find((item) => item.id === id);
  try {
    const item = JSON.parse(fs.readFileSync(fileOf(grounds, id), 'utf8')) as HelmThread;
    return item.id === id && item.grounds === grounds ? item : undefined;
  } catch { return undefined; }
}
function update(id: string, change: (item: HelmThread) => HelmThread): HelmThread {
  const found = readThread(id);
  if (!found) throw new ThreadError('Conversation not found', 404);
  return withDirLock(`${fileOf(found.grounds, id)}.lock`, () => {
    const item = readThread(id, found.grounds);
    if (!item) throw new ThreadError('Conversation not found', 404);
    const next = change(item);
    save(next);
    return next;
  }, { staleMs: 30_000, waitMs: 2000, busy: () => new ThreadError('This conversation is busy, try again', 409) });
}
function open(item: HelmThread): void {
  if (item.state !== 'open') throw new ThreadError('Reopen this conversation before adding to it', 409);
}
const nextAt = (item: HelmThread, now: Date) => new Date(Math.max(now.getTime(), Date.parse(item.updatedAt) + 1)).toISOString();
function message(text: unknown, files: readonly DecisionUpload[]): string {
  if ((text === undefined || text === '') && files.length) return '';
  return threadWords(text);
}
function uploads(id: string, grounds: string, files: readonly DecisionUpload[], maxBytes: number): Attachment[] {
  if (files.length > ANSWER_FILES_MAX) throw new ThreadError(`Attach at most ${ANSWER_FILES_MAX} files`, 413);
  const checked = files.map((file) => {
    const name = path.basename(file.name);
    if (!name || name === '.' || name === '..' || name !== file.name || path.win32.basename(name) !== name) throw new ThreadError('Choose a file with a valid name');
    if (file.data.length > maxBytes) throw new ThreadError('The attachment is too large', 413);
    return { ...file, type: answerFileType(name, file.data) };
  });
  const dir = path.join(groundDir(grounds), id);
  if (checked.length) fs.mkdirSync(dir, { recursive: true });
  return checked.map((file) => {
    const ext = path.extname(file.name), base = file.name.slice(0, -ext.length || undefined);
    let name = file.name, n = 2;
    while (fs.existsSync(path.join(dir, name))) name = `${base}-${n++}${ext}`;
    const destination = path.join(dir, name);
    fs.writeFileSync(destination, file.data, { flag: 'wx' });
    return { name, path: destination, bytes: file.data.length, type: file.type };
  });
}
function aboutTitle(about: string | undefined): string | undefined {
  if (!about) return undefined;
  const id = about.replace(/^(work|chore):/, ''), lane = laneOf(id);
  try { return lane ? dispatchThreadTitle(storedDescriptor(id, lane)?.brief) : undefined; }
  catch { return undefined; }
}
export function startThread(input: { grounds: string; text: unknown; uploads?: DecisionUpload[]; maxBytes?: number; about?: string; via?: 'glass' | 'chat'; title?: string; now?: Date }): HelmThread {
  const text = message(input.text, input.uploads ?? []), id = randomUUID(), at = (input.now ?? new Date()).toISOString();
  groundDir(input.grounds);
  if (input.about !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(input.about)) throw new ThreadError('Choose a valid dispatch');
  const title = input.title ? threadWords(input.title, 'a title', 200) : (aboutTitle(input.about) ?? (text.split('\n')[0] || input.uploads?.[0]?.name || 'Attachment').slice(0, 200));
  const attachments = uploads(id, input.grounds, input.uploads ?? [], input.maxBytes ?? 10 * 1024 * 1024);
  const item: HelmThread = { id, grounds: input.grounds, title, text, attachments,
    kind: input.via === 'chat' ? 'thread' : 'untriaged', state: 'open', notes: { decided: [], open: [] },
    rounds: [{ at, entries: [{ by: 'person', via: input.via ?? 'glass', text, attachments, at }] }],
    createdAt: at, updatedAt: at, lastPersonAt: at, ...(input.about ? { about: input.about } : {}) };
  save(item);
  if (input.via !== 'chat') remindThreads(input.grounds, 900_000, Date.parse(at));
  return item;
}
export function postThread(id: string, input: { text: unknown; uploads?: DecisionUpload[]; maxBytes?: number; via?: 'glass' | 'chat'; now?: Date }): HelmThread {
  const text = message(input.text, input.uploads ?? []);
  const item = update(id, (item) => {
    open(item);
    const at = nextAt(item, input.now ?? new Date());
    if (item.rounds.length >= THREAD_MESSAGES_MAX) throw new ThreadError('This conversation needs a report or plan before more messages', 409);
    const attachments = uploads(id, item.grounds, input.uploads ?? [], input.maxBytes ?? 10 * 1024 * 1024);
    return { ...item, rounds: [...item.rounds, { at, entries: [{ by: 'person', via: input.via ?? 'glass', text, attachments, at }] }], updatedAt: at, lastPersonAt: at, notifiedAt: undefined };
  });
  if (input.via !== 'chat') remindThreads(item.grounds, 900_000, Date.parse(item.lastPersonAt));
  return item;
}
/** The helm's own words in the conversation, after whatever the person said last. */
export function sayThread(id: string, input: { text: unknown; uploads?: DecisionUpload[]; maxBytes?: number; now?: Date }): HelmThread {
  const text = message(input.text, input.uploads ?? []);
  return update(id, (item) => {
    open(item);
    const at = nextAt(item, input.now ?? new Date());
    sayInThread(item, text, [], at); // refuse a full round before writing any file
    return sayInThread(item, text, uploads(id, item.grounds, input.uploads ?? [], input.maxBytes ?? 10 * 1024 * 1024), at);
  });
}
export const triageThread = (id: string, kind: unknown, now = new Date()) => update(id, (item) => { const at = nextAt(item, now); return recordThreadResponse(classifyThread(item, kind, at), at, kind === 'thread' ? 'Discussion started' : 'Bait received'); });
export function noteThread(id: string, notes: { decided?: string[]; open?: string[]; link?: string; text?: string }, now = new Date()): HelmThread {
  return update(id, (item) => {
    open(item);
    const at = nextAt(item, now);
    const lines = (list: string[]) => {
      if (list.length > 50) throw new ThreadError('Keep notes to 50 lines');
      return list.filter((s) => s.trim()).map((s) => threadWords(s, 'a note', 2000));
    };
    let entry: ThreadEntry | undefined;
    if (notes.link) {
      const split = notes.link.indexOf(':'), kind = notes.link.slice(0, split), ref = notes.link.slice(split + 1);
      if (!['dispatched', 'report', 'planned'].includes(kind) || !ref || ref.length > 1000 || (kind === 'planned' && !ref.startsWith('https://'))) throw new ThreadError('Choose a dispatch, report or HTTPS plan link');
      entry = { link: kind as 'dispatched' | 'report' | 'planned', ref, text: threadWords(notes.text ?? ref, 'a link note', 1000), at };
    }
    const noted = notes.decided !== undefined || notes.open !== undefined;
    const { rounds } = entry ? appendThreadEntry(item, entry) : item;
    return recordThreadResponse({ ...item, rounds, ...(noted ? { notesAt: at } : {}), notes: { decided: notes.decided === undefined ? item.notes.decided : lines(notes.decided), open: notes.open === undefined ? item.notes.open : lines(notes.open) }, updatedAt: at, lastHelmAt: at }, at, entry && 'text' in entry ? entry.text : 'Notes updated');
  });
}
export function linkThreadCard(id: string, key: string, now = new Date()): HelmThread {
  return update(id, (item) => {
    open(item);
    if (item.rounds.some((round) => round.entries.some((entry) => 'card' in entry && entry.card === key))) return item;
    const { rounds } = appendThreadEntry(item, { card: key });
    const at = nextAt(item, now);
    return recordThreadResponse({ ...item, rounds, updatedAt: at, lastHelmAt: at }, at, 'A card is ready for you');
  });
}
export function resolveThread(id: string, outcome: unknown, note: unknown, now = new Date()): HelmThread {
  return update(id, (item) => {
    const at = nextAt(item, now), result = threadOutcome(outcome, note, at);
    return recordThreadResponse({ ...item, state: 'resolved', outcome: result, updatedAt: at, lastHelmAt: at }, at, result.note);
  });
}
export function reopenThread(id: string, now = new Date()): HelmThread {
  const item = update(id, (item) => {
    const at = nextAt(item, now);
    return { ...item, state: 'open', outcome: undefined, updatedAt: at, lastPersonAt: at, lastHelmAt: undefined, notifiedAt: undefined };
  });
  remindThreads(item.grounds, 900_000, now.getTime());
  return item;
}
export function threadView(item: HelmThread, person = THREAD_PERSON): ThreadView {
  const keys = [...new Set(item.rounds.flatMap((round) => round.entries.flatMap((entry) => 'card' in entry ? [entry.card] : [])))];
  return { ...item, ...responseState(item, person), cards: keys.flatMap((key) => {
    const card = readDecision(key) ?? readArchivedDecision(key);
    if (!card) return [];
    const answer = readDecisionAnswer(key);
    return [{ key, title: card.title, options: card.options, ...(answer ? { answer: { option: answer.option, text: answer.text, attachments: answer.attachments, answeredAt: answer.answeredAt } } : {}), standing: !!readDecision(key) && !answer }];
  }) };
}
function newestPersonAt(item: HelmThread): string {
  return threadView(item).cards.reduce((at, card) => card.answer && card.answer.answeredAt > at ? card.answer.answeredAt : at, item.lastPersonAt);
}
export function threadSummaries(grounds?: string, now = Date.now()): ThreadSummary[] {
  return listThreads(grounds).filter((item) => item.state === 'open' || responseState(item).unreadResponse || now - Date.parse(item.updatedAt) < 86400_000).map((item) => ({
    ...responseState(item), id: item.id, grounds: item.grounds, kind: item.kind, title: item.title, state: item.state, updatedAt: item.updatedAt,
    roundCount: item.rounds.length, ...(item.about ? { about: item.about } : {}), ...(item.notes.open[0] ? { openLine: item.notes.open[0] } : {}),
    cards: threadView(item).cards.filter((card) => card.standing).map((card) => card.key),
    waitingForHelm: item.state === 'open' && (!item.lastHelmAt || newestPersonAt(item) > item.lastHelmAt), ...(item.outcome ? { outcome: item.outcome } : {}) }));
}
export function remindThreads(grounds?: string, remindMs = 900_000, now = Date.now()): void {
  for (const item of listThreads(grounds)) {
    const personAt = newestPersonAt(item);
    if (item.state !== 'open' || (item.lastHelmAt && personAt <= item.lastHelmAt)) continue;
    if (item.notifiedAt && now - Date.parse(item.notifiedAt) < remindMs) continue;
    update(item.id, (latest) => {
      if (latest.notifiedAt && now - Date.parse(latest.notifiedAt) < remindMs) return latest;
      postNotice({ kind: 'thread', refId: item.id, grounds: item.grounds, text: `${item.title}: ${personWords(item.rounds.at(-1))}`, dedupeKey: `thread-${item.id}-${item.lastPersonAt}-${Math.floor(now / Math.max(1, remindMs))}` });
      return { ...latest, notifiedAt: new Date(now).toISOString() };
    });
  }
}
export function expireIdleThreads(grounds?: string, now = Date.now()): void {
  for (const item of listThreads(grounds)) {
    if (item.state === 'open' && item.kind === 'thread' && now - Date.parse(newestPersonAt(item)) >= THREAD_IDLE_MS && !threadView(item).cards.some((card) => card.standing)) resolveThread(item.id, 'dropped', 'No new message for seven days', new Date(now));
  }
}
export function resolveThreadFile(id: string, name: string): string | undefined {
  if (path.basename(name) !== name || path.win32.basename(name) !== name || name === '.' || name === '..') return undefined;
  const item = readThread(id);
  const attachment = item?.rounds.flatMap((round) => round.entries.flatMap((entry) => 'attachments' in entry ? entry.attachments : [])).find((file) => file.name === name);
  if (!attachment || !item) return undefined;
  const file = path.join(groundDir(item.grounds), id, name);
  try { return attachment.path === file && fs.lstatSync(file).isFile() ? file : undefined; }
  catch { return undefined; }
}

/** A through cursor never acknowledges a response newer than the one displayed. */
export function markThreadResponsesSeen(id: string, through: unknown, person = THREAD_PERSON): HelmThread {
  return update(id, item => acknowledgeThreadResponse(item, person, through));
}
export function dismissThreadNotice(id: string, through: unknown, person = THREAD_PERSON): HelmThread {
  return update(id, item => acknowledgeThreadResponse(item, person, through, true));
}
export function threadSubscriberNotices(person = THREAD_PERSON) {
  return listThreads().flatMap(item => pendingThreadNotice(item, person) ?? []);
}

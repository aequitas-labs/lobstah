import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicRenameSync, lobstahHome, uniqueTempPath } from './paths.js';
import { withDirLock } from './dir-lock.js';
import { answerFileType, ANSWER_FILES_MAX, readDecision, readDecisionAnswer, readArchivedDecision, setDecisionThread } from './decisions.js';
import type { DecisionUpload } from './decisions.js';
import type { Attachment } from './types.js';
import { postNotice } from './notices.js';
import { storedDescriptor } from './queue.js';
import { laneOf } from './worktrees.js';
import { THREAD_CARD_READY, THREAD_NOTES_UPDATED, responseState, dispatchThreadTitle, recordThreadResponse, sayInThread, appendThreadEntry, personWords, THREAD_LINK_KINDS, acknowledgeThreadResponse, pendingThreadNotice, THREAD_PERSON, classifyThread, THREAD_GROUNDS, THREAD_ID, THREAD_IDLE_MS, THREAD_MESSAGES_MAX, ThreadError, threadOutcome, threadWords } from './thread-model.js';
import type { HelmThread, ThreadEntry, ThreadLinkKind, ThreadRelay, ThreadSummary, ThreadVia, ThreadView } from './thread-model.js';
import { parsePrRef } from './pr.js';
import { settledState, trackingTransition } from './thread-model.js';
import { threadTrackedItems } from './thread-tracking.js';

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
  if (item.state === 'resolved') throw new ThreadError('Reopen this conversation before adding to it', 409);
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
/**
 * Start a conversation. `id` is the glass's submission id: the page opens the
 * conversation under it before the helm's files are written. A second start
 * under an id that exists is refused.
 */
export function startThread(input: { grounds: string; text: unknown; uploads?: DecisionUpload[]; maxBytes?: number; about?: string; via?: ThreadVia; title?: string; relay?: ThreadRelay; now?: Date; id?: string }): HelmThread {
  const text = message(input.text, input.uploads ?? []), id = input.id ?? randomUUID(), at = (input.now ?? new Date()).toISOString();
  groundDir(input.grounds);
  if (input.id !== undefined && (!THREAD_ID.test(input.id) || readThread(input.id))) throw new ThreadError('This conversation already exists', 409);
  if (input.about !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(input.about)) throw new ThreadError('Choose a valid dispatch');
  const title = input.title ? threadWords(input.title, 'a title', 200) : (aboutTitle(input.about) ?? (text.split('\n')[0] || input.uploads?.[0]?.name || 'Attachment').slice(0, 200));
  const attachments = uploads(id, input.grounds, input.uploads ?? [], input.maxBytes ?? 10 * 1024 * 1024);
  const item: HelmThread = { id, grounds: input.grounds, title, text, attachments,
    kind: input.via === 'chat' ? 'thread' : 'untriaged', state: 'open', notes: { decided: [], open: [] },
    rounds: [{ at, entries: [{ by: 'person', via: input.via ?? 'glass', text, attachments, at, ...(input.id ? { submission: input.id } : {}) }] }],
    createdAt: at, updatedAt: at, lastPersonAt: at, ...(input.about ? { about: input.about } : {}), ...(input.relay ? { relay: input.relay } : {}) };
  save(item);
  if (input.via !== 'chat') remindThreads(input.grounds, 900_000, Date.parse(at));
  return item;
}
/**
 * Add the person's message. With `submission` (the glass's submission id), a
 * message that conversation already holds is not added again.
 */
export function postThread(id: string, input: { text: unknown; uploads?: DecisionUpload[]; maxBytes?: number; via?: ThreadVia; source?: string; now?: Date; submission?: string }): HelmThread {
  const text = message(input.text, input.uploads ?? []);
  const item = update(id, (item) => {
    if (input.submission && threadHoldsSubmission(item, input.submission)) return item;
    open(item);
    const at = nextAt(item, input.now ?? new Date());
    if (item.rounds.length >= THREAD_MESSAGES_MAX) throw new ThreadError('This conversation needs a report or plan before more messages', 409);
    const attachments = uploads(id, item.grounds, input.uploads ?? [], input.maxBytes ?? 10 * 1024 * 1024);
    const relay = item.relay && input.source ? { relay: { ...item.relay, sources: [...item.relay.sources, input.source].slice(-THREAD_MESSAGES_MAX) } } : {};
    const entry: ThreadEntry = { by: 'person', via: input.via ?? 'glass', text, attachments, at, ...(input.submission ? { submission: input.submission } : {}) };
    return { ...item, ...relay, state: 'open', rounds: [...item.rounds, { at, entries: [entry] }], updatedAt: at, lastPersonAt: at, notifiedAt: undefined };
  });
  if (input.via !== 'chat') remindThreads(item.grounds, 900_000, Date.parse(item.lastPersonAt));
  return item;
}
/** Whether a message from this glass submission is already in the conversation. */
export function threadHoldsSubmission(item: HelmThread, submission: string): boolean {
  return item.rounds.some((round) => round.entries.some((entry) => 'by' in entry && entry.by === 'person' && entry.submission === submission));
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
/**
 * Triage, notes and resolving update a glass thread quietly. A thread relayed
 * from Slack still records them as responses: the mirror sends each new
 * response back to the Slack thread, and the person there sees nothing else.
 */
const relayResponse = (item: HelmThread, at: string, text: string): HelmThread => item.relay ? recordThreadResponse(item, at, text) : item;
export const triageThread = (id: string, kind: unknown, now = new Date()) => update(id, (item) => { const at = nextAt(item, now); return relayResponse(classifyThread(item, kind, at), at, kind === 'thread' ? 'Discussion started' : 'Bait received'); });
/**
 * A `kind:ref` link as the entry it adds: `dispatched:`, `report:`, `planned:`
 * or `pr:` adds a link entry; `decision:<key>` adds an existing card. The card
 * must exist and belong to no other conversation.
 */
function threadLinkEntry(link: string, text: string | undefined, at: string, thread: string): ThreadEntry {
  const split = link.indexOf(':'), kind = link.slice(0, split), ref = link.slice(split + 1);
  if (kind === 'decision') {
    const key = ref.startsWith('decision:') ? ref : `decision:${ref}`;
    const card = readDecision(key) ?? readArchivedDecision(key);
    if (!card) throw new ThreadError(`No card ${key}`, 404);
    if (card.thread !== undefined && card.thread !== thread) throw new ThreadError(`${key} already belongs to another conversation`, 409);
    return { card: key };
  }
  if (!THREAD_LINK_KINDS.includes(kind as ThreadLinkKind) || !ref || ref.length > 1000 || (kind === 'planned' && !ref.startsWith('https://')) || (kind === 'pr' && !parsePrRef(ref))) throw new ThreadError('Choose a dispatch, report, card, PR or HTTPS plan link');
  return { link: kind as ThreadLinkKind, ref, text: threadWords(text ?? ref, 'a link note', 1000), at };
}
const hasCard = (item: HelmThread, key: string) => item.rounds.some((round) => round.entries.some((entry) => 'card' in entry && entry.card === key));
/** Add link entries; a card already in the conversation is not added twice. */
function addLinks(item: HelmThread, entries: readonly ThreadEntry[]): HelmThread {
  return entries.reduce((next, entry) => ('card' in entry && hasCard(next, entry.card) ? next : appendThreadEntry(next, entry)), item);
}
/** Record the conversation on each card a link added, so its modal shows the notes and a replacement stays here. */
function claimCards(id: string, entries: readonly ThreadEntry[]): void {
  for (const entry of entries) if ('card' in entry) setDecisionThread(entry.card, id);
}
export function noteThread(id: string, notes: { decided?: string[]; open?: string[]; link?: string; text?: string }, now = new Date()): HelmThread {
  let added: ThreadEntry[] = [];
  const item = update(id, (item) => {
    open(item);
    const at = nextAt(item, now);
    const lines = (list: string[]) => {
      if (list.length > 50) throw new ThreadError('Keep notes to 50 lines');
      return list.filter((s) => s.trim()).map((s) => threadWords(s, 'a note', 2000));
    };
    added = notes.link ? [threadLinkEntry(notes.link, notes.text, at, id)] : [];
    const entry = added[0];
    const newCard = !!entry && 'card' in entry && !hasCard(item, entry.card);
    const noted = notes.decided !== undefined || notes.open !== undefined;
    const { rounds } = addLinks(item, added);
    const said = newCard ? THREAD_CARD_READY : entry && 'text' in entry ? entry.text : THREAD_NOTES_UPDATED;
    const next: HelmThread = { ...item, rounds, ...(noted ? { notesAt: at } : {}), notes: { decided: notes.decided === undefined ? item.notes.decided : lines(notes.decided), open: notes.open === undefined ? item.notes.open : lines(notes.open) }, updatedAt: at, lastHelmAt: at };
    // A new card is a reply the person reads, as man ask --thread records it; other links update the thread quietly.
    return newCard ? recordThreadResponse(next, at, said) : relayResponse(next, at, said);
  });
  claimCards(id, added);
  return item;
}
/**
 * A conversation the helm opens to collect a discussion that spans cards,
 * dispatches or chat sessions. Its `detail` is the helm's first message, such
 * as a summary of the chat so far; without one, the title is the response.
 * It is unread for the person until shown, and nothing waits on the helm.
 */
export function startHelmThread(input: { grounds: string; title: unknown; detail?: unknown; links?: readonly string[]; now?: Date }): HelmThread {
  groundDir(input.grounds);
  const id = randomUUID(), at = (input.now ?? new Date()).toISOString();
  const title = threadWords(input.title, 'a title', 200);
  const detail = input.detail === undefined ? undefined : threadWords(input.detail, 'a summary');
  const links = (input.links ?? []).map((link) => threadLinkEntry(link, undefined, at, id));
  const opened: HelmThread = { id, grounds: input.grounds, title, text: detail ?? '', attachments: [], kind: 'thread', state: 'open', startedBy: 'helm',
    notes: { decided: [], open: [] }, rounds: [{ at, entries: [] }], createdAt: at, updatedAt: at, lastPersonAt: at, lastHelmAt: at };
  const said = detail !== undefined ? sayInThread(opened, detail, [], at) : recordThreadResponse(opened, at, title);
  const item = addLinks(said, links);
  save(item);
  claimCards(id, links);
  return item;
}
/** Link a dispatch to a conversation, named for its brief. Quiet: the person reads the dispatch's own state. */
export function linkThreadDispatch(id: string, dispatch: string, brief: string | undefined, now = new Date()): HelmThread {
  return noteThread(id, { link: `dispatched:${dispatch}`, text: dispatchThreadTitle(brief) ?? dispatch }, now);
}
/** Refuse a link before the work it names starts: the conversation must be open or tracking, on these grounds. */
export function checkThreadForLink(id: string, grounds: string): HelmThread {
  const item = readThread(id);
  if (!item) throw new ThreadError('Conversation not found', 404);
  if (item.grounds !== grounds) throw new ThreadError('This conversation belongs to another grounds', 409);
  open(item);
  return item;
}
export function linkThreadCard(id: string, key: string, now = new Date()): HelmThread {
  return update(id, (item) => {
    open(item);
    if (hasCard(item, key)) return item;
    const { rounds } = appendThreadEntry(item, { card: key });
    const at = nextAt(item, now);
    return recordThreadResponse({ ...item, rounds, updatedAt: at, lastHelmAt: at }, at, THREAD_CARD_READY);
  });
}
/** Resolving keeps the thread tracking while any work it links to is unfinished. */
export function resolveThread(id: string, outcome: unknown, note: unknown, now = new Date()): HelmThread {
  return update(id, (item) => {
    const at = nextAt(item, now), result = threadOutcome(outcome, note, at);
    const settled = { ...item, outcome: result, updatedAt: at, lastHelmAt: at };
    return relayResponse({ ...settled, state: settledState(threadTrackedItems(settled, { now: now.getTime() })) }, at, result.note);
  });
}
/** Tracking threads close when their work finishes and return to the person when it stalls. Only the helm wait runs this. */
export function trackThreads(grounds?: string, now = Date.now()): HelmThread[] {
  const changed: HelmThread[] = [];
  for (const item of listThreads(grounds)) {
    if (item.state !== 'tracking') continue;
    const next = update(item.id, (latest) => trackingTransition(latest, threadTrackedItems(latest, { now }), nextAt(latest, new Date(now))) ?? latest);
    if (next.state !== 'tracking') changed.push(next);
  }
  return changed;
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
  return { ...item, ...responseState(item, person), tracked: threadTrackedItems(item), cards: threadCards(item) };
}
function threadCards(item: HelmThread): ThreadView['cards'] {
  const keys = [...new Set(item.rounds.flatMap((round) => round.entries.flatMap((entry) => 'card' in entry ? [entry.card] : [])))];
  return keys.flatMap((key) => {
    const card = readDecision(key) ?? readArchivedDecision(key);
    if (!card) return [];
    const answer = readDecisionAnswer(key);
    return [{ key, title: card.title, options: card.options, ...(answer ? { answer: { option: answer.option, text: answer.text, attachments: answer.attachments, answeredAt: answer.answeredAt } } : {}), standing: !!readDecision(key) && !answer }];
  });
}
function newestPersonAt(item: HelmThread): string {
  return threadCards(item).reduce((at, card) => card.answer && card.answer.answeredAt > at ? card.answer.answeredAt : at, item.lastPersonAt);
}
export function threadSummaries(grounds?: string, now = Date.now()): ThreadSummary[] {
  return listThreads(grounds).filter((item) => item.state !== 'resolved' || responseState(item).unreadResponse || now - Date.parse(item.updatedAt) < 86400_000).map((item) => ({
    ...responseState(item), id: item.id, grounds: item.grounds, kind: item.kind, title: item.title, state: item.state, updatedAt: item.updatedAt,
    roundCount: item.rounds.length, ...(item.about ? { about: item.about } : {}), ...(item.notes.open[0] ? { openLine: item.notes.open[0] } : {}),
    cards: threadCards(item).filter((card) => card.standing).map((card) => card.key),
    waitingForHelm: item.state === 'open' && (!item.lastHelmAt || newestPersonAt(item) > item.lastHelmAt), ...(item.outcome ? { outcome: item.outcome } : {}), ...(item.startedBy ? { startedBy: item.startedBy } : {}) }));
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
    if (item.state === 'open' && item.kind === 'thread' && now - Date.parse(newestPersonAt(item)) >= THREAD_IDLE_MS && !threadCards(item).some((card) => card.standing)) resolveThread(item.id, 'dropped', 'No new message for seven days', new Date(now));
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

/** The conversation a wharf's Slack request opened on this boat, if any. */
export function relayedThread(wharf: string, request: string): HelmThread | undefined {
  return listThreads().find((item) => item.relay?.wharf === wharf && item.relay.request === request);
}
/** Record what the wharf has heard of a relayed conversation. It changes nothing a person or the helm sees. */
export function markThreadRelay(id: string, change: Pick<ThreadRelay, 'told' | 'sentSeq'>): HelmThread {
  return update(id, (item) => (item.relay ? { ...item, relay: { ...item.relay, ...change } } : item));
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

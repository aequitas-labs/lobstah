import type { HelmThread, ThreadSummary, ThreadView } from '../../../packages/core/src/thread-model.js';
import { responseState, recordThreadResponse, acknowledgeThreadResponse, pendingThreadNotice, classifyThread, THREAD_ID, THREAD_IDLE_MS, THREAD_MESSAGES_MAX, ThreadError, threadOutcome, threadWords } from '../../../packages/core/src/thread-model.js';
import { messageFileType } from '../../../packages/core/src/message-files.js';
import type { ThreadAttachment as Attachment } from '../../../packages/core/src/thread-model.js';
import type { WharfDocument } from '../../../packages/core/src/backend-model.js';
import type { Actor, Command } from './account.js';
import { ApiError, identifier, object, requireThat } from './protocol.js';
export const threadSchema = 'CREATE TABLE IF NOT EXISTS helm_threads (id TEXT PRIMARY KEY, data TEXT NOT NULL);';
type Hooks = { person: () => string; remindMs: () => number; helm: (c: Command, a: Actor, now: number) => void; event: (kind: string, dispatch?: string, note?: string) => void };
export class Threads {
  constructor(private sql: SqlStorage, private hooks: Hooks) {}
  read(id: string): HelmThread | undefined {
    const row = this.sql.exec<{data: string}>('SELECT data FROM helm_threads WHERE id=?', id).toArray()[0];
    return row ? JSON.parse(row.data) : undefined;
  }
  private list(): HelmThread[] { return this.sql.exec<{data: string}>("SELECT data FROM helm_threads WHERE json_extract(data,'$.state')='open' OR json_extract(data,'$.updatedAt')>? OR coalesce(json_extract(data,'$.responseSeq'),0)>coalesce(json_extract(data,?),0) ORDER BY json_extract(data,'$.updatedAt') DESC,rowid DESC", new Date(Date.now() - 86400_000).toISOString(), `$.readers.${JSON.stringify(this.hooks.person())}.seenThrough`).toArray().map(r => JSON.parse(r.data)); }
  private put(item: HelmThread): HelmThread { this.sql.exec('INSERT OR REPLACE INTO helm_threads VALUES (?,?)', item.id, JSON.stringify(item)); return item; }
  private need(id: unknown): HelmThread { requireThat(typeof id === 'string' && THREAD_ID.test(id), 404, 'Conversation not found'); const item = this.read(id); requireThat(item, 404, 'Conversation not found'); return item; }
  private open(item: HelmThread) { requireThat(item.state === 'open', 409, 'Reopen this conversation before adding to it'); }
  private at(item: HelmThread, now: number) { return new Date(Math.max(now, Date.parse(item.updatedAt) + 1)).toISOString(); }
  private person(actor: Actor) { requireThat(actor.kind === 'person', 403, 'Signed-in person required'); }
  private files(id: string, values: unknown, item?: HelmThread): Attachment[] {
    requireThat(Array.isArray(values) && values.length <= 8 && new Set(values).size === values.length, 400, 'Choose up to eight different files');
    const used = new Set(item?.rounds.flatMap(r => r.entries.flatMap(e => 'attachments' in e ? e.attachments.map(a => a.name) : [])) ?? []);
    return values.map(value => {
      const file = this.sql.exec<{id: string; name: string; size: number}>('SELECT id,name,size FROM files WHERE id=? AND dispatch=? AND ready=1', identifier(value), `thread:${id}`).toArray()[0];
      requireThat(file, 400, 'File does not belong to this conversation');
      const type = messageFileType(file.name); requireThat(type, 415, 'Choose an accepted file type');
      let name = file.name, n = 2;
      const ext = /\.[^.]+$/.exec(name)?.[0] ?? '', stem = ext ? name.slice(0, -ext.length) : name;
      while (used.has(name)) name = `${stem}-${n++}${ext}`;
      used.add(name);
      return { name, path: file.id, bytes: file.size, type };
    });
  }
  view(item: HelmThread): ThreadView {
    const keys = [...new Set(item.rounds.flatMap(r => r.entries.flatMap(e => 'card' in e ? [e.card] : [])))];
    const cards = keys.flatMap(key => {
      const row = this.sql.exec<{data: string}>('SELECT data FROM documents WHERE id=?', key).toArray()[0];
      if (!row) return [];
      const d = JSON.parse(row.data) as WharfDocument;
      return [{ key, title: d.title, options: d.options ?? [], standing: d.published && !d.withdrawn && !d.answer, ...(d.answer ? { answer: { option: d.answer.option, text: d.answer.text, attachments: [], answeredAt: d.answer.at } } : {}) }];
    });
    return { ...item, ...responseState(item, this.hooks.person()), cards };
  }
  private personAt(item: HelmThread): string { return this.view(item).cards.reduce((at, c) => c.answer && c.answer.answeredAt > at ? c.answer.answeredAt : at, item.lastPersonAt); }
  summaries(now: number): ThreadSummary[] {
    return this.list().filter(t => t.state === 'open' || responseState(t, this.hooks.person()).unreadResponse || now - Date.parse(t.updatedAt) < 86400_000).map(t => ({ ...responseState(t, this.hooks.person()), id: t.id, grounds: t.grounds, title: t.title, kind: t.kind, state: t.state, updatedAt: t.updatedAt, roundCount: t.rounds.length,
      cards: this.view(t).cards.filter(c => c.standing).map(c => c.key), waitingForHelm: t.state === 'open' && (!t.lastHelmAt || this.personAt(t) > t.lastHelmAt), ...(t.notes.open[0] ? { openLine: t.notes.open[0] } : {}), ...(t.outcome ? { outcome: t.outcome } : {}) }));
  }
  checkCard(id: unknown, grounds?: string): HelmThread {
    const item = this.need(id); this.open(item); requireThat(!grounds || grounds === item.grounds, 400, 'Choose a conversation on these grounds'); return item;
  }
  linkCard(id: string, key: string, now: number) {
    const item = this.checkCard(id), at = this.at(item, now);
    item.rounds.at(-1)!.entries.push({ card: key });
    this.put(recordThreadResponse({ ...item, updatedAt: at, lastHelmAt: at }, at, 'A card is ready for you'));
  }
  /** Called only by the alarm; reads never perform maintenance. */
  maintain(now: number) {
    for (const item of this.list()) {
      if (item.state !== 'open') continue;
      const at = this.at(item, now), personAt = this.personAt(item);
      if (item.kind === 'thread' && now - Date.parse(personAt) >= THREAD_IDLE_MS && !this.view(item).cards.some(c => c.standing)) {
        this.put(recordThreadResponse({ ...item, state: 'resolved', outcome: threadOutcome('dropped', 'No new message for seven days', at), updatedAt: at, lastHelmAt: at }, at, 'No new message for seven days'));
        this.hooks.event('thread-updated', undefined, item.id);
      } else if ((!item.lastHelmAt || personAt > item.lastHelmAt) && (!item.notifiedAt || now - Date.parse(item.notifiedAt) >= this.hooks.remindMs())) this.notify(item, now);
    }
  }
  nextDue(now: number): number | undefined {
    const times = this.list().filter(t => t.state === 'open').flatMap(t => {
      const result: number[] = [], personAt = this.personAt(t);
      if (!t.lastHelmAt || personAt > t.lastHelmAt) result.push(t.notifiedAt ? Date.parse(t.notifiedAt) + this.hooks.remindMs() : now);
      if (t.kind === 'thread' && !this.view(t).cards.some(c => c.standing)) result.push(Date.parse(personAt) + THREAD_IDLE_MS);
      return result;
    });
    return times.length ? Math.max(now, Math.min(...times)) : undefined;
  }
  private notify(item: HelmThread, now: number) {
    this.hooks.event('thread', undefined, item.id);
    this.put({ ...item, notifiedAt: new Date(now).toISOString() });
  }
  event(id: string) { const item = this.read(id); return item ? { id, grounds: item.grounds, kind: item.kind, title: item.title, text: item.rounds.at(-1)?.entries.flatMap(e => 'text' in e ? [e.text] : []).join(' ') ?? '' } : undefined; }
  uploadScope(c: Command, actor: Actor): string {
    this.person(actor); const id = c.path.split('/')[1]!;
    requireThat(THREAD_ID.test(id), 400, 'Choose a conversation'); const item = this.read(id); if (item) this.open(item);
    return `thread:${id}`;
  }
  execute(c: Command, actor: Actor, now: number): {status: number; value: unknown} | undefined {
    if (c.path.split('/')[0] !== 'threads') return;
    try { return this.action(c, actor, now); }
    catch (e) { if (e instanceof ThreadError) throw new ApiError(e.status, e.message); throw e; }
  }
  private action(c: Command, actor: Actor, now: number): {status: number; value: unknown} | undefined {
    const parts = c.path.split('/'), b = c.method === 'GET' ? {} : object(c.body);
    const ok = (value: unknown, status = 200) => ({ status, value });
    if (c.path === 'threads/notices' && c.method === 'GET') return ok(this.list().flatMap(item => pendingThreadNotice(item, this.hooks.person()) ?? []));
    if (c.path === 'threads' && c.method === 'GET') return ok(this.summaries(now));
    if (c.path === 'threads' && c.method === 'POST') {
      if (b.via === 'chat') this.hooks.helm(c, actor, now); else this.person(actor);
      const id = b.id === undefined ? crypto.randomUUID() : String(b.id); requireThat(THREAD_ID.test(id) && !this.read(id), 409, 'Choose a new conversation');
      const attachments = this.files(id, b.files ?? []), words = (b.text === undefined || b.text === '') && attachments.length ? '' : threadWords(b.text);
      const at = new Date(now).toISOString(), grounds = identifier(b.grounds ?? 'home');
      const item: HelmThread = { id, grounds, kind: b.via === 'chat' ? 'thread' : 'untriaged', title: b.title === undefined ? (words.split('\n')[0] || attachments[0]!.name).slice(0, 200) : threadWords(b.title, 'a title', 200), text: words, attachments,
        state: 'open', notes: { decided: [], open: [] }, rounds: [{ at, entries: [{ by: 'person', via: b.via === 'chat' ? 'chat' : 'glass', text: words, attachments }] }], createdAt: at, updatedAt: at, lastPersonAt: at,
        ...(b.about === undefined ? {} : { about: identifier(b.about) }) };
      this.put(item); if (b.via !== 'chat') this.notify(item, now); return ok(this.view(item), 201);
    }
    const item = this.need(parts[1]), at = this.at(item, now);
    requireThat(b.grounds === undefined || b.grounds === item.grounds, 400, 'Choose a conversation on these grounds');
    if (parts.length === 2 && c.method === 'GET') return ok(this.view(item));
    if (parts[2] === 'files' && parts[3] && c.method === 'GET') {
      const file = item.rounds.flatMap(r => r.entries.flatMap(e => 'attachments' in e ? e.attachments : [])).find(a => a.path === parts[3]);
      requireThat(file, 404, 'Attachment not found'); return ok({ id: file.path, type: file.type });
    }
    requireThat(c.method === 'POST' && parts.length === 3, 404, 'Conversation action not found');
    if (parts[2] === 'seen' || parts[2] === 'dismiss-notice') {
      this.person(actor); this.put(acknowledgeThreadResponse(item, actor.id, b.through, parts[2] === 'dismiss-notice'));
    } else if (parts[2] === 'post') {
      this.open(item); if (b.via === 'chat') this.hooks.helm(c, actor, now); else this.person(actor);
      requireThat(item.rounds.length < THREAD_MESSAGES_MAX, 409, 'This conversation needs a report or plan before more messages');
      const attachments = this.files(item.id, b.files ?? [], item), words = (b.text === undefined || b.text === '') && attachments.length ? '' : threadWords(b.text);
      item.rounds.push({ at, entries: [{ by: 'person', via: b.via === 'chat' ? 'chat' : 'glass', text: words, attachments }] });
      this.put({ ...item, updatedAt: at, lastPersonAt: at, notifiedAt: undefined });
      if (b.via !== 'chat') this.notify(this.read(item.id)!, now);
    } else if (parts[2] === 'reopen') {
      this.person(actor); this.put({ ...item, state: 'open', outcome: undefined, updatedAt: at, lastPersonAt: at, lastHelmAt: undefined, notifiedAt: undefined }); this.notify(this.read(item.id)!, now);
    } else {
      this.hooks.helm(c, actor, now);
      if (parts[2] === 'triage') this.put(recordThreadResponse(classifyThread(item, b.kind, at), at, b.kind === 'thread' ? 'Discussion started' : 'Bait received'));
      else if (parts[2] === 'resolve') this.put(recordThreadResponse({ ...item, state: 'resolved', outcome: threadOutcome(b.outcome, b.note, at), updatedAt: at, lastHelmAt: at }, at, threadWords(b.note, 'an outcome note', 1000)));
      else if (parts[2] === 'note') {
        this.open(item);
        const lines = (value: unknown, old: string[]) => { if (value === undefined) return old; requireThat(Array.isArray(value) && value.length <= 50, 400, 'Keep notes to 50 lines'); return value.filter(v => v !== '').map(v => threadWords(v, 'a note', 2000)); };
        const notes = { decided: lines(b.decided, item.notes.decided), open: lines(b.open, item.notes.open) };
        if (b.link !== undefined) {
          const value = threadWords(b.link, 'a link', 1000), split = value.indexOf(':'), link = value.slice(0, split), ref = value.slice(split + 1);
          requireThat(['dispatched','report','planned'].includes(link) && ref && (link !== 'planned' || ref.startsWith('https://')), 400, 'Choose a dispatch, report or HTTPS plan link');
          item.rounds.at(-1)!.entries.push({ link: link as 'dispatched'|'report'|'planned', ref, text: threadWords(b.text ?? ref, 'a link note', 1000) });
        }
        this.put(recordThreadResponse({ ...item, notes, updatedAt: at, lastHelmAt: at }, at, b.link ? threadWords(b.text ?? b.link, 'a link note', 1000) : 'Notes updated'));
      } else throw new ApiError(404, 'Conversation action not found');
    }
    if (!['post', 'reopen', 'seen', 'dismiss-notice'].includes(parts[2]!)) this.hooks.event('thread-updated', undefined, item.id);
    return ok(this.view(this.read(item.id)!), parts[2] === 'post' ? 201 : 200);
  }
}

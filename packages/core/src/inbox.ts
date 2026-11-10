import { withDirLock } from './dir-lock.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Attachment, Lane } from './types.js';
import { uniqueTempPath, atomicRenameSync, laneDirs, readDirIfPresent } from './paths.js';
import { postNotice } from './notices.js';
import { readRoster } from './roster.js';
import { listSignedOff, readTrap, releaseSignedOff, trapRepoLabel } from './soak.js';
import { trapNameForId } from './trap-names.js';

export interface InboxMessage {
  file: string;
  text: string;
}

/** The shared NNN.meta.json sidecar: sender, timestamp, and optional attachments. */
export interface MessageMeta {
  from: string;
  at: string;
  attachments?: Attachment[];
  /** Stable internal delivery receipt, retained after the message is handled. */
  deliveryId?: string;
  /** The permission card (`decision:<id>`) this message answers. It never answers the dispatch's question. */
  permissionCard?: string;
}

const metaName = (file: string): string => file.replace(/\.msg$/, '.meta.json');

function inboxDir(id: string, lane: Lane): string {
  return path.join(laneDirs(lane).inbox, id);
}

/** Queue a message. The sidecar lands before its sequenced message. */
export function sendMessage(id: string, lane: Lane, text: string, from?: string, attachments: Attachment[] = []): string {
  return withInboxWrite(id, lane, () => appendMessage(id, lane, text, from, attachments));
}

function withInboxWrite<T>(id: string, lane: Lane, action: () => T): T {
  const directory = inboxDir(id, lane);
  fs.mkdirSync(directory, { recursive: true });
  return withDirLock(path.join(directory, '.write-lock'), action, { staleMs: 30_000, waitMs: 1000, busy: () => new Error(`inbox ${id} is busy; retry`) });
}

/**
 * Tell a dispatch how its permission card was answered. The message is
 * marked with the card, so it does not answer the dispatch's question:
 * the trap's question stands until it is answered on its own card.
 */
export function sendPermissionAnswer(id: string, lane: Lane, text: string, card: string): string {
  return withInboxWrite(id, lane, () => appendMessage(id, lane, text, 'glass', [], undefined, card));
}

/** Publish one visible result across retries, including a crash after delivery but before its outbox receipt. */
export function sendMessageOnce(id: string, lane: Lane, deliveryId: string, text: string, from: string, attachments: Attachment[] = []): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(deliveryId)) throw new Error('invalid inbox delivery id');
  return withInboxWrite(id, lane, () => {
    const directory = inboxDir(id, lane);
    for (const folder of [directory, path.join(directory, 'handled')]) for (const file of readDirIfPresent(folder).filter((name) => name.endsWith('.msg'))) {
      const metadata = readMessageMeta(id, lane, file, folder !== directory);
      if (metadata?.deliveryId === deliveryId) return file;
    }
    return appendMessage(id, lane, text, from, attachments, deliveryId);
  });
}

function appendMessage(id: string, lane: Lane, text: string, from?: string, attachments: Attachment[] = [], deliveryId?: string, permissionCard?: string): string {
  const dir = inboxDir(id, lane);
  fs.mkdirSync(path.join(dir, 'handled'), { recursive: true });
  const existing = fs.readdirSync(dir).filter((f) => f.endsWith('.msg')).length;
  const handled = fs.readdirSync(path.join(dir, 'handled')).filter((f) => f.endsWith('.msg')).length;
  const name = `${String(existing + handled + 1).padStart(3, '0')}.msg`;
  const tmp = uniqueTempPath(path.join(dir, name));
  if (from !== undefined || attachments.length > 0) {
    const meta: MessageMeta = {
      ...(deliveryId ? { deliveryId } : {}),
      from: from ?? 'unknown',
      at: new Date().toISOString(),
      ...(attachments.length ? { attachments } : {}),
      ...(permissionCard ? { permissionCard } : {}),
    };
    const metaTmp = `${tmp}.meta`;
    fs.writeFileSync(metaTmp, JSON.stringify(meta, null, 2));
    atomicRenameSync(metaTmp, path.join(dir, metaName(name)));
  }
  fs.writeFileSync(tmp, text);
  atomicRenameSync(tmp, path.join(dir, name));
  return name;
}

export function readMessageMeta(id: string, lane: Lane, file: string, handled = false): MessageMeta | undefined {
  const dir = path.join(inboxDir(id, lane), ...(handled ? ['handled'] : []));
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, metaName(file)), 'utf8')) as MessageMeta;
  } catch {
    return undefined;
  }
}

/** Every message sidecar for a dispatch, pending and handled. */
export function messageMetas(id: string, lane: Lane): MessageMeta[] {
  const dir = inboxDir(id, lane);
  const out: MessageMeta[] = [];
  for (const d of [dir, path.join(dir, 'handled')]) {
    let files: string[];
    try {
      files = fs.readdirSync(d).filter((f) => f.endsWith('.meta.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) as Partial<MessageMeta>;
        if (typeof m.from === 'string' && m.from !== '' && typeof m.at === 'string')
          out.push({ from: m.from, at: m.at, ...(typeof m.permissionCard === 'string' ? { permissionCard: m.permissionCard } : {}) });
      } catch {
        // unreadable sidecar: no provenance, never counts
      }
    }
  }
  return out;
}

/** Which messages `answeredAt` counts. */
export interface AnsweredAtOptions {
  /** Count answers to permission cards too: for a status entry that is itself a permission request. */
  permissionAnswers?: boolean;
}

/**
 * When a question standing since `since` (its status entry's at) was
 * answered: the newest message with provenance sent after it, else
 * undefined. Any sender counts — every inbound message to a dispatch is an
 * instruction from someone acting for the human; a record without a
 * sidecar never does. A permission card's answer counts only with
 * `permissionAnswers`: it answers that card, not the trap's question.
 * Uses the sidecar's at, never file mtime.
 */
export function answeredAt(id: string, lane: Lane, since: string, options: AnsweredAtOptions = {}): string | undefined {
  const t = Date.parse(since) || 0;
  return messageMetas(id, lane)
    .filter((m) => (Date.parse(m.at) || 0) > t && (options.permissionAnswers || m.permissionCard === undefined))
    .map((m) => m.at)
    .sort()
    .at(-1);
}

export function unhandled(id: string, lane: Lane): InboxMessage[] {
  const dir = inboxDir(id, lane);
  return readDirIfPresent(dir)
    .filter((f) => f.endsWith('.msg'))
    .sort()
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

/** Acknowledge by rename into handled/ — a side effect that cannot be faked. */
export function acknowledge(id: string, lane: Lane, file: string): void {
  const dir = inboxDir(id, lane);
  fs.mkdirSync(path.join(dir, 'handled'), { recursive: true });
  fs.renameSync(path.join(dir, file), path.join(dir, 'handled', file));
  try {
    fs.renameSync(path.join(dir, metaName(file)), path.join(dir, 'handled', metaName(file)));
  } catch {
    // Legacy messages have no sidecar.
  }
}

/**
 * Trap messages: conversational continuations for the session manning a
 * worktree — no catch lifecycle, no branch, no report obligation. Each
 * message carries provenance so the receiver can tell steering (from the
 * helm) from information (anyone else). Stored under the work-lane inbox
 * keyed by the trap id, same files, same validated write path.
 */
export interface TrapMessage {
  file: string;
  from: string;
  at: string;
  text: string;
  attachments?: Attachment[];
}

const trapKey = (trapId: string): string => `trap-${trapId}`;

export function sendTrapMessage(trapId: string, from: string, text: string, attachments: Attachment[] = []): string {
  return sendMessage(trapKey(trapId), 'work', JSON.stringify({ from, at: new Date().toISOString(), text }), from, attachments);
}

export function unhandledTrapMessages(trapId: string): TrapMessage[] {
  return unhandled(trapKey(trapId), 'work').flatMap((m) => {
    try {
      const parsed = JSON.parse(m.text) as { from?: string; at?: string; text?: string };
      return [{ file: m.file, from: parsed.from ?? 'unknown', at: parsed.at ?? '', text: parsed.text ?? '', attachments: readMessageMeta(trapKey(trapId), 'work', m.file)?.attachments }];
    } catch {
      return [{ file: m.file, from: 'unknown', at: '', text: m.text }];
    }
  });
}

export function acknowledgeTrapMessage(trapId: string, file: string): void {
  acknowledge(trapKey(trapId), 'work', file);
}

/**
 * Bounce undelivered messages to the helm as notices — used when a trap is
 * stowed or ghost-swept with unread mail. Never delivered to whoever holds
 * the address next, never silently dropped.
 */
export function bounceTrapMessages(trapId: string): number {
  const msgs = unhandledTrapMessages(trapId);
  for (const m of msgs) {
    postNotice({
      kind: 'message-bounced',
      text: `message to ${trapRepoLabel({ trapId, name: trapNameForId(trapId), repo: readRoster(trapId)?.repo })} never delivered (from ${m.from}): ${m.text}`,
      refId: trapId,
    });
    acknowledgeTrapMessage(trapId, m.file);
  }
  return msgs.length;
}

/**
 * The end of each signed-off trap's grace: a trap that has not re-soaked
 * within `graceMs` of signing off gets its held messages bounced to the helm.
 * A trap that re-soaked only has its hold released. Returns the trap ids
 * whose messages bounced.
 */
export function bounceExpiredSignOffs(graceMs: number, now = Date.now()): string[] {
  const out: string[] = [];
  for (const s of listSignedOff()) {
    if (readTrap(s.trapId)) {
      releaseSignedOff(s.trapId);
      continue;
    }
    if (now - (Date.parse(s.at) || 0) < graceMs) continue;
    if (bounceTrapMessages(s.trapId) > 0) out.push(s.trapId);
    releaseSignedOff(s.trapId);
  }
  return out;
}

/** The text of every message a dispatch was sent, pending and handled. */
export function messageTexts(id: string, lane: Lane): string[] {
  const dir = inboxDir(id, lane);
  const texts: string[] = [];
  for (const d of [dir, path.join(dir, 'handled')]) {
    let files: string[];
    try {
      files = fs.readdirSync(d).filter((f) => f.endsWith('.msg'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        texts.push(fs.readFileSync(path.join(d, f), 'utf8'));
      } catch {
        // gone meanwhile
      }
    }
  }
  return texts;
}

/**
 * The text of every message a trap was sent directly (`lobstah send <trap>`),
 * pending and handled; with `sinceMs`, only those sent at or after it.
 */
export function trapMessageTexts(trapId: string, sinceMs = 0): string[] {
  return messageTexts(trapKey(trapId), 'work').flatMap((raw) => {
    try {
      const m = JSON.parse(raw) as { text?: string; at?: string };
      return (Date.parse(m.at ?? '') || 0) >= sinceMs ? [m.text ?? ''] : [];
    } catch {
      return sinceMs > 0 ? [] : [raw];
    }
  });
}

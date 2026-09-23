import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Attachment, Lane } from './types.js';
import { laneDirs } from './paths.js';
import { postNotice } from './notices.js';

export interface InboxMessage {
  file: string;
  text: string;
}

/** The shared NNN.meta.json sidecar: sender, timestamp, and optional attachments. */
export interface MessageMeta {
  from: string;
  at: string;
  attachments?: Attachment[];
}

const metaName = (file: string): string => file.replace(/\.msg$/, '.meta.json');

function inboxDir(id: string, lane: Lane): string {
  return path.join(laneDirs(lane).inbox, id);
}

/** Queue a message. The sidecar lands before its sequenced message. */
export function sendMessage(id: string, lane: Lane, text: string, from?: string, attachments: Attachment[] = []): string {
  const dir = inboxDir(id, lane);
  fs.mkdirSync(path.join(dir, 'handled'), { recursive: true });
  const existing = fs.readdirSync(dir).filter((f) => f.endsWith('.msg')).length;
  const handled = fs.readdirSync(path.join(dir, 'handled')).filter((f) => f.endsWith('.msg')).length;
  const name = `${String(existing + handled + 1).padStart(3, '0')}.msg`;
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}`);
  if (from !== undefined || attachments.length > 0) {
    const meta: MessageMeta = { from: from ?? 'unknown', at: new Date().toISOString(), ...(attachments.length ? { attachments } : {}) };
    const metaTmp = `${tmp}.meta`;
    fs.writeFileSync(metaTmp, JSON.stringify(meta, null, 2));
    fs.renameSync(metaTmp, path.join(dir, metaName(name)));
  }
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, path.join(dir, name));
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
        if (typeof m.from === 'string' && m.from !== '' && typeof m.at === 'string') out.push({ from: m.from, at: m.at });
      } catch {
        // unreadable sidecar: no provenance, never counts
      }
    }
  }
  return out;
}

/**
 * When a question standing since `since` (its status entry's at) was
 * answered: the newest message with provenance sent after it, else
 * undefined. Any sender counts — every inbound message to a dispatch is an
 * instruction from someone acting for the human; a record without a
 * sidecar never does. Uses the sidecar's at, never file mtime.
 */
export function answeredAt(id: string, lane: Lane, since: string): string | undefined {
  const t = Date.parse(since) || 0;
  return messageMetas(id, lane)
    .filter((m) => (Date.parse(m.at) || 0) > t)
    .map((m) => m.at)
    .sort()
    .at(-1);
}

export function unhandled(id: string, lane: Lane): InboxMessage[] {
  const dir = inboxDir(id, lane);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
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
      text: `message to wt:${trapId} never delivered (from ${m.from}): ${m.text}`,
      refId: trapId,
    });
    acknowledgeTrapMessage(trapId, m.file);
  }
  return msgs.length;
}

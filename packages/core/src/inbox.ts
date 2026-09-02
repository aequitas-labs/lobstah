import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Lane } from './types.js';
import { laneDirs } from './paths.js';

export interface InboxMessage {
  file: string;
  text: string;
}

function inboxDir(id: string, lane: Lane): string {
  return path.join(laneDirs(lane).inbox, id);
}

/** Queue a message. Sequenced records written by atomic rename. */
export function sendMessage(id: string, lane: Lane, text: string): string {
  const dir = inboxDir(id, lane);
  fs.mkdirSync(path.join(dir, 'handled'), { recursive: true });
  const existing = fs.readdirSync(dir).filter((f) => f.endsWith('.msg')).length;
  const handled = fs.readdirSync(path.join(dir, 'handled')).length;
  const name = `${String(existing + handled + 1).padStart(3, '0')}.msg`;
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, path.join(dir, name));
  return name;
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
}

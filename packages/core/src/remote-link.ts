import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A Claude Remote Control URL as Claude emits it. It's a locator: opening it
 * still needs the owner's Claude sign-in. lobstah never builds one from a
 * local session id, because the remote id can differ.
 */
export function validRemoteLink(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && /^https:\/\/claude\.ai\/code\/[A-Za-z0-9_-]+(?:\?[A-Za-z0-9_=&%.-]*)?$/.test(value);
}

const STATUS = '"bridge_status"';
const CHUNK = 1 << 20;

/** How far each transcript has been read, so a poll reads only what's new. */
const scans = new Map<string, { offset: number; link?: string; at?: number }>();

/** A session's transcript: under the directory it started in, wherever that is. */
export function claudeTranscriptFile(sessionId: string, cwds: string[], home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')): string | undefined {
  const projects = path.join(home, 'projects');
  const file = `${sessionId}.jsonl`;
  for (const cwd of cwds) {
    const p = path.join(projects, cwd.replace(/[^A-Za-z0-9-]/g, '-'), file);
    if (fs.existsSync(p)) return p;
  }
  try {
    for (const dir of fs.readdirSync(projects)) {
      const p = path.join(projects, dir, file);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    // No Claude home: no transcript.
  }
  return undefined;
}

/**
 * The newest Remote Control URL Claude wrote to this transcript at or after
 * `since`. A resumed session's transcript holds URLs from earlier runs, which
 * may no longer connect, so a run only accepts its own.
 */
export function transcriptRemoteLink(file: string, since: number): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const size = fs.fstatSync(fd).size;
    let scan = scans.get(file);
    if (!scan || size < scan.offset) scans.set(file, (scan = { offset: 0 }));
    const buffer = Buffer.allocUnsafe(CHUNK);
    let rest = Buffer.alloc(0);
    let position = scan.offset;
    while (position < size) {
      const read = fs.readSync(fd, buffer, 0, Math.min(CHUNK, size - position), position);
      if (read === 0) break;
      position += read;
      const data = Buffer.concat([rest, buffer.subarray(0, read)]);
      // A line still being written waits for the next poll.
      const end = data.lastIndexOf(10);
      if (end < 0) {
        rest = data;
        continue;
      }
      rest = data.subarray(end + 1);
      for (const line of data.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.includes(STATUS)) continue;
        try {
          const entry = JSON.parse(line) as { type?: unknown; subtype?: unknown; url?: unknown; timestamp?: unknown };
          const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
          if (entry.type === 'system' && entry.subtype === 'bridge_status' && validRemoteLink(entry.url) && Number.isFinite(at) && at >= (scan.at ?? 0)) {
            scan.link = entry.url;
            scan.at = at;
          }
        } catch {
          // Not a whole JSON line: skip it.
        }
      }
    }
    scan.offset = position - rest.length;
    return scan.at !== undefined && scan.at >= since ? scan.link : undefined;
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

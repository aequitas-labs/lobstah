import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Descriptor, Lane } from './types.js';
import { laneDirs } from './paths.js';

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function enqueue(d: Descriptor, lane: Lane = 'work'): void {
  if (!d.id || !d.repo || !d.brief) {
    throw new Error('descriptor requires id, repo, and brief');
  }
  atomicWrite(path.join(laneDirs(lane).queue, `${d.id}.json`), JSON.stringify(d, null, 2));
}

export function pendingIds(lane: Lane): string[] {
  const dir = laneDirs(lane).queue;
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => a.m - b.m)
    .map(({ f }) => f.slice(0, -'.json'.length));
}

/**
 * Claim the oldest pending descriptor by atomic rename. The mkdir is the
 * lock (EEXIST loses), the rename is the claim (missing source loses).
 * Returns the claimed id, or null when the queue is empty or every
 * candidate was claimed by someone else first.
 */
export function claimNext(lane: Lane): string | null {
  const dirs = laneDirs(lane);
  for (const id of pendingIds(lane)) {
    const activeDir = path.join(dirs.active, id);
    try {
      fs.mkdirSync(activeDir);
    } catch {
      continue;
    }
    try {
      fs.renameSync(path.join(dirs.queue, `${id}.json`), path.join(activeDir, 'descriptor.json'));
      return id;
    } catch {
      fs.rmdirSync(activeDir, { recursive: true });
      continue;
    }
  }
  return null;
}

export function readDescriptor(id: string, lane: Lane): Descriptor {
  const file = path.join(laneDirs(lane).active, id, 'descriptor.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Descriptor;
}

export function activeIds(lane: Lane): string[] {
  return fs.readdirSync(laneDirs(lane).active).filter((f) => !f.startsWith('.'));
}

export function complete(id: string, lane: Lane): void {
  const dirs = laneDirs(lane);
  fs.renameSync(path.join(dirs.active, id), path.join(dirs.done, id));
}

export function requestCancel(id: string, lane: Lane): void {
  fs.writeFileSync(path.join(laneDirs(lane).active, id, 'cancel'), new Date().toISOString());
}

export function cancelRequested(id: string, lane: Lane): boolean {
  return fs.existsSync(path.join(laneDirs(lane).active, id, 'cancel'));
}

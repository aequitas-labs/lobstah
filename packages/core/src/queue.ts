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

/** The still-queued descriptor, or undefined if it was claimed meanwhile. */
export function queuedDescriptor(id: string, lane: Lane): Descriptor | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(laneDirs(lane).queue, `${id}.json`), 'utf8')) as Descriptor;
  } catch {
    return undefined;
  }
}

/**
 * Claim the oldest pending descriptor by atomic rename. The mkdir is the
 * lock (EEXIST loses), the rename is the claim (missing source loses).
 * Returns the claimed id, or null when the queue is empty or every
 * candidate was claimed by someone else first. `skip` filters candidates
 * by descriptor — the read races the claim, so a skipped candidate may
 * already be gone by the next scan, which is fine: skipping is advisory,
 * the rename is the truth.
 */
export function claimNext(lane: Lane, skip?: (d: Descriptor) => boolean): string | null {
  const dirs = laneDirs(lane);
  for (const id of pendingIds(lane)) {
    if (skip) {
      const d = queuedDescriptor(id, lane);
      if (!d || skip(d)) continue;
    }
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

/**
 * Return an active descriptor to the queue — the inverse of a claim, for
 * bait whose claimant vanished. State files (status, events, evidence) stay
 * put; the next claimant continues the same record.
 */
export function requeue(id: string, lane: Lane): void {
  const dirs = laneDirs(lane);
  const activeDir = path.join(dirs.active, id);
  fs.renameSync(path.join(activeDir, 'descriptor.json'), path.join(dirs.queue, `${id}.json`));
  fs.rmSync(activeDir, { recursive: true, force: true });
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

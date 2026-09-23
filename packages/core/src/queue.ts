import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Descriptor, Lane } from './types.js';
import { laneDirs } from './paths.js';
import { appendStatus } from './status.js';

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function enqueue(d: Descriptor, lane: Lane = 'work'): void {
  if (!d.id || !d.repo || !d.brief) {
    throw new Error('descriptor requires id, repo, and brief');
  }
  // Every descriptor-producing path (CLI, node, pickup, watch continuation)
  // inherits origin references unless it already chose an attachment list.
  const inherited = d.followUp && d.attachments === undefined
    ? storedDescriptor(d.followUp, 'work')?.attachments ?? storedDescriptor(d.followUp, 'chore')?.attachments
    : undefined;
  const descriptor = inherited?.length ? { ...d, attachments: inherited } : d;
  atomicWrite(path.join(laneDirs(lane).queue, `${d.id}.json`), JSON.stringify(descriptor, null, 2));
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

/** The descriptor of an origin dispatch, whichever bucket currently owns it. */
export function storedDescriptor(id: string, lane: Lane): Descriptor | undefined {
  const dirs = laneDirs(lane);
  for (const file of [
    path.join(dirs.queue, `${id}.json`),
    path.join(dirs.active, id, 'descriptor.json'),
    path.join(dirs.done, id, 'descriptor.json'),
  ]) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as Descriptor;
    } catch {
      // Try the next bucket.
    }
  }
  return undefined;
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

/**
 * Cancel a dispatch nobody has claimed yet: finalize with an audit trail
 * (never a silent delete) — the descriptor moves to done/ and the status
 * log records the cancellation. Returns false when the item is not in the
 * queue (already claimed, or unknown) so the caller can fall through to
 * the active-cancel path; the rename losing the race IS that signal.
 */
export function cancelQueued(id: string, lane: Lane): boolean {
  const dirs = laneDirs(lane);
  const doneDir = path.join(dirs.done, id);
  try {
    fs.mkdirSync(doneDir);
  } catch {
    return false; // finished record already exists — nothing queued to cancel
  }
  try {
    fs.renameSync(path.join(dirs.queue, `${id}.json`), path.join(doneDir, 'descriptor.json'));
  } catch {
    fs.rmdirSync(doneDir, { recursive: true });
    return false; // claimed meanwhile — the claim won
  }
  appendStatus(id, lane, 'failed', 'cancelled before claim');
  return true;
}

export function cancelRequested(id: string, lane: Lane): boolean {
  return fs.existsSync(path.join(laneDirs(lane).active, id, 'cancel'));
}

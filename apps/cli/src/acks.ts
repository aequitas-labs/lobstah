import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { laneDirs, lobstahHome, parsePrRef, readEvidence, readPr, readWatch } from '@lobstah/core';
import type { Lane, PrEvidence } from '@lobstah/core';

/**
 * Attention acks: a human has seen an item. Display-only — an ack hides the
 * item from the desktop pet and the glass lobs, never from `man tend
 * --json`, `man wait`, the park, reminders, or notifyCommand: acknowledging
 * that a human looked must never hide a question from the orchestrator
 * that has to answer it.
 *
 * `~/.lobstah/acks/<item-key>.json` holds { key, kind, stateHash, at, by }.
 * The ack holds only while the item's stateHash is unchanged; a new status
 * entry, head, failed check, or thread count re-stands the item and the
 * stale ack is pruned. The write path is `lobstah attention ack|unack`
 * (plus pruning in `man tend` and `cull`); nothing else writes acks/.
 */

export interface Ack {
  key: string;
  kind: string;
  stateHash: string;
  at: string;
  by: string;
}

export function acksDir(): string {
  return path.join(lobstahHome(), 'acks');
}

export function ackFile(key: string): string {
  return path.join(acksDir(), `${key.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`);
}

export function readAck(key: string): Ack | undefined {
  try {
    const a = JSON.parse(fs.readFileSync(ackFile(key), 'utf8')) as Ack;
    return a.key === key ? a : undefined;
  } catch {
    return undefined;
  }
}

export function listAcks(): Ack[] {
  let files: string[];
  try {
    files = fs.readdirSync(acksDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files.flatMap((f) => {
    try {
      return [JSON.parse(fs.readFileSync(path.join(acksDir(), f), 'utf8')) as Ack];
    } catch {
      return [];
    }
  });
}

export function writeAck(a: Ack): void {
  fs.mkdirSync(acksDir(), { recursive: true });
  const file = ackFile(a.key);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(a, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function removeAck(key: string): boolean {
  const file = ackFile(key);
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  return existed;
}

const sha = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16);

/** stateHash for question / landed: the status entry the item stands on. */
export function statusStateHash(verb: string, at: string | undefined): string {
  return sha({ verb, at: at ?? '' });
}

/**
 * stateHash for a PR's items: the head plus every evidence field a pr:* kind
 * stands on. One PR is one item key, so one ack covers all of that PR's
 * kinds until any of those fields moves. observedAt and lastReviewAt are
 * deliberately out — re-observing an unchanged PR must not re-stand it.
 */
export function prStateHash(pr: PrEvidence): string {
  return sha({
    headSha: pr.headSha,
    state: pr.state,
    draft: pr.draft,
    reviewDecision: pr.reviewDecision,
    mergeStateStatus: pr.mergeStateStatus,
    checks: pr.checks,
    unresolvedThreads: pr.review?.unresolvedThreads,
    changesRequested: pr.review?.changesRequested ?? false,
  });
}

/** The ack an item currently has: only one whose stateHash still matches. */
export function currentAck(key: string, stateHash: string): Ack | undefined {
  const a = readAck(key);
  return a && a.stateHash === stateHash ? a : undefined;
}

/** Remove acks whose stateHash no longer matches a standing item's. Returns the pruned keys. */
export function pruneStaleAcks(standing: Array<{ key: string; stateHash: string }>): string[] {
  const hashes = new Map(standing.map((s) => [s.key, s.stateHash]));
  const pruned: string[] = [];
  for (const a of listAcks()) {
    const h = hashes.get(a.key);
    if (h !== undefined && h !== a.stateHash && removeAck(a.key)) pruned.push(a.key);
  }
  return pruned;
}

/**
 * Whether an ack's item still exists, for cull: the dispatch is still on
 * disk (and not being culled), the PR is still open in some evidence, or
 * the watch is still registered.
 */
export function ackItemExists(key: string, culling: ReadonlySet<string> = new Set()): boolean {
  if (key.startsWith('watch:')) return readWatch(key.slice('watch:'.length)) !== undefined;
  const ref = key.startsWith('pr:') ? parsePrRef(key) : undefined;
  if (ref) {
    // The PR record decides when there is one; evidence only for a PR without.
    const record = readPr(ref.key);
    if (record) return record.state === 'OPEN';
    for (const lane of ['work', 'chore'] as Lane[]) {
      let files: string[];
      try {
        files = fs.readdirSync(laneDirs(lane).state).filter((f) => f.endsWith('.evidence'));
      } catch {
        continue;
      }
      for (const f of files) {
        const id = f.slice(0, -'.evidence'.length);
        if (culling.has(id)) continue;
        const pr = readEvidence(id, lane).pr;
        if (pr && parsePrRef(pr.url)?.key === ref.key && pr.state === 'OPEN') return true;
      }
    }
    return false;
  }
  const m = /^(work|chore):(.+)$/.exec(key);
  if (!m) return false;
  const [, lane, id] = m as unknown as [string, Lane, string];
  if (culling.has(id)) return false;
  const d = laneDirs(lane);
  return (
    fs.existsSync(path.join(d.queue, `${id}.json`)) ||
    fs.existsSync(path.join(d.active, id)) ||
    fs.existsSync(path.join(d.done, id)) ||
    fs.existsSync(path.join(d.state, `${id}.status`))
  );
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { laneDirs, lobstahHome, parsePrRef, prStandingKinds, readEvidence, readPr, readDecision, readDecisionAnswer, readReport, readWatch, statusStateHash } from '@lobstah/core';
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
 * stale ack is pruned. A ready ack survives not-ready flaps on the same head,
 * without hiding other PR kinds. The write path is `lobstah attention ack|unack`
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

/** stateHash for question / landed: the status entry the item stands on (core, so the daemon's hold agrees). */
export { statusStateHash };

/**
 * stateHash for a PR's items: the head plus every evidence field a pr:* kind
 * stands on. One PR is one item key, so one ack covers all of that PR's
 * kinds until any of those fields moves. observedAt and lastReviewAt are
 * deliberately out — re-observing an unchanged PR must not re-stand it.
 *
 * A ready PR hashes only its head SHA: a same-head flap or another passing
 * check does not re-stand it. Other kinds still hash their evidence as before.
 */
export function prStateHash(pr: PrEvidence): string {
  if (prStandingKinds(pr).includes('pr:ready')) return prReadyStateHash(pr.headSha);
  return sha({
    headSha: pr.headSha,
    state: pr.state,
    draft: pr.draft,
    reviewDecision: pr.reviewDecision,
    mergeStateStatus: pr.mergeStateStatus,
    checks: pr.checks,
    unresolvedThreads: pr.review?.unresolvedThreads,
    changesRequested: pr.review?.changesRequested ?? false,
    repair: pr.repair ? { headSha: pr.repair.headSha, kind: pr.repair.kind, status: pr.repair.status, reason: pr.repair.reason } : undefined,
  });
}

const prReadyStateHash = (headSha: string) => sha({ 'pr:ready': headSha });

/** The ack an item currently has: only one whose stateHash still matches. */
export function currentAck(key: string, stateHash: string): Ack | undefined {
  const a = readAck(key);
  return a && a.stateHash === stateHash ? a : undefined;
}

/** Remove acks whose stateHash no longer matches a standing item's. Returns the pruned keys. */
export function pruneStaleAcks(standing: Array<{ key: string; stateHash: string; headSha?: string }>): string[] {
  const items = new Map(standing.map((s) => [s.key, s]));
  const pruned: string[] = [];
  for (const a of listAcks()) {
    // Different hashes keep checks/review/draft visible, but must not discard
    // an acknowledgement of ready on this same head.
    const item = items.get(a.key);
    if (a.kind === 'pr:ready' && item?.headSha && a.stateHash === prReadyStateHash(item.headSha)) continue;
    const h = item?.stateHash;
    if (h !== undefined && h !== a.stateHash && removeAck(a.key)) pruned.push(a.key);
  }
  return pruned;
}

/**
 * Whether an ack's item still exists, for cull: the dispatch is still on
 * disk (and not being culled), the PR is still open in some evidence, the
 * watch is still registered, or the report is still filed.
 */
export function ackItemExists(key: string, culling: ReadonlySet<string> = new Set()): boolean {
  if (key.startsWith('stack:')) return readPr(key.slice('stack:'.length))?.state === 'OPEN';
  if (key.startsWith('watch:')) return readWatch(key.slice('watch:'.length)) !== undefined;
  // An answered decision is no longer attention: its ack is orphaned.
  if (key.startsWith('decision:')) return readDecision(key) !== undefined && readDecisionAnswer(key) === undefined;
  if (key.startsWith('report:')) {
    const r = readReport(key);
    return r !== undefined && !culling.has(key) && !(r.dispatch !== undefined && culling.has(r.dispatch));
  }
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

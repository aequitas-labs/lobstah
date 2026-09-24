import * as fs from 'node:fs';
import * as path from 'node:path';
import { lobstahHome } from './paths.js';
import { parsePrRef } from './pr.js';
import type { PrEvidence } from './pr.js';

/**
 * PR records: PR state keyed by the PR, not by whichever dispatch reported
 * it. `~/.lobstah/prs/<owner>__<repo>__<n>.json` holds the latest
 * observation of one PR — the same object the pr: preset stamps into a
 * dispatch's evidence — plus the ids of every dispatch whose watch observed
 * it. A man-owned watch (a human's PR, or one whose dispatch was culled)
 * has no dispatch evidence to stamp, so the record is the only place its
 * state lives; tend, the glass, and the merged/closed notice all read
 * records first and fall back to dispatch evidence only for a PR that has
 * no record yet.
 *
 * One writer: the preset's observation path (apps/cli/src/pr-watch.ts).
 */

export interface PrRecord extends PrEvidence {
  /** `pr:<owner>/<repo>#<n>`. */
  key: string;
  /** The forge repo, `<owner>/<repo>`. */
  repo: string;
  /** Dispatches whose pr: watch observed this PR, oldest first; empty for an untracked/human PR. */
  dispatches: string[];
}

/** Records sort by observation time; older shapes can fall back to forge update time. */
export function prSortAt(pr: Pick<PrEvidence, 'observedAt' | 'updatedAt'>): string {
  return pr.observedAt || pr.updatedAt || '';
}

export function prsDir(): string {
  return path.join(lobstahHome(), 'prs');
}

/** `pr:<owner>/<repo>#<n>` → `<owner>__<repo>__<n>.json`. */
export function prRecordFile(key: string): string {
  const ref = parsePrRef(key);
  if (!ref) throw new Error(`not a PR key: ${key}`);
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(prsDir(), `${safe(ref.owner)}__${safe(ref.repo)}__${ref.number}.json`);
}

export function readPr(key: string): PrRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(prRecordFile(key), 'utf8')) as PrRecord;
  } catch {
    return undefined;
  }
}

export function readPrs(): PrRecord[] {
  let files: string[];
  try {
    files = fs.readdirSync(prsDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files.flatMap((f) => {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(prsDir(), f), 'utf8')) as PrRecord;
      return typeof r.key === 'string' && typeof r.url === 'string' ? [r] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Write one observation. Fields come from the new observation (an absent
 * optional field keeps the previous value, e.g. a title set elsewhere);
 * `dispatchId`, when the observing watch is dispatch-owned, is appended once.
 * Returns the record before and after, so the caller can act on the
 * open → merged/closed transition.
 */
export function upsertPr(pr: PrEvidence, dispatchId?: string): { before?: PrRecord; after: PrRecord } {
  const ref = parsePrRef(pr.url);
  if (!ref) throw new Error(`not a PR url: ${pr.url}`);
  const before = readPr(ref.key);
  const dispatches = [...(before?.dispatches ?? [])];
  if (dispatchId && !dispatches.includes(dispatchId)) dispatches.push(dispatchId);
  const after: PrRecord = {
    ...(before ?? {}),
    ...pr,
    key: ref.key,
    repo: `${ref.owner}/${ref.repo}`,
    dispatches,
  };
  fs.mkdirSync(prsDir(), { recursive: true });
  const file = prRecordFile(ref.key);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(after, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return { before, after };
}

export function removePr(key: string): boolean {
  const file = prRecordFile(key);
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  return existed;
}

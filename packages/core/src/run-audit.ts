import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { lobstahHome } from './paths.js';
import { withDirLock } from './dir-lock.js';

/**
 * The run audit: one line per run card run, in `run/audit.jsonl`, each naming
 * the hash of the line before it, like the grants ledger (grants.ts). It
 * records what ran and how it ended, and never an input value or a byte of
 * output. An edited or removed line breaks the chain, which shows tampering;
 * it cannot stop a process running as the same user.
 */

export interface RunAuditEntry {
  at: string;
  /** The run card's decision key. */
  key: string;
  title: string;
  dispatch?: string;
  /** Who posted the card (the helm), and the trap whose proposal it carries. */
  postedBy: string;
  proposedBy?: string;
  scriptSha256: string;
  cwd: string;
  /** The passkey that confirmed the Run. */
  credentialId: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  outputBytes: number;
  /** How many input values the scrubber replaced. */
  scrubbed: number;
  /** The previous line's hash, or `genesis`. */
  prev: string;
  /** sha256 of this line without `hash`. */
  hash: string;
}

export function runAuditFile(): string {
  return path.join(lobstahHome(), 'run', 'audit.jsonl');
}

const lineHash = (entry: Omit<RunAuditEntry, 'hash'>): string => createHash('sha256').update(JSON.stringify(entry)).digest('hex');

/** Every entry, and whether the chain is whole. */
export function readRunAudit(file = runAuditFile()): { entries: RunAuditEntry[]; intact: boolean } {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { entries: [], intact: true };
  }
  const entries: RunAuditEntry[] = [];
  let prev = 'genesis';
  let intact = true;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: RunAuditEntry;
    try {
      entry = JSON.parse(line) as RunAuditEntry;
    } catch {
      intact = false;
      continue;
    }
    const { hash, ...rest } = entry;
    if (entry.prev !== prev || lineHash(rest) !== hash) intact = false;
    prev = hash;
    entries.push(entry);
  }
  return { entries, intact };
}

/** Append one run, chained to the last line. */
export function appendRunAudit(entry: Omit<RunAuditEntry, 'prev' | 'hash'>, file = runAuditFile()): RunAuditEntry {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withDirLock(`${file}.lock`, () => {
    const prev = readRunAudit(file).entries.at(-1)?.hash ?? 'genesis';
    const body = { ...entry, prev };
    const line: RunAuditEntry = { ...body, hash: lineHash(body) };
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    return line;
  }, { staleMs: 5000, waitMs: 5000, pauseMs: 20, busy: () => new Error('the run audit is busy; try again') });
}

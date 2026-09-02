import * as fs from 'node:fs';
import * as path from 'node:path';
import { lobstahHome } from '@lobstah/core';
import type { Verb } from '@lobstah/core';

export interface MapEntry {
  uuid: string;
  kind: 'issue' | 'review';
  createdAt: string;
  lastReported?: Verb;
  lastInboundAt?: string;
  recovered?: boolean;
}

interface StateFile {
  map: Record<string, MapEntry>;
  consumedApprovals: Record<string, string>;
  rebases: Record<string, { uuid: string; failed?: boolean }>;
}

/**
 * Pickup's own state: the item-to-UUID mapping the loops correlate through,
 * the merge loop's PR-to-chore table, and consumed approvals. Load-bearing,
 * so written atomically — and reconstructible from the tracker trail, so a
 * missing entry is `unknown` and triggers a rebuild, never a reset.
 */
export class PickupState {
  private file: string;
  private data: StateFile;

  constructor(dir = path.join(lobstahHome(), 'pickup')) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'state.json');
    this.data = fs.existsSync(this.file)
      ? (JSON.parse(fs.readFileSync(this.file, 'utf8')) as StateFile)
      : { map: {}, consumedApprovals: {}, rebases: {} };
    this.data.map ??= {};
    this.data.consumedApprovals ??= {};
    this.data.rebases ??= {};
  }

  private save(): void {
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get(key: string): MapEntry | undefined {
    return this.data.map[key];
  }
  entries(): Array<[string, MapEntry]> {
    return Object.entries(this.data.map);
  }
  set(key: string, entry: MapEntry): void {
    this.data.map[key] = entry;
    this.save();
  }
  update(key: string, patch: Partial<MapEntry>): void {
    const cur = this.data.map[key];
    if (!cur) return;
    this.data.map[key] = { ...cur, ...patch };
    this.save();
  }

  approvalConsumed(dedupKey: string): boolean {
    return dedupKey in this.data.consumedApprovals;
  }
  consumeApproval(dedupKey: string): void {
    this.data.consumedApprovals[dedupKey] = new Date().toISOString();
    this.save();
  }

  rebase(prKey: string): { uuid: string; failed?: boolean } | undefined {
    return this.data.rebases[prKey];
  }
  setRebase(prKey: string, uuid: string): void {
    this.data.rebases[prKey] = { uuid };
    this.save();
  }
  failRebase(prKey: string): void {
    const cur = this.data.rebases[prKey];
    if (cur) {
      cur.failed = true;
      this.save();
    }
  }
  clearRebase(prKey: string): void {
    delete this.data.rebases[prKey];
    this.save();
  }
}

import * as fs from 'node:fs';
import type { Evidence, Lane } from './types.js';
import { evidencePath } from './paths.js';

export function readEvidence(id: string, lane: Lane): Evidence {
  try {
    return JSON.parse(fs.readFileSync(evidencePath(id, lane), 'utf8')) as Evidence;
  } catch {
    return {};
  }
}

export function mergeEvidence(id: string, lane: Lane, patch: Evidence): void {
  const file = evidencePath(id, lane);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ ...readEvidence(id, lane), ...patch }, null, 2));
  fs.renameSync(tmp, file);
}

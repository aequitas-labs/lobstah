import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from './config.js';
import { liveHelms } from './helm.js';
import { storedDescriptor } from './queue.js';
import { laneDirs, uniqueTempPath } from './paths.js';
import type { Lane } from './types.js';

export interface CatchContext { claimHelm?: boolean | null; helm?: boolean | null; location?: 'local' | 'wharf' }
export function readCatchContext(dir: string, id: string): CatchContext {
  try { return JSON.parse(fs.readFileSync(path.join(dir, `${id}.catch-context`), 'utf8')); } catch { return {}; }
}
/** Forward-only observation. A missing old claim is unknown, not a guess. */
export function observeLocalCatch(id: string, lane: Lane, phase: 'claim' | 'finish', now = Date.now()): void {
  const dir = laneDirs(lane).state, old = readCatchContext(dir, id), cfg = loadConfig();
  if (phase === 'finish' && Object.hasOwn(old, 'helm')) return; // A done retry cannot rewrite the first completion's observation.
  const repo = storedDescriptor(id, lane)?.repo;
  const helms = liveHelms(cfg.helm.ttlSecs * 1000, now);
  const present = repo ? helms.some((h) => h.repos.includes(repo)) : null;
  const next: CatchContext = phase === 'claim' ? { claimHelm: present, location: 'local' }
    : { ...old, location: 'local', helm: old.claimHelm === true || present === true ? true : old.claimHelm === false && present === false ? false : null };
  const file = path.join(dir, `${id}.catch-context`), tmp = uniqueTempPath(file);
  try { fs.writeFileSync(tmp, JSON.stringify(next)); fs.renameSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
}

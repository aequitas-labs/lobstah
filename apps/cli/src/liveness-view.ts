import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { laneDirs, loadConfig, queuedAt, readEvidence, readStatusLog, storedDescriptor } from '@lobstah/core';
import type { Lane } from '@lobstah/core';

export interface LivenessView {
  elapsed?: string;
  attempt?: number;
  branch?: string;
  lastCommit?: string;
  aheadTrunk?: string;
  draftPr?: string;
  updated?: string;
}

function git(cwd: string, ...args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch { return undefined; }
}

/** Read-only local counterpart of pickup's live tracker comment. */
export function livenessView(id: string, lane: Lane): LivenessView {
  const ev = readEvidence(id, lane);
  const d = storedDescriptor(id, lane);
  const cfg = loadConfig();
  const wt = ev.worktree && fs.existsSync(ev.worktree) ? ev.worktree : undefined;
  const since = queuedAt(id, lane);
  const elapsed = since ? `${Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 1000))}s` : undefined;
  let attempt: number | undefined;
  try {
    const runner = JSON.parse(fs.readFileSync(path.join(laneDirs(lane).active, id, 'runner.json'), 'utf8')) as { attempts?: number };
    attempt = runner.attempts;
  } catch { /* not a headless active run */ }
  const branch = (wt && git(wt, 'branch', '--show-current')) || ev.branch;
  const lastCommit = wt && git(wt, 'log', '-1', '--format=%h %s');
  const trunk = d && cfg.repos[d.repo]?.trunk;
  const ahead = wt && trunk && git(wt, 'rev-list', '--count', `origin/${trunk}..HEAD`);
  return {
    ...(elapsed ? { elapsed } : {}),
    ...(attempt ? { attempt } : {}),
    ...(branch ? { branch } : {}),
    ...(lastCommit ? { lastCommit } : {}),
    ...(ahead !== undefined && trunk ? { aheadTrunk: `${ahead} ahead of ${trunk}` } : {}),
    ...(ev.prUrl ? { draftPr: ev.prUrl } : {}),
    ...(readStatusLog(id, lane).at(-1)?.at ? { updated: readStatusLog(id, lane).at(-1)!.at } : {}),
  };
}

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

/**
 * A worktree's git answers, kept per process. The glass builds a snapshot on
 * every poll, and each dispatch with a worktree asked git three times, twice
 * per snapshot (the dispatch rows and tend). An answer is reused while the
 * worktree's reflog (`logs/HEAD`, appended on every commit, checkout, and
 * reset) is unchanged, and for at most GIT_CACHE_MS, which bounds how stale
 * the commits-ahead count can be after a fetch moves the trunk.
 */
export const GIT_CACHE_MS = 60_000;
const gitCache = new Map<string, { stamp: string; at: number; out: string | undefined }>();

/** The worktree's reflog size and mtime: it changes with every HEAD move. '' when unreadable. */
function headStamp(cwd: string): string {
  try {
    const dotGit = path.join(cwd, '.git');
    const gitdir = fs.statSync(dotGit).isFile()
      ? path.resolve(cwd, fs.readFileSync(dotGit, 'utf8').replace(/^gitdir:\s*/, '').trim())
      : dotGit;
    const stamp = (f: string) => {
      try {
        const st = fs.statSync(path.join(gitdir, f));
        return `${st.size}:${st.mtimeMs}`;
      } catch {
        return '-';
      }
    };
    return `${stamp('logs/HEAD')}|${stamp('HEAD')}`;
  } catch {
    return '';
  }
}

function git(cwd: string, ...args: string[]): string | undefined {
  const key = `${cwd}\0${args.join('\0')}`;
  const stamp = headStamp(cwd);
  const now = Date.now();
  const hit = gitCache.get(key);
  if (hit && stamp !== '' && hit.stamp === stamp && now - hit.at < GIT_CACHE_MS) return hit.out;
  let out: string | undefined;
  try {
    out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    out = undefined;
  }
  gitCache.set(key, { stamp, at: now, out });
  if (gitCache.size > 4096) for (const [k, v] of gitCache) if (now - v.at >= GIT_CACHE_MS) gitCache.delete(k);
  return out;
}

/** Drop every cached git answer (tests). */
export function clearGitCache(): void {
  gitCache.clear();
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

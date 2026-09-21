import * as fs from 'node:fs';
import * as path from 'node:path';
import { laneDirs } from '@lobstah/core';
import type { Evidence } from '@lobstah/core';

/** Trailing-slash-insensitive comparison key for a PR URL. */
export function prUrlKey(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * PR URL → dispatch UUID, from the evidence workers reported with `--pr`.
 * This is the link for PRs whose branch is not lobstah-named — a soaked
 * session's PR carries whatever branch its worktree had, and the evidence
 * file is the only honest record of which dispatch produced it. Work lane
 * only: chores report no PRs worth following up. When several dispatches in
 * a chain report the same PR, the newest evidence write wins — the latest
 * chain member is the right fork target.
 */
export function prEvidenceIndex(): Map<string, string> {
  const byUrl = new Map<string, { uuid: string; mtime: number }>();
  const stateDir = laneDirs('work').state;
  let files: string[];
  try {
    files = fs.readdirSync(stateDir).filter((f) => f.endsWith('.evidence'));
  } catch {
    return new Map();
  }
  for (const f of files) {
    const file = path.join(stateDir, f);
    try {
      const prUrl = (JSON.parse(fs.readFileSync(file, 'utf8')) as Evidence).prUrl;
      if (!prUrl) continue;
      const key = prUrlKey(prUrl);
      const mtime = fs.statSync(file).mtimeMs;
      const cur = byUrl.get(key);
      if (!cur || mtime > cur.mtime) byUrl.set(key, { uuid: f.slice(0, -'.evidence'.length), mtime });
    } catch {
      // unreadable evidence — skip; the branch-name mapping may still hold
    }
  }
  return new Map([...byUrl].map(([url, v]) => [url, v.uuid]));
}

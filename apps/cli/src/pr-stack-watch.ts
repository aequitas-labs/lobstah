import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lobstahHome, loadConfig, parsePrRef, PR_VIEW_FIELDS, prStackTrunk, readPrs, readWatch } from '@lobstah/core';
import type { GhPrView, PrRef } from '@lobstah/core';
import { addPrWatch, observePr, pollSecs } from './pr-watch.js';

type LinkView = GhPrView & { number: number; url: string };
export type FetchStackLink = (ref: PrRef, branch: string, direction: 'head' | 'base') => LinkView[];

/** One extra read per unknown branch link, including the full observation. */
export const ghStackLink: FetchStackLink = (ref, branch, direction) => {
  const res = spawnSync('gh', ['pr', 'list', '--repo', `${ref.owner}/${ref.repo}`, '--state', 'open',
    `--${direction}`, branch, '--limit', '3', '--json', `${PR_VIEW_FIELDS},number,url`],
  { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  if (res.error || res.status !== 0) throw new Error(res.error?.message ?? res.stderr);
  return JSON.parse(res.stdout) as LinkView[];
};

/**
 * Discover in both directions, so watch add on any member follows the chain.
 * Newly found PRs use the same preset/cadence, never a second polling loop.
 * Negative links are cached for one cadence; known links cost no extra fetch.
 */
export function discoverPrStack(ref: PrRef, opts: { now?: number; fetch?: FetchStackLink; everySecs?: number } = {}): void {
  const now = opts.now ?? Date.now(), cfg = loadConfig(), fetch = opts.fetch ?? ghStackLink;
  const everySecs = opts.everySecs ?? pollSecs();
  const file = path.join(lobstahHome(), 'pr-stack-links.json');
  let checked: Record<string, number>;
  try { checked = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { checked = {}; }
  const todo = [ref.key], visited = new Set<string>();
  // Bound malformed chains. A normal nine-PR stack takes at most one call per missing link.
  while (todo.length && visited.size < 32) {
    const key = todo.shift()!;
    if (visited.has(key)) continue;
    visited.add(key);
    const records = readPrs(), p = records.find((r) => r.key === key);
    if (!p || p.state !== 'OPEN' || p.isCrossRepository) continue;
    for (const direction of ['head', 'base'] as const) {
      const branch = direction === 'head' ? p.baseRefName : p.headRefName;
      if (!branch || (direction === 'head' && branch === prStackTrunk(cfg, p.repo))) continue;
      const known = records.filter((r) => r.repo === p.repo && !r.isCrossRepository && r.state === 'OPEN' &&
        (direction === 'head' ? r.headRefName : r.baseRefName) === branch);
      if (known.length) {
        known.forEach((r) => {
          if (!readWatch(r.key)) addPrWatch(parsePrRef(r.key)!, { everySecs });
          todo.push(r.key);
        });
        continue;
      }
      const link = `${p.repo}:${direction}:${branch}`;
      if (checked[link] !== undefined && now - checked[link]! < everySecs * 1000) continue;
      checked[link] = now;
      try {
        const views = fetch(parsePrRef(p.key)!, branch, direction).filter((v) =>
          !v.isCrossRepository && v.state === 'OPEN' &&
          (direction === 'head' ? v.headRefName : v.baseRefName) === branch &&
          parsePrRef(v.url)?.owner === ref.owner && parsePrRef(v.url)?.repo === ref.repo);
        // A branch DAG is not a stack; do not silently choose a sibling.
        if (views.length !== 1) continue;
        const view = views[0]!, found = parsePrRef(view.url)!;
        // gh pr list cannot read unresolved review threads. The normal
        // watch check supplies them; discovery must not announce readiness first.
        observePr(found, view, { now: new Date(now), discovered: true });
        if (!readWatch(found.key)) addPrWatch(found, { everySecs });
        todo.push(found.key);
      } catch { /* Existing watch retries at its normal cadence; never invent readiness. */ }
    }
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(checked)); fs.renameSync(tmp, file);
}

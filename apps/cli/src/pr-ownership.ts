import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicRenameSync, lobstahHome, uniqueTempPath } from '@lobstah/core';
import type { PrEvidence } from '@lobstah/core';

/**
 * Whose PR this is, as far as what lobstah may do to it on its own:
 * - `person`: authored by the gh-authenticated user (dispatch PRs included,
 *   since lobstah pushes and opens them as that user);
 * - `dispatch`: a lobstah dispatch observed it, and its author is unknown;
 * - `foreign`: authored by someone else;
 * - `unknown`: no author and no dispatch.
 */
export type PrAuthorship = 'person' | 'dispatch' | 'foreign' | 'unknown';

/** What decides authorship: the recorded author and the dispatches that observed the PR. */
export type AuthoredPr = Pick<PrEvidence, 'author'> & { dispatches?: readonly string[] };

/** `viewer` is asked for the gh login only when the PR's author is known. */
export function prAuthorship(pr: AuthoredPr, viewer: () => string | undefined): PrAuthorship {
  const login = pr.author ? viewer() : undefined;
  if (pr.author && login) return pr.author.toLowerCase() === login.toLowerCase() ? 'person' : 'foreign';
  return pr.dispatches?.length ? 'dispatch' : 'unknown';
}

/**
 * Automatic watch registration (stack discovery, backfill) covers only the
 * person's own PRs and PRs a dispatch opened. An explicit `watch add` or
 * `report --pr` does not ask.
 */
export function mayAutoWatch(authorship: PrAuthorship): boolean {
  return authorship === 'person' || authorship === 'dispatch';
}

/** Auto-repair never pushes to a PR someone else authored, whatever registered its watch. */
export function mayAutoRepair(authorship: PrAuthorship): boolean {
  return authorship !== 'foreign';
}

/** How long a known login, or a failed lookup, is reused before `gh api user` runs again. */
const LOGIN_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;

interface ViewerCache {
  login?: string;
  at: number;
}

const cacheFile = (): string => path.join(lobstahHome(), 'github-viewer.json');

/** The login `gh` is authenticated as; one lookup a day, cached in the lobstah home. */
export function githubViewer(
  now = Date.now(),
  lookup: () => string | undefined = () => {
    const res = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    return res.status === 0 ? res.stdout.trim() || undefined : undefined;
  },
): string | undefined {
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as ViewerCache;
    if (now - cached.at < (cached.login ? LOGIN_TTL_MS : MISS_TTL_MS)) return cached.login;
  } catch {
    /* no cache yet */
  }
  const login = lookup();
  try {
    fs.mkdirSync(lobstahHome(), { recursive: true });
    const tmp = uniqueTempPath(cacheFile());
    fs.writeFileSync(tmp, JSON.stringify({ ...(login ? { login } : {}), at: now } satisfies ViewerCache));
    atomicRenameSync(tmp, cacheFile());
  } catch {
    /* an unwritable cache only costs another lookup */
  }
  return login;
}

import { spawnSync } from 'node:child_process';
import { loadConfig, parsePrRef } from '@lobstah/core';
import type { DescriptorPr } from '@lobstah/core';
import { githubRepoFromOrigin } from '@lobstah/pick';

/**
 * `--pr` on `dispatch` and `send`: the existing PR a dispatch works on. A
 * descriptor that names a PR keeps it: the runner pushes no `lobstah/<id>`
 * branch and opens no draft PR, and the worker pushes to the PR's head
 * branch. Naming it is explicit on purpose: a brief that mentions a PR in
 * prose may be pointing at context, not at the branch to push to.
 */

export type PrView = (url: string) => { state?: string; headRefName?: string } | undefined;

const ghView: PrView = (url) => {
  const r = spawnSync('gh', ['pr', 'view', url, '--json', 'state,headRefName'], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  if (r.status !== 0) return undefined;
  try {
    return JSON.parse(r.stdout) as { state?: string; headRefName?: string };
  } catch {
    return undefined;
  }
};

/** `owner/name` of a configured repo's GitHub origin: its `origin`, else its checkout's git origin. */
export function repoForge(repoKey: string): string | undefined {
  const repo = loadConfig().repos[repoKey];
  if (!repo) return undefined;
  const origin =
    repo.origin ?? spawnSync('git', ['-C', repo.path, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).stdout?.trim();
  return origin ? githubRepoFromOrigin(origin) : undefined;
}

/**
 * The PR a `--pr` value names: a URL, `owner/repo#n`, or a number (`123`,
 * `#123`) in the repo's GitHub origin. It must be in that repo and, when
 * `gh` can see it, open. Its head branch is recorded when known.
 */
export function resolvePrTarget(repoKey: string, value: string, view: PrView = ghView): DescriptorPr {
  const forge = repoForge(repoKey);
  const number = /^#?(\d+)$/.exec(value.trim());
  let url: string;
  if (number) {
    if (!forge) throw new Error(`--pr ${value}: repo ${repoKey} has no GitHub origin to find PR #${number[1]} in; pass the PR's URL`);
    url = `https://github.com/${forge}/pull/${number[1]}`;
  } else {
    const ref = parsePrRef(value);
    if (!ref) throw new Error(`--pr takes a PR URL, owner/repo#n, or a number, not "${value}"`);
    if (forge && `${ref.owner}/${ref.repo}`.toLowerCase() !== forge.toLowerCase()) throw new Error(`--pr ${ref.url} is not in repo ${repoKey} (${forge})`);
    url = ref.url;
  }
  const seen = view(url);
  if (seen?.state && seen.state !== 'OPEN') throw new Error(`--pr ${url} is ${seen.state.toLowerCase()}; a dispatch can only push to an open PR`);
  return { url, ...(seen?.headRefName ? { headRefName: seen.headRefName } : {}) };
}

/**
 * PRs of the repo a brief names without `--pr`. The dispatch would open a
 * new draft PR of its own; if the brief means to push to one of these, the
 * dispatcher should say so with `--pr`.
 */
export function briefPrMentions(brief: string, repoKey: string): string[] {
  const forge = repoForge(repoKey)?.toLowerCase();
  if (!forge) return [];
  const urls = new Set<string>();
  for (const m of brief.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g)) {
    const ref = parsePrRef(m[0]);
    if (ref && `${ref.owner}/${ref.repo}`.toLowerCase() === forge) urls.add(ref.url);
  }
  return [...urls];
}

import { spawnSync } from 'node:child_process';
import { githubBlockedUntil, recordGitHubRateLimit, recordGitHubResponse } from '@lobstah/core';
import type { FetchLike } from './reviews-post.js';

/** Preserve changed text and binary contents, ignoring base context, hunk offsets and file ordering. */
export function reviewPatchId(diff: string): string | undefined {
  if (!diff) return 'empty';
  if (!diff.startsWith('diff --git ')) return undefined;
  // A base merge can change context beside a PR hunk without changing the
  // author's patch. Flatten text hunks to their removed/added lines first.
  const changes = diff.split(/(?=^diff --git )/m).map(file => {
    const firstHunk = file.search(/^@@ /m);
    if (firstHunk < 0) return file;
    const lines = file.slice(firstHunk).split('\n').filter(line => /^[+-]/.test(line) || line.startsWith('\\ No newline'));
    const removed = lines.filter(line => line.startsWith('-')).length;
    const added = lines.filter(line => line.startsWith('+')).length;
    return `${file.slice(0, firstHunk)}@@ -1,${removed} +1,${added} @@\n${lines.join('\n')}\n`;
  }).join('');
  const result = spawnSync('git', ['patch-id', '--verbatim'], { input: changes, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return undefined;
  const match = /^([a-f0-9]{40,64}) [a-f0-9]{40,64}\s*$/.exec(result.stdout);
  return match ? `v2:${match[1]}` : undefined;
}

/** Older cached fingerprints included base context and must be recomputed before comparing. */
export function currentReviewDiffId(id: string | undefined): string | undefined {
  return id === 'empty' || id?.startsWith('v2:') ? id : undefined;
}

/** GitHub's three-dot comparison is the PR's diff from its merge base, including fork heads. */
export async function reviewDiffId(repo: string, base: string, head: string,
  opts: { token: () => string; fetch?: FetchLike; now: number; log: (message: string) => void }): Promise<string | undefined> {
  if (githubBlockedUntil(opts.now)) return undefined;
  const f: FetchLike = opts.fetch ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(90_000) }));
  try {
    const response = await f(`https://api.github.com/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, {
      method: 'GET', headers: { authorization: `Bearer ${opts.token()}`, accept: 'application/vnd.github.diff', 'user-agent': 'lobstah-pick' },
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    recordGitHubResponse(headers, { now: opts.now, success: response.ok });
    if (response.status === 429 || (response.status === 403 && (headers['retry-after'] || headers['x-ratelimit-remaining'] === '0'))) {
      const retry = Number(headers['retry-after']);
      recordGitHubRateLimit(opts.now, retry > 0 ? opts.now + retry * 1000 : undefined);
    }
    if (!response.ok) throw new Error(`GitHub diff returned ${response.status}`);
    const id = reviewPatchId(await response.text());
    if (!id) throw new Error('GitHub diff could not be fingerprinted');
    return id;
  } catch (error) {
    opts.log(`${repo}: waiting to compare review changes: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

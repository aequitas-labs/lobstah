import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GlassPrDetails } from '@lobstah/core';

const exec = promisify(execFile);
/** The GitHub fields needed by an open PR view, including fresh signed image URLs. */
interface GitHubPrDetails {
  html_url: string;
  title: string;
  body_html?: string | null;
  user?: { login: string; avatar_url?: string };
  head?: { ref?: string };
  base?: { ref?: string };
  updated_at?: string;
  state?: string;
  merged?: boolean;
  draft?: boolean;
}

/** Read once through gh's existing sign-in; argv stays separate from the validated PR identity. */
export async function readPrDetails(key: string, run: typeof exec = exec): Promise<GlassPrDetails | undefined> {
  const ref = /^pr:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d*)$/.exec(key);
  if (!ref) return undefined;
  try {
    const result = await run('gh', ['api', `repos/${ref[1]}/${ref[2]}/pulls/${ref[3]}`, '-H', 'Accept: application/vnd.github.html+json'],
      { encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    const pr = JSON.parse(String(result.stdout)) as GitHubPrDetails;
    if (typeof pr.title !== 'string' || typeof pr.html_url !== 'string') return undefined;
    return { key, url: pr.html_url, title: pr.title, bodyHtml: pr.body_html ?? '',
      ...(pr.user ? { author: { login: pr.user.login, avatarUrl: pr.user.avatar_url } } : {}),
      headRefName: pr.head?.ref, baseRefName: pr.base?.ref, updatedAt: pr.updated_at,
      state: pr.merged ? 'MERGED' : pr.state?.toUpperCase(), draft: pr.draft };
  } catch {
    return undefined;
  }
}

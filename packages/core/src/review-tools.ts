/** Review destinations only; the canonical GitHub URL remains the watch identity. */
export const REVIEW_PRESETS = {
  github: 'https://github.com/{owner}/{repo}/pull/{number}',
  graphite: 'https://app.graphite.com/github/pr/{owner}/{repo}/{number}',
  linear: 'https://linear.review/{owner}/{repo}/pull/{number}',
  'linear-app': 'linear://review/{owner}/{repo}/pull/{number}',
} as const;

export function validReviewTool(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (Object.hasOwn(REVIEW_PRESETS, value)) return true;
  if (value.length > 2048 || !['owner', 'repo', 'number'].every((key) => value.includes(`{${key}}`))) return false;
  if (/\{(?!owner\}|repo\}|number\})|[\s<>]/.test(value)) return false;
  try {
    const url = new URL(value.replaceAll('{owner}', 'owner').replaceAll('{repo}', 'repo').replaceAll('{number}', '1'));
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

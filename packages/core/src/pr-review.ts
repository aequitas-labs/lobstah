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
  } catch { return false; }
}

/** Pure, browser-safe transformation; never changes a non-GitHub URL. */
export function prReviewUrl(url: string, tools: Readonly<Record<string, string>> = {}): string {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(url);
  if (!match) return url;
  const owner = match[1]!, repo = match[2]!, number = match[3]!;
  const tool = tools[`${owner}/${repo}`.toLowerCase()] ?? 'github';
  if (tool === 'github') return url;
  if (!validReviewTool(tool)) return url;
  const template = REVIEW_PRESETS[tool as keyof typeof REVIEW_PRESETS] ?? tool;
  return template.replaceAll('{owner}', encodeURIComponent(owner)).replaceAll('{repo}', encodeURIComponent(repo)).replaceAll('{number}', number);
}

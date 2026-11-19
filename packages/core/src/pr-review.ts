import { REVIEW_PRESETS, validReviewTool } from './review-tools.js';
export { REVIEW_PRESETS, validReviewTool } from './review-tools.js';

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

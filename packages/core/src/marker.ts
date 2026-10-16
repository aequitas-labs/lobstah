/**
 * The hidden marker: an HTML comment GitHub and Linear do not render.
 * Notes with no dispatch to name, agent replies, and posted reviews carry
 * it, so feedback pickup can tell lobstah's own writes from a person's even
 * when both come from the configured identity.
 */
export const HIDDEN_MARKER = /<!-- lobstah(?::[^>]*)? -->/;

export function hiddenMarker(tag?: string): string {
  return tag ? `<!-- lobstah:${tag} -->` : '<!-- lobstah -->';
}

/** The brief sentence that makes a worker mark what it posts on a PR. */
export function markRepliesRule(tag?: string): string {
  return `End every comment or reply you post on the PR with \`${hiddenMarker(tag)}\` so lobstah knows you wrote it.`;
}

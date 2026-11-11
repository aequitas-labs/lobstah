/** Window-only: reuse the page's live decision data; zero clears the badge. */
export async function setDecisionBadge(count: number): Promise<void> {
  if (typeof navigator.setAppBadge !== 'function') return;
  try {
    await navigator.setAppBadge(count);
  } catch {
    // Unsupported/denied by the browser or OS: never interrupt live state.
  }
}

/** Compatibility routes are validated by the adapter that owns their identities. */
export function watchMirrorRead(path: string): boolean | undefined {
  // A PR identity contains one encoded slash; validate the decoded identity before the generic path guard.
  if (path.startsWith('/data/pr/') && path.length <= 700 && !path.includes('..')) {
    try { return /^pr:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(decodeURIComponent(path.slice('/data/pr/'.length))); }
    catch { return false; }
  }
  return undefined;
}

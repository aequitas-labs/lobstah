/**
 * Classify a failed forge call (`gh`, or a watch check that wraps it) into a
 * cause and a remedy a human can act on. The text is whatever the command
 * printed — gh's stderr, or lobstah's own `error: ...` line on stdout.
 * Unknown errors keep their text and carry no remedy.
 */

export type GhErrorKind = 'checks-permission' | 'permission' | 'not-found' | 'auth' | 'rate-limit' | 'gh-missing' | 'unknown';

export interface GhErrorClass {
  kind: GhErrorKind;
  /** What to do about it; absent for unknown errors. */
  remedy?: string;
}

export const GH_REMEDY: Record<Exclude<GhErrorKind, 'unknown'>, string> = {
  'checks-permission':
    'grant the GitHub App `Checks: read` (or use a token with the `repo` scope); see docs/github.md',
  permission: 'grant the GitHub App `Pull requests: read` and `Contents: read` on this repo; see docs/github.md',
  'not-found':
    'check the repo name and that the gh identity can see it (App installed on the repo, or a token with access)',
  auth: 'credentials are missing, bad, or expired — run `gh auth status`, then `gh auth login` or refresh the token',
  'rate-limit': 'GitHub rate limit reached — the watch backs off; wait for the reset (`gh api rate_limit`)',
  'gh-missing': 'install the GitHub CLI (`gh`) and put it on PATH for the daemon',
};

const RULES: Array<[GhErrorKind, RegExp]> = [
  ['gh-missing', /spawn(Sync)? gh ENOENT|gh: command not found|command not found: gh|gh: not found/i],
  ['rate-limit', /rate limit|secondary rate|abuse detection|HTTP 429/i],
  ['auth', /bad credentials|HTTP 401|gh auth login|not logged in|authentication required|token (has )?expired|requires authentication|GH_TOKEN/i],
  // ghPrView tags the message when the view fails even without check results.
  ['permission', /resource not accessible by (integration|personal access token).*without check results/i],
  ['checks-permission', /resource not accessible by (integration|personal access token)/i],
  ['not-found', /could not resolve to a (repository|pullrequest)|not found|HTTP 404|no pull requests? found/i],
];

export function classifyGhError(text: string): GhErrorClass {
  for (const [kind, re] of RULES) {
    if (re.test(text)) return kind === 'unknown' ? { kind } : { kind, remedy: GH_REMEDY[kind] };
  }
  return { kind: 'unknown' };
}

/** Causes that will not fix themselves between cycles: the watch backs off. */
export function isBackoffKind(kind: GhErrorKind | undefined): boolean {
  return kind === 'checks-permission' || kind === 'permission' || kind === 'not-found' || kind === 'auth' || kind === 'rate-limit';
}

/**
 * The first meaningful line of a failed command's output: skip blank lines
 * and gh's noise, and unwrap lobstah's own TOON `error: ...` line.
 */
export function firstMeaningfulLine(...outputs: Array<string | undefined>): string | undefined {
  for (const out of outputs) {
    for (const raw of (out ?? '').split('\n')) {
      let line = raw.trim();
      if (!line || /^(warning:|hint:|\(node:|\{|\})/i.test(line)) continue;
      const m = /^error:\s*(.*)$/.exec(line);
      if (m) line = m[1]!.replace(/^"(.*)"$/, '$1').trim();
      line = line.replace(/^(gh|GraphQL):\s*/i, '');
      if (line) return line;
    }
  }
  return undefined;
}

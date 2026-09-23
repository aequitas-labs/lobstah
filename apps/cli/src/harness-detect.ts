/**
 * Which harness is this session? One resolver for `soak` and `man helm`.
 *
 * Precedence:
 *   1. an explicit `--harness`;
 *   2. the prior registration, when the same session re-soaks (an existing
 *      trap keeps what it was signed on with);
 *   3. the environment: only `CLAUDE*` keys → claude, only `CODEX*` keys →
 *      codex. Both are present when one harness runs inside a terminal the
 *      other launched, so key order decides nothing — the session id's
 *      format breaks the tie;
 *   4. the session id alone, when the environment names neither.
 *
 * The tie-break: Codex thread ids are UUIDv7 (time-ordered; the version
 * nibble — the first hex digit of the third group — is 7) and Claude Code
 * session ids are UUIDv4 (random; nibble 4). Verified on this machine on
 * 2026-09-23: the Codex trap's `01a0ceb8-b9bd-7d42-…` and every
 * ~/.codex/sessions rollout id are v7; this worker's `19a4f6e4-1341-4…`,
 * the helm's `7e740e13-30ec-454f-…`, and every ~/.claude/projects
 * transcript id are v4.
 *
 * Anything else is undecidable: `harness` comes back undefined with the
 * reason, and the caller decides — `soak` refuses and asks for --harness
 * rather than defaulting (a wrong label makes `attach` resume the wrong
 * CLI); `man helm` records no harness, as it always could.
 */

export type Harness = 'claude' | 'codex';
export type HarnessSource = 'flag' | 'prior' | 'env' | 'session-id';

export interface HarnessResolution {
  harness?: Harness;
  source?: HarnessSource;
  /** Why it is undecidable, when harness is undefined. */
  reason?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The harness a session id's format implies: v7 → codex, v4 → claude, else undefined. */
export function harnessFromSessionId(sessionId: string | undefined): Harness | undefined {
  const version = sessionId ? UUID.exec(sessionId)?.[1] : undefined;
  return version === '7' ? 'codex' : version === '4' ? 'claude' : undefined;
}

export function detectHarness(opts: {
  flag?: string;
  prior?: string;
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
}): HarnessResolution {
  if (opts.flag !== undefined) {
    if (opts.flag !== 'claude' && opts.flag !== 'codex') {
      return { reason: `--harness must be claude or codex, got "${opts.flag}"` };
    }
    return { harness: opts.flag, source: 'flag' };
  }
  if (opts.prior === 'claude' || opts.prior === 'codex') return { harness: opts.prior, source: 'prior' };
  const keys = Object.keys(opts.env ?? process.env);
  const claude = keys.some((k) => k.startsWith('CLAUDE'));
  const codex = keys.some((k) => k.startsWith('CODEX'));
  if (claude !== codex) return { harness: claude ? 'claude' : 'codex', source: 'env' };
  const byId = harnessFromSessionId(opts.sessionId);
  if (byId) return { harness: byId, source: 'session-id' };
  return {
    reason:
      (claude ? 'both CLAUDE* and CODEX* are set' : 'neither CLAUDE* nor CODEX* is set') +
      ` and the session id ${opts.sessionId ? `"${opts.sessionId}"` : '(none)'} is neither a UUIDv7 (Codex) nor a UUIDv4 (Claude Code)`,
  };
}

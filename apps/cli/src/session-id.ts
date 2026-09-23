/**
 * Where the caller's harness session id came from. Only `flag` is an
 * explicit claim; the rest are discovered, so refusals name the source to
 * make a mismatch diagnosable.
 */
export type SessionIdSource = 'flag' | 'stdin' | 'env';

export interface ResolvedSession {
  id: string;
  source: SessionIdSource;
  /** Human-facing name of the source, e.g. `$CLAUDE_CODE_SESSION_ID`. */
  from: string;
}

/**
 * Environment variables a harness exports into every tool command with the
 * same value its hooks receive as `session_id` on stdin.
 *
 * - Claude Code: `CLAUDE_CODE_SESSION_ID` (verified equal to the
 *   SessionStart hook's `session_id` on Claude Code 2.1.270).
 * - Codex: none documented. Its hooks docs give the id only as `session_id`
 *   on hook stdin, and the `@openai/codex-sdk` types expose no such env var.
 *   Deliberately not guessed — add it here only once Codex documents one.
 */
export const SESSION_ENV_KEYS = ['CLAUDE_CODE_SESSION_ID'] as const;

/**
 * The one precedence rule for "which session is calling": an explicit
 * `--session` always wins, then the hook's stdin `session_id`, then the
 * harness environment. `stdin` is a thunk so verbs that never read hook
 * input (and must never block on a stdin read) simply omit it.
 */
export function resolveSessionId(opts: {
  flag?: string;
  stdin?: () => string | undefined;
  env?: NodeJS.ProcessEnv;
}): ResolvedSession | undefined {
  if (opts.flag) return { id: opts.flag, source: 'flag', from: '--session' };
  const fromStdin = opts.stdin?.();
  if (fromStdin) return { id: fromStdin, source: 'stdin', from: 'hook stdin' };
  const env = opts.env ?? process.env;
  for (const key of SESSION_ENV_KEYS) {
    const v = env[key]?.trim();
    if (v) return { id: v, source: 'env', from: `$${key}` };
  }
  return undefined;
}

/**
 * Append how the caller was identified to a helm-gate refusal — "reserved
 * for the helm session" is only actionable if the caller can see which id it
 * was judged as, and where that id came from (or that there was none).
 */
export function explainRefusal(refusal: string, who: ResolvedSession | undefined): string {
  if (!who) return `${refusal} (no --session given and none resolved from the environment)`;
  const override = who.source === 'flag' ? '' : '; pass --session to override';
  return `${refusal} (resolved session ${who.id} from ${who.from}${override})`;
}

// Consult lobstah grants for tool.check requests. Session windows cover the
// exact session and tool scope; legacy command/path grants remain trap-only.
// Explicit denials and organization ceilings stand. Use only the mods API.

/** The grants ledger, where lobstah keeps it. */
async function ledgerPath($) {
  const home = (await $.env.get('LOBSTAH_HOME')) || `${await $.env.get('HOME')}/.lobstah`;
  return `${home}/grants/ledger.jsonl`;
}

/** Ask the lobstah CLI; resolve to the covering grant ids, or none. Never rejects. */
async function grantCheck($, question) {
  try {
    const { exitCode, stdout } = await $.process.run(['lobstah', 'hook', 'grant-check'], { stdin: JSON.stringify(question), timeoutMs: 5000 });
    if (exitCode !== 0) return [];
    const answer = JSON.parse(stdout.trim().split('\n').pop() || '{}');
    return Array.isArray(answer.grants) ? answer.grants : [];
  } catch {
    return [];
  }
}

/**
 * The tool.check hook. It only ever turns an "ask" into an "allow"; on any
 * error it gives back Claude Code's own verdict.
 */
async function check($, e, next) {
  const verdict = await next(e);
  try {
    // Decided already (allowed, or refused), or capped by the organization: leave it.
    if (verdict.decision !== 'ask' || (verdict.ceiling && verdict.ceiling !== 'allow')) return verdict;
    // A query runs nothing; only a real call may use a grant.
    if (!e.tool_use_id || !(await $.fs.exists(await ledgerPath($)))) return verdict;
    const grants = await grantCheck($, { tool: e.tool, input: e.input, session: await $.session.id(), cwd: await $.session.cwd(), callId: e.tool_use_id });
    return grants.length ? { decision: 'allow', reason: `allowed by lobstah grant ${grants.join(', ')}` } : verdict;
  } catch {
    return verdict;
  }
}

export function register(on) {
  on('tool.check', {}, check);
}

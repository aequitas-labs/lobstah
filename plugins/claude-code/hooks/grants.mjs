// lobstah grants in Claude Code: a mod that lets a trap make a call a person
// has granted (`lobstah grant` at a terminal, or Allow on a glass card)
// without a permission prompt or the auto-mode classifier.
//
// It changes nothing Claude Code has already decided: a call the rules
// allow runs, and a call a deny rule, a tool's own check or the mode refuses
// stays refused. Only a call that would be put to someone (a prompt, the
// classifier) is checked against the grants ledger, by `lobstah hook
// grant-check`, which answers for signed-on traps only. A covered call is
// allowed and its grant's use recorded; anything else goes on as before.
//
// A mod reaches files, processes and the environment only through `$`
// (the mods API), never Node's own modules.

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
    const grants = await grantCheck($, { tool: e.tool, input: e.input, session: await $.session.id(), cwd: await $.session.cwd() });
    return grants.length ? { decision: 'allow', reason: `allowed by lobstah grant ${grants.join(', ')}` } : verdict;
  } catch {
    return verdict;
  }
}

export function register(on) {
  on('tool.check', { tool: 'Bash' }, check);
  on('tool.check', { tool: 'Write' }, check);
  on('tool.check', { tool: 'Edit' }, check);
  on('tool.check', { tool: 'MultiEdit' }, check);
  on('tool.check', { tool: 'NotebookEdit' }, check);
}

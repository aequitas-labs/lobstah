// lobstah grants in Claude Code: a mod that lets a trap make a call a person
// has granted (`lobstah grant` at a terminal, or Allow on a glass card)
// without a permission prompt or the auto-mode classifier.
//
// It changes nothing Claude Code has already decided: a call the rules
// allow runs, and a call a deny rule or a tool's own check refuses stays
// refused. Only a call that would be put to someone (a prompt, the
// classifier) is checked against the grants ledger, by `lobstah hook
// grant-check`, which answers for signed-on traps only. A covered call is
// allowed and its grant's use recorded; anything else goes on as before.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

const ledger = () => join(process.env.LOBSTAH_HOME || join(homedir(), '.lobstah'), 'grants', 'ledger.jsonl');

/** Ask the lobstah CLI; resolve to the covering grant ids, or none. Never rejects. */
function grantCheck(question) {
  return new Promise((resolve) => {
    const child = execFile('lobstah', ['hook', 'grant-check'], { timeout: 5000, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const answer = JSON.parse(String(stdout).trim().split('\n').pop() || '{}');
        resolve(Array.isArray(answer.grants) ? answer.grants : []);
      } catch {
        resolve([]);
      }
    });
    child.stdin?.end(JSON.stringify(question));
  });
}

export const register = (on) => {
  for (const tool of TOOLS) {
    on('tool.check', { tool }, async ($, e, next) => {
      const verdict = await next(e);
      // Decided already (allowed, or refused by a rule or a check), or capped by the organization: leave it.
      if (verdict.decision !== 'ask' || (verdict.ceiling && verdict.ceiling !== 'allow')) return verdict;
      // A query runs nothing; only a real call may use a grant.
      if (!e.tool_use_id || !existsSync(ledger())) return verdict;
      const grants = await grantCheck({ tool: e.tool, input: e.input, session: await $.session.id(), cwd: await $.session.cwd() });
      return grants.length ? { decision: 'allow', reason: `allowed by lobstah grant ${grants.join(', ')}` } : verdict;
    });
  }
};

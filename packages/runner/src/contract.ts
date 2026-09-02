import { VERBS } from '@lobstah/core';

/**
 * The status/inbox contract every dispatch learns. Injected by the runner
 * into the prompt it composes — nothing is installed repo-side, and the
 * contract versions with the daemon instead of drifting per repo.
 */
export function buildPrompt(brief: string, opts: { id: string; nudge?: string }): string {
  const reporting =
    `Report status by running \`lobstah report ${opts.id} <verb> [note]\` (verbs: ${VERBS.join(', ')}). ` +
    `Attach a PR URL to your final report with \`--pr <url>\`. ` +
    `At natural checkpoints, check for operator messages with \`lobstah inbox ${opts.id}\` — ` +
    `messages also arrive automatically between your turns.`;

  const parts = [
    `You are a dispatched coding agent supervised by lobstah. Dispatch id: ${opts.id}.`,
    `Work only inside the current directory — it is an isolated git worktree allocated for this dispatch.`,
    reporting,
    `Use \`needs-decision\` when you are blocked on a question only a human can answer, then stop. ` +
      `New operator messages may arrive between your turns as user messages; treat them as instructions from the dispatcher.`,
    `Commit your work with clear messages. Do not merge anything.`,
    `--- BRIEF ---`,
    brief,
  ];
  if (opts.nudge) parts.push(`--- SUPERVISOR NOTE ---`, opts.nudge);
  return parts.join('\n\n');
}

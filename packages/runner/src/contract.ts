import { attachmentBlock, VERBS, WAITING_ON } from '@lobstah/core';
import type { Attachment, ChainPr } from '@lobstah/core';

/**
 * The status/inbox contract every dispatch learns. Injected by the runner
 * into the prompt it composes — nothing is installed repo-side, and the
 * contract versions with the daemon instead of drifting per repo.
 */
export function buildPrompt(brief: string, opts: { id: string; nudge?: string; attachments?: Attachment[]; existingPr?: ChainPr }): string {
  const reporting =
    `Report status by running \`lobstah report ${opts.id} <verb> [note]\` (verbs: ${VERBS.join(', ')}). ` +
    `Attach a PR URL to your final report with \`--pr <url>\`. ` +
    `Only your report finishes this dispatch: ending a turn without \`done\` or \`failed\` does not. ` +
    `If you start background work and end your turn to wait for it, you are woken when it finishes. ` +
    `At natural checkpoints, check for operator messages with \`lobstah inbox ${opts.id}\` — ` +
    `messages also arrive automatically between your turns.`;

  const parts = [
    `You are a dispatched coding agent supervised by lobstah. Dispatch id: ${opts.id}.`,
    `Work only inside the current directory — it is an isolated git worktree allocated for this dispatch.`,
    reporting,
    `Use \`needs-decision\` when you are blocked on a question only a human can answer, then stop. ` +
      `New operator messages may arrive between your turns as user messages; treat them as instructions from the dispatcher.`,
    `Before you wait on something outside lobstah (a human review, a PR review, a deploy), report ` +
      `\`lobstah report ${opts.id} paused "<note>" --waiting-on ${WAITING_ON.join('|')} --link <url>\`. Report \`working\` when you resume.`,
    opts.existingPr
      ? `Commit your work with clear messages. This chain already has PR ${opts.existingPr.url}. The runner does not push or open another PR. ` +
        `Push your changes to its existing head branch${opts.existingPr.headRefName ? ` ${opts.existingPr.headRefName}` : ' (inspect the PR to find it)'}; do not create a duplicate PR. ` +
        `Report done with the same PR URL. Do not merge anything.`
      : `Commit your work with clear messages. The runner pushes committed HEAD early and opens or adopts one draft PR for the branch when available; do not create a duplicate PR. ` +
        `When finished, mark the draft ready for review if appropriate, then report done with its URL. Do not merge anything.`,
    `--- BRIEF ---`,
    opts.existingPr
      ? `${brief}\n\nExisting chain PR: ${opts.existingPr.url}. Head branch: ${opts.existingPr.headRefName ?? 'inspect the PR'}. The runner will not push this follow-up.`
      : brief,
  ];
  if (opts.attachments?.length) parts.push(attachmentBlock(opts.attachments));
  if (opts.nudge) parts.push(`--- SUPERVISOR NOTE ---`, opts.nudge);
  return parts.join('\n\n');
}

import { loadConfig, worktreesDir } from '@lobstah/core';

/**
 * The context lobstah gives both auto-mode reviewers: Claude Code's classifier
 * reads it from `autoMode.environment`, Codex's reviewer from lobstah's block
 * in `auto_review.extra_policy`. It only removes friction; each reviewer keeps
 * its own safety policy.
 */
export function lobstahContext(worktrees = worktreesDir(), glassPort = loadConfig().glass.port): string[] {
  return [
    `**lobstah worktrees**: Directories under ${worktrees}/ are the user's own development checkouts of their configured repos, created by lobstah (the user's local agent orchestrator) for its worker sessions ("traps"). A session working in one of them is in its trusted repo: reading, editing, building, testing, committing, and pushing a non-trunk branch there is ordinary project-scope work, not scope escalation into another repo.`,
    `**lobstah helm**: A session holding the lobstah helm (it ran \`lobstah man helm\`) orchestrates traps for the user. When the user asks in that session's own chat for a step a trap could not finish, the helm doing it is following the user's instruction, not Auto-Mode Bypass. The step is still judged on its own terms by every other rule.`,
    `**lobstah glass**: lobstah's glass (127.0.0.1:${glassPort}) is the user's own UI on this machine. A \`decision-answer\` event with \`from: glass\` (shown by \`lobstah man wait\` / \`man report\`) is the user's own answer to that card, the same as a chat message from them.`,
  ];
}

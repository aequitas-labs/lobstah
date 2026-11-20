import { postNotice, type CodexPluginHooks } from '@lobstah/core';
import type { CodexHookList } from './codex-hook-list.js';
import { codexPluginReviews, codexTrapHookBlockers, pluginHooksPhrase, type CodexPluginReview } from './codex-startup.js';
import { tmuxRunner, type TmuxRunner } from './tmux-terminal.js';

/**
 * Other plugins' hooks that will stop a Codex trap at "Hooks need review",
 * as `hooks/list` reports them before launch, and whether lobstah gets the
 * trap past that review itself.
 */
export interface PluginReviewPlan {
  reviews: CodexPluginReview[];
  /** How many hooks Codex will list: only other plugins' hooks, when `skip` is set. */
  hooks: number;
  /**
   * Lobstah presses Esc at the review ("Continue without trusting"): the
   * choice is `skip`, the pane is a tmux pane lobstah can read, and every
   * hook in the review belongs to another plugin. Codex 0.166 then starts
   * without those hooks and saves nothing. Lobstah's own hooks keep the
   * session trust it supplies, so they still run.
   */
  skip: boolean;
  /** Changes when the hooks or their plugin contents change: one notice per version. */
  version: string;
}

export function planPluginReview(
  cwd: string,
  opts: { listed?: CodexHookList; pluginHooks: CodexPluginHooks; env?: NodeJS.ProcessEnv; home?: string; tmux: boolean },
): PluginReviewPlan | undefined {
  const blockers = codexTrapHookBlockers(cwd, opts);
  const plugin = blockers.filter((b) => b.plugin);
  if (!plugin.length) return undefined;
  return {
    reviews: codexPluginReviews(plugin),
    hooks: plugin.length,
    skip: opts.pluginHooks === 'skip' && opts.tmux && plugin.length === blockers.length,
    version: plugin.map((b) => `${b.key}=${b.hash}`).sort().join(',').replace(/[^A-Za-z0-9]+/g, '').slice(-24),
  };
}

/** The blocking notice: the trap waits at the review until someone answers it. */
export function pluginReviewWaitingText(label: string, plan: PluginReviewPlan): string {
  return (
    `Codex needs you to review ${pluginHooksPhrase(plan.reviews)}; trap ${label} can't start until you do. ` +
    `In its Codex window, press Esc to start without them, or choose "Trust all and continue".`
  );
}

/** After lobstah pressed Esc: the trap is starting, without those hooks. */
export function pluginReviewSkippedText(label: string, plan: PluginReviewPlan): string {
  return (
    `Trap ${label} started without ${pluginHooksPhrase(plan.reviews)} because Codex wants them reviewed. ` +
    `To run them in traps, trust them once in any Codex session's /hooks.`
  );
}

/**
 * Read the pane, and press Esc once if it shows "Hooks need review" for
 * exactly `hooks` hooks. A different count means Codex wants other hooks
 * reviewed too: `other`, and no key is sent.
 */
export async function answerPluginReview(pane: string, hooks: number, run: TmuxRunner = tmuxRunner()): Promise<'pressed' | 'other' | 'none'> {
  let screen: string;
  try {
    screen = await run(['capture-pane', '-p', '-t', pane]);
  } catch {
    return 'none';
  }
  if (!/hooks need review/i.test(screen)) return 'none';
  const listed = /(\d+) hooks? (?:is|are) new or changed/i.exec(screen);
  if (!listed || Number(listed[1]) !== hooks) return 'other';
  await run(['send-keys', '-t', pane, 'Escape']);
  return 'pressed';
}

/**
 * Follows one launch through the plugin hook review. When lobstah can't
 * answer the review, it posts the blocking notice at launch. Otherwise each
 * tick reads the pane until it presses Esc, then posts what it skipped.
 */
export function pluginReviewWatch(
  plan: PluginReviewPlan | undefined,
  ctx: { label: string; trapId: string; repo?: string; grounds?: string; pane?: string; run?: TmuxRunner; started: number },
): { tick(): Promise<void> } {
  let watching = !!plan?.skip && !!ctx.pane;
  const where = { refId: ctx.trapId, ...(ctx.repo ? { repo: ctx.repo } : {}), ...(ctx.grounds ? { grounds: ctx.grounds } : {}) };
  const waiting = () =>
    postNotice({ kind: 'codex-plugin-hooks', text: pluginReviewWaitingText(ctx.label, plan!), ...where, dedupeKey: `codex-plugin-hooks-${ctx.trapId}-${ctx.started}` });
  if (plan && !watching) waiting();
  return {
    async tick() {
      if (!watching) return;
      const answer = await answerPluginReview(ctx.pane!, plan!.hooks, ctx.run);
      if (answer === 'none') return;
      watching = false;
      if (answer === 'other') {
        waiting();
        return;
      }
      postNotice({ kind: 'codex-plugin-hooks', text: pluginReviewSkippedText(ctx.label, plan!), ...where, dedupeKey: `codex-plugin-hooks-skipped-${plan!.version}` });
    },
  };
}

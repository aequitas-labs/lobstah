import * as fs from 'node:fs';
import { dispatchWorktree, readEvidence } from '@lobstah/core';
import type { Lane } from '@lobstah/core';

/**
 * The worktree fields `lobstah catch`, `man tend`, and the glass show for a
 * dispatch, from the one resolver (dispatchWorktree), so a follow-up that
 * reused its origin's worktree shows the directory it really ran in.
 */
export interface WorktreeView {
  /** The checkout, while it exists; `(removed)` once a cull took it. */
  worktree?: string;
  /** The dispatch whose worktree this one reused. */
  worktreeOf?: string;
}

export function worktreeView(id: string, lane: Lane): WorktreeView {
  const ev = readEvidence(id, lane);
  const wt = dispatchWorktree(id, lane);
  const exists = fs.existsSync(wt.path);
  // A dispatch with no recorded worktree and no directory never had one
  // (a trap's catch, or work still queued): show nothing.
  if (!exists && ev.worktree === undefined) return {};
  return {
    worktree: exists ? wt.path : '(removed)',
    ...(wt.reused ? { worktreeOf: wt.owner } : {}),
  };
}

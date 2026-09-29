import { spawnSync } from 'node:child_process';

/**
 * Push a PR's work to the PR's own head branch, and nowhere else.
 *
 * A push that loses a race (the branch moved after the worker fetched it) is
 * retried: fetch the branch, replay the work onto the moved head, and push
 * again with `--force-with-lease` on the head just fetched. Every push runs
 * the repo's push hooks again. A push that a hook or the remote refuses for
 * any other reason is not retried: that is a real error for the worker to fix.
 *
 * This never creates a branch and never opens a PR.
 */

export type PushResult =
  /** The PR branch now holds the work. */
  | { kind: 'pushed'; branch: string; head: string; attempts: number }
  /** Refused for a reason other than a moved branch (a failing hook, branch protection). Not retried. */
  | { kind: 'refused'; branch: string; output: string; attempts: number }
  /** The work cannot be pushed without a person or the worker: see `reason`. Not a dispatch failure. */
  | { kind: 'not-ready'; branch: string; reason: string }
  /** The branch kept moving, or moved in a way that cannot be replayed. The push failed for good. */
  | { kind: 'failed'; branch: string; reason: string; output: string; movedHead?: string; attempts: number };

export interface PushOptions {
  cwd: string;
  /** The PR's head branch (without refs/heads/). */
  branch: string;
  remote?: string;
  /** How many times a push rejected because the branch moved is retried. */
  retries: number;
  /**
   * The remote head the work started from, used when the checkout has no
   * remote-tracking ref for `branch`. The first push leases on the
   * remote-tracking ref (the head the worker last fetched), else on this.
   */
  baseHead?: string;
  /** Test seam: runs before each push attempt (1-based). */
  beforeAttempt?: (attempt: number) => void;
}

interface Run {
  ok: boolean;
  out: string;
}

/**
 * A push rejected because the remote branch is not where the push expected
 * it: non-fast-forward, fetch first, or a stale lease. A push hook's own
 * failure and a remote hook's refusal (`[remote rejected]`) are not.
 */
export function isMovedHeadRejection(output: string): boolean {
  return /!\s*\[rejected\][^\n]*\((?:non-fast-forward|fetch first|stale info)\)/.test(output);
}

export function pushPrBranch(opts: PushOptions): PushResult {
  const { cwd, branch } = opts;
  const remote = opts.remote ?? 'origin';
  const retries = Number.isFinite(opts.retries) && opts.retries >= 0 ? Math.floor(opts.retries) : 3;
  const git = (...args: string[]): Run => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}`.trim();
    return { ok: r.status === 0 && !r.error, out };
  };
  const sha = (ref: string): string | undefined => {
    const r = git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    return r.ok && r.out ? r.out.split('\n')[0]!.trim() : undefined;
  };
  const isAncestor = (a: string, b: string) => git('merge-base', '--is-ancestor', a, b).ok;
  const tracking = `refs/remotes/${remote}/${branch}`;
  const fetch = (): Run => git('fetch', '--no-tags', remote, `+refs/heads/${branch}:${tracking}`);

  if (!branch || branch.startsWith('-')) return { kind: 'not-ready', branch, reason: 'no PR head branch to push to' };
  const dirty = git('status', '--porcelain', '--untracked-files=no');
  if (!dirty.ok) return { kind: 'not-ready', branch, reason: dirty.out || 'not a git checkout' };
  if (dirty.out) return { kind: 'not-ready', branch, reason: 'uncommitted changes; commit them, then push again' };

  let lease = sha(tracking) ?? (opts.baseHead ? sha(opts.baseHead) : undefined);
  if (!lease) {
    const f = fetch();
    lease = f.ok ? sha(tracking) : undefined;
    if (!lease) return { kind: 'not-ready', branch, reason: `${remote} has no branch ${branch}; lobstah does not create one` };
  }

  let last = '';
  for (let attempt = 1; ; attempt++) {
    opts.beforeAttempt?.(attempt);
    const push = git('push', `--force-with-lease=refs/heads/${branch}:${lease}`, remote, `HEAD:refs/heads/${branch}`);
    if (push.ok) return { kind: 'pushed', branch, head: sha('HEAD') ?? '', attempts: attempt };
    last = push.out;
    if (!isMovedHeadRejection(push.out)) return { kind: 'refused', branch, output: push.out, attempts: attempt };

    const f = fetch();
    const moved = f.ok ? sha(tracking) : undefined;
    const fail = (reason: string): PushResult => ({ kind: 'failed', branch, reason, output: last, movedHead: moved, attempts: attempt });
    if (attempt > retries) return fail(`the branch moved on every push (${attempt} attempts)`);
    if (!moved) return fail(`could not fetch ${branch} after the rejection: ${f.out}`);
    if (moved !== lease) {
      if (!isAncestor(lease, moved)) return fail(`${branch} was rewritten on ${remote}; the work cannot be replayed safely`);
      const replayed = replay(git, sha, isAncestor, lease, moved);
      if (replayed) return fail(replayed);
    }
    lease = moved;
  }
}

/**
 * Bring the moved head's commits and the work together, so the next push
 * loses nothing that is on the remote. Returns why it could not, or undefined.
 *
 * When the work builds on the old head (new commits on top), the work is
 * replayed onto the moved head. When the work rewrote the branch (a rebase),
 * the commits that moved the head, and that the work does not already
 * contain, are replayed onto the work.
 */
function replay(
  git: (...args: string[]) => Run,
  sha: (ref: string) => string | undefined,
  isAncestor: (a: string, b: string) => boolean,
  lease: string,
  moved: string,
): string | undefined {
  const head = sha('HEAD');
  if (!head) return 'HEAD cannot be read';
  if (isAncestor(lease, head)) {
    const r = git('rebase', '--rebase-merges', '--onto', moved, lease);
    if (!r.ok) {
      git('rebase', '--abort');
      return `replaying the work onto ${moved.slice(0, 12)} stopped: ${firstLine(r.out)}`;
    }
    return undefined;
  }
  const list = git('rev-list', '--reverse', '--no-merges', moved, `^${lease}`, `^${head}`);
  if (!list.ok) return `the commits that moved the branch cannot be listed: ${firstLine(list.out)}`;
  for (const commit of list.out.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const pick = git('cherry-pick', commit);
    if (pick.ok) continue;
    // A commit whose change the work already holds picks as empty: skip it.
    const unmerged = git('diff', '--name-only', '--diff-filter=U');
    if (unmerged.ok && !unmerged.out && git('diff', '--cached', '--quiet').ok && git('cherry-pick', '--skip').ok) continue;
    git('cherry-pick', '--abort');
    git('reset', '--quiet', '--hard', head);
    return `replaying ${commit.slice(0, 12)} from the moved branch stopped: ${firstLine(pick.out)}`;
  }
  return undefined;
}

function firstLine(s: string): string {
  const line = s.split('\n').map((l) => l.trim()).find((l) => /error|conflict|fatal/i.test(l)) ?? s.split('\n')[0] ?? '';
  return line.slice(0, 240);
}

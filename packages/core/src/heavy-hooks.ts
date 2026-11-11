import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import * as path from 'node:path';
import { heavyDir } from './heavy.js';
import { atomicRenameSync, uniqueTempPath } from './paths.js';

/**
 * Pushes queue with no change to how they're run: a lobstah worktree's
 * `core.hooksPath` points at a small shim that takes a slot, then runs the
 * repo's real hook unchanged. Other hooks go straight through.
 *
 * Hooks that run on the receiving side are left out. `push-to-checkout` and
 * `proc-receive` change what git does just by existing.
 */
const HOOK_NAMES = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg',
  'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate',
  'reference-transaction', 'post-index-change',
] as const;

const SHIM_FILE = '.shim';

const SHIM = `#!/bin/sh
# lobstah's git hook shim. Runs the repo's own hook; an agent's pre-push in a
# lobstah worktree takes a slot in the heavy line first. Written by lobstah.
name=$(basename "$0")
here=$(cd "$(dirname "$0")" && pwd -P)
real_dir=$(git config --type=path --local core.hooksPath 2>/dev/null)
[ -n "$real_dir" ] || real_dir="$(git rev-parse --git-common-dir)/hooks"
[ "$(cd "$real_dir" 2>/dev/null && pwd -P)" != "$here" ] || exit 0
real="$real_dir/$name"
[ -x "$real" ] || exit 0
[ "$name" = pre-push ] || exec "$real" "$@"
[ -z "$LOBSTAH_HEAVY_TICKET" ] || exec "$real" "$@"
[ -n "$CODEX_SESSION_ID$CODEX_THREAD_ID$CLAUDECODE$CLAUDE_CODE_SESSION_ID$OPENCLAW_SHELL" ] || exec "$real" "$@"
top=$(git rev-parse --show-toplevel 2>/dev/null)
dir=$(git rev-parse --absolute-git-dir 2>/dev/null)
[ -f "$top/.lobstah-trap" ] || [ -f "$dir/lobstah.lock" ] || exec "$real" "$@"
if lobstah __heavy-push --probe </dev/null >/dev/null 2>&1; then
  exec lobstah __heavy-push -- "$real" "$@"
fi
echo "heavy: running without a slot: the lobstah command isn't available" >&2
exec "$real" "$@"
`;

export const heavyHooksDir = (): string => path.join(heavyDir(), 'hooks');

/** Write the shim and its one link per hook name. Rewrites only what changed. */
export function ensureHeavyHooks(): string {
  const dir = heavyHooksDir();
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, SHIM_FILE);
  let current: string | undefined;
  try {
    current = fs.readFileSync(shim, 'utf8');
  } catch {
    /* not written yet */
  }
  if (current !== SHIM) {
    const tmp = uniqueTempPath(shim);
    fs.writeFileSync(tmp, SHIM, { mode: 0o755 });
    atomicRenameSync(tmp, shim);
  }
  for (const name of HOOK_NAMES) {
    const link = path.join(dir, name);
    try {
      if (fs.readlinkSync(link) === SHIM_FILE) continue;
      fs.rmSync(link, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') fs.rmSync(link, { force: true });
    }
    try {
      fs.symlinkSync(SHIM_FILE, link);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; // another worktree linked it first
    }
  }
  return dir;
}

/**
 * Point a linked worktree's hooks at the shim. The main checkout and a hooks
 * path someone set for this worktree are left alone. Never throws: a worktree
 * that can't be set up still works, its pushes just aren't queued.
 */
export function applyHeavyHooks(worktree: string): boolean {
  if (process.platform === 'win32') return false;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).trim();
  const read = (...args: string[]): string | undefined => {
    try {
      return git(...args) || undefined;
    } catch {
      return undefined; // `git config` exits 1 for a key that isn't set
    }
  };
  try {
    if (git('rev-parse', '--absolute-git-dir') === path.resolve(worktree, git('rev-parse', '--git-common-dir'))) return false;
    if (read('config', '--local', '--bool', 'extensions.worktreeConfig') !== 'true') {
      // Git requires these to move before per-worktree config is turned on.
      if (read('config', '--local', '--bool', 'core.bare') === 'true' || read('config', '--local', 'core.worktree')) return false;
      git('config', '--local', 'extensions.worktreeConfig', 'true');
    }
    const hooks = ensureHeavyHooks();
    const current = read('config', '--worktree', 'core.hooksPath');
    if (current === hooks) return true;
    if (current) return false;
    git('config', '--worktree', 'core.hooksPath', hooks);
    return true;
  } catch {
    return false;
  }
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { RepoConfig } from '@lobstah/core';

function git(dir: string, ...args: string[]): string | undefined {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : undefined;
}

/** Canonical form for path identity checks (symlinks, 8.3 names, case). */
function canon(p: string): string {
  try {
    const real = path.resolve(fs.realpathSync.native(p));
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    return path.resolve(p);
  }
}

export interface SoakSite {
  /** Canonical toplevel of the checkout the session sits in. */
  worktree: string;
  /** True when this checkout is the repo's primary — never claimable. */
  primary: boolean;
  /** Config repo key whose primary checkout this worktree belongs to. */
  repoKey?: string;
}

/**
 * Where a would-be soaking session sits: which checkout, whether it is the
 * primary one, and which configured repo it belongs to. A linked worktree's
 * own toplevel differs from the configured repo path, so ownership resolves
 * through the shared git dir (`--git-common-dir` lives under the primary).
 */
export function inspectSoakSite(cwd: string, repos: Record<string, RepoConfig>): SoakSite | undefined {
  const top = git(cwd, 'rev-parse', '--show-toplevel');
  if (!top) return undefined;
  const gitDir = git(cwd, 'rev-parse', '--git-dir');
  const commonDir = git(cwd, 'rev-parse', '--git-common-dir');
  if (!gitDir || !commonDir) return undefined;
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(cwd, p));
  const primary = canon(abs(gitDir)) === canon(abs(commonDir));
  const primaryRoot = canon(path.dirname(abs(commonDir)));
  const repoKey = Object.entries(repos).find(([, r]) => canon(r.path) === primaryRoot)?.[0];
  return { worktree: canon(top), primary, repoKey };
}

export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
}

/**
 * The JSON a harness hook pipes on stdin (Claude Code and Codex share the
 * shape). Undefined at a TTY or when stdin carries anything else — a human
 * running the command by hand must never hang on a read.
 */
export function readHookStdin(): HookInput | undefined {
  if (process.stdin.isTTY) return undefined;
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return undefined;
    const parsed = JSON.parse(raw) as HookInput;
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

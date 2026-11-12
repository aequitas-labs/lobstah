import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicRenameSync, lobstahHome, uniqueTempPath } from '@lobstah/core';
import { LOBSTAH_HOOKS } from './hook-runs.js';

/**
 * A lobstah hook fails open. A harness reads a hook's exit 2 as "block": a
 * Stop hook that exits 2 on a flag this CLI doesn't know sends the session
 * straight back to work, every turn, which is how a stale plugin wedged ume
 * traps. So `lobstah hook …` exits 0 on any error, records it here, and
 * `lobstah doctor` shows it.
 */

/** The `lobstah hook` subverbs, as the plugins name them, and their harness events. */
export const HOOK_SUBVERBS: Record<string, string> = {
  'session-start': 'SessionStart',
  'user-prompt-submit': 'UserPromptSubmit',
  stop: 'Stop',
  'post-tool-use': 'PostToolUse',
  'session-end': 'SessionEnd',
  'permission-request': 'PermissionRequest',
  'pre-tool-use': 'PreToolUse',
  'grant-check': 'PreToolUse',
  'permission-denied': 'PermissionDenied',
};

/** The older hook commands installed plugins still run, by event. */
const LEGACY_HOOK_COMMANDS: Record<string, readonly string[]> = {
  SessionStart: ['man brief'],
  Stop: ['man haul'],
  SessionEnd: ['stow --quiet', 'stow'],
  PostToolUse: ['soak beat'],
};

/** Extra words a hook command may carry after its subverb: the harness, for the grant hooks. */
const HOOK_ARGS = new Set(['claude', 'codex']);

/**
 * Whether `command` is a lobstah hook this CLI runs for `event`:
 * `lobstah hook <subverb> [claude|codex]` with that event's subverb, or one
 * of the older commands. A command for another program is not lobstah's to
 * judge and passes.
 */
export function knownHookCommand(event: string, command: string): boolean {
  const words = command.trim().split(/\s+/);
  if (words[0] !== 'lobstah') return true;
  const rest = words.slice(1);
  if (rest[0] === 'hook') {
    const sub = rest[1];
    return sub !== undefined && HOOK_SUBVERBS[sub] === event && rest.slice(2).every((w) => HOOK_ARGS.has(w));
  }
  return (LEGACY_HOOK_COMMANDS[event] ?? []).includes(rest.join(' '));
}

export const hookFailuresPath = (): string => path.join(lobstahHome(), 'hook-failures.json');

export interface HookFailure {
  at: string;
  /** The command line after `lobstah`. */
  command: string;
  error: string;
}

/** The last failure of each hook, keyed by its harness event. */
export function readHookFailures(): Record<string, HookFailure> {
  try {
    const parsed = JSON.parse(fs.readFileSync(hookFailuresPath(), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, HookFailure>) : {};
  } catch {
    return {};
  }
}

/** Record one failed `lobstah hook` run under its event (`hook` for an unknown subverb). Never throws. */
export function recordHookFailure(args: readonly string[], error: string, now = Date.now()): void {
  try {
    const key = HOOK_SUBVERBS[args[0] ?? ''] ?? 'hook';
    const failures = readHookFailures();
    failures[key] = { at: new Date(now).toISOString(), command: ['hook', ...args].join(' '), error };
    const file = hookFailuresPath();
    const tmp = uniqueTempPath(file);
    fs.writeFileSync(tmp, JSON.stringify(failures, null, 2));
    atomicRenameSync(tmp, file);
  } catch {
    // A hook never fails over its own bookkeeping.
  }
}

/** A failure of a hook whose runs aren't recorded stays on show this long. */
const UNTRACKED_FAILURE_MS = 24 * 3600_000;

/**
 * The failure doctor shows for a hook: one newer than the hook's last
 * recorded run. Only lobstah's four hooks record runs; another hook's failure
 * shows for a day.
 */
export function failureSince(failures: Record<string, HookFailure>, hook: string, lastRun: string | undefined, now = Date.now()): HookFailure | undefined {
  const f = failures[hook];
  if (!f) return undefined;
  if (lastRun) return Date.parse(lastRun) > Date.parse(f.at) ? undefined : f;
  return (LOBSTAH_HOOKS as readonly string[]).includes(hook) || now - Date.parse(f.at) < UNTRACKED_FAILURE_MS ? f : undefined;
}

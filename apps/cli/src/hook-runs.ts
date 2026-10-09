import * as fs from 'node:fs';
import * as path from 'node:path';
import { uniqueTempPath, lobstahHome } from '@lobstah/core';

/** The hooks lobstah's plugins declare, by the harness event name. */
export const LOBSTAH_HOOKS = ['Stop', 'SessionStart', 'PostToolUse', 'SessionEnd'] as const;
export type LobstahHook = (typeof LOBSTAH_HOOKS)[number];

/** A hook that runs on every tool call records at most this often. */
const RECORD_EVERY_MS = 30_000;

export const hookRunsPath = (): string => path.join(lobstahHome(), 'hook-runs.json');

/** The last run of each hook, keyed `<harness>:<event>` (harness `unknown` when undecidable). ISO times. */
export function readHookRuns(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(hookRunsPath(), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Stamp one hook run. Only lobstah's four events count; a run within
 * RECORD_EVERY_MS of the last one for the same key writes nothing. Never throws.
 */
export function recordHookRun(event: string | undefined, harness: string | undefined, now = Date.now()): void {
  try {
    if (!event || !(LOBSTAH_HOOKS as readonly string[]).includes(event)) return;
    const key = `${harness ?? 'unknown'}:${event}`;
    const runs = readHookRuns();
    if (now - (Date.parse(runs[key] ?? '') || 0) < RECORD_EVERY_MS) return;
    runs[key] = new Date(now).toISOString();
    const file = hookRunsPath();
    const tmp = uniqueTempPath(file);
    fs.writeFileSync(tmp, JSON.stringify(runs, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // A hook never fails over its own bookkeeping.
  }
}

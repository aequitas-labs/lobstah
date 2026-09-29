import * as fs from 'node:fs';
import * as path from 'node:path';
import { beatTrap, loadConfig, lobstahHome, readTrap, trapBySession, trapIdAbove } from '@lobstah/core';
import type { BeatResult } from '@lobstah/core';
import { probeTrapPr } from './beat-pr.js';
import type { ProbeRun } from './beat-pr.js';
import { readHookStdin } from './soak-site.js';

/** The post-tool hook's stdin: Claude Code and Codex share these fields. */
export interface PostToolHookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
}

/** Errors go here, never to the tool call. */
function logError(err: unknown): void {
  try {
    const dir = path.join(lobstahHome(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const msg = err instanceof Error ? err.message : String(err);
    fs.appendFileSync(path.join(dir, 'beat.log'), `${new Date().toISOString()} ${msg.replace(/\s+/g, ' ').slice(0, 300)}\n`);
  } catch {
    // nowhere left to say it
  }
}

/** The PR lookup for the trap this hook call belongs to. Errors are logged, never thrown. */
function probePr(input: PostToolHookInput | undefined, opts: { now?: number; run?: ProbeRun }): void {
  try {
    const cwd = input?.cwd ?? process.cwd();
    const trapId = trapIdAbove(cwd) ?? (input?.session_id ? trapBySession(input.session_id)?.trapId : undefined);
    const reg = trapId !== undefined ? readTrap(trapId) : undefined;
    if (!reg || (input?.session_id && input.session_id !== reg.sessionId)) return;
    probeTrapPr(reg, opts);
  } catch (err) {
    logError(err);
  }
}

/**
 * `lobstah soak beat`: the post-tool hook. Refreshes the trap's liveness,
 * writes its catch's activity, and records the catch's PR once its branch
 * has one. It never fails the tool call: every path returns normally and
 * prints nothing, and errors go to logs/beat.log.
 */
export function runBeat(
  input: PostToolHookInput | undefined = readHookStdin() as PostToolHookInput | undefined,
  opts: { now?: number; run?: ProbeRun } = {},
): BeatResult | undefined {
  try {
    if (!loadConfig().soak.beat) return undefined;
    const result = beatTrap({
      cwd: input?.cwd ?? process.cwd(),
      sessionId: input?.session_id,
      toolName: input?.tool_name,
      toolInput: input?.tool_input,
      now: opts.now,
    });
    probePr(input, opts);
    return result;
  } catch (err) {
    logError(err);
    return undefined;
  }
}
